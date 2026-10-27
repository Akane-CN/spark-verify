import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalSha256, sha256Bytes } from "./canonical";
import { loadManifest } from "./manifest";
import type { OffckbRunContext, OffckbPaths } from "./offckb";
import { OffckbDevnet } from "./offckb";
import { runCommand, runProcess, type CommandResult, type RunCommandOptions } from "./process";
import {
  buildEvidenceDigests,
  buildOutcomeClaims,
  verdictForOutcomeClaims,
  verifyEvidenceDigests,
  type EnvironmentEvidence,
  type RunEvidence,
  type ClaimEvidence,
  type RejectionEvidence,
} from "./report";
import {
  loadResultEnvelope,
  rpcCall,
  waitForTransaction,
  RpcError,
  type CkbJsonRpcTransaction,
} from "./rpc";
import {
  normalizeScript,
  parseDebuggerResult,
  parseRejection,
  parseRpcCycles,
  scriptHash,
  transactionHash,
} from "./transaction";
import type { CellAssertion, Manifest } from "./types";
import { VERSION } from "./version";

export type Verdict = "PASS" | "FAIL" | "ERROR";

export type StepCommandRunner = (command: string, options: RunCommandOptions) => Promise<CommandResult>;
export type RunnerRpcCaller = (url: string, method: string, params?: unknown[], signal?: AbortSignal) => Promise<unknown>;

export interface DevnetAdapter {
  paths: Pick<OffckbPaths, "transactionsPath" | "fullTransactionsPath">;
  start(): Promise<OffckbRunContext>;
  installDebugger(): Promise<void>;
  debuggerVersion(): Promise<string>;
  debugScript(
    txHash: string,
    source: { cell: "input" | "output"; index: number; role: "lock" | "type" },
  ): Promise<CommandResult>;
  stop(): Promise<void>;
}

export interface CkbVerifyReport {
  schema: "ckb-verify-report/1";
  verdict: Verdict;
  createdAt: string;
  evidence: RunEvidence;
  outcomeClaims: ReturnType<typeof buildOutcomeClaims>;
  environment: EnvironmentEvidence;
  digests: ReturnType<typeof buildEvidenceDigests>;
}

export interface RunManifestOptions {
  manifestPath: string;
  projectRoot?: string;
  outputDir?: string;
  devnet?: DevnetAdapter;
  runStep?: StepCommandRunner;
  rpc?: RunnerRpcCaller;
  signal?: AbortSignal;
}

export interface RunManifestResult {
  verdict: Verdict;
  reportPath: string;
  report: CkbVerifyReport;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized === "" ? "run" : normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("run interrupted");
}

async function readSecrets(path: string): Promise<string[]> {
  const value = JSON.parse(await readFile(path, "utf8")) as { accounts?: Array<{ privkey?: unknown }> };
  const keys = (value.accounts ?? []).flatMap((account) =>
    typeof account.privkey === "string" ? [account.privkey] : [],
  );
  return [
    ...new Set(
      keys.flatMap((key) => {
        const unprefixed = key.startsWith("0x") ? key.slice(2) : key;
        return [key, key.toUpperCase(), unprefixed, unprefixed.toUpperCase()];
      }),
    ),
  ].sort((left, right) => right.length - left.length);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => result.replace(new RegExp(regexEscape(secret), "gi"), "[REDACTED]"),
    text,
  );
}

function outputDirectory(root: string, manifest: Manifest): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(root, ".ckb-verify", "runs", `${timestamp}-${process.pid}-${slug(manifest.meta.name)}`);
}

export interface SourceRevision {
  gitCommit: string | null;
  dirty: boolean | null;
  dirtyDigest: string | null;
}

export async function collectSourceRevision(projectRoot: string): Promise<SourceRevision> {
  try {
    const commit = await runProcess(["git", "rev-parse", "--verify", "HEAD"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    if (commit.timedOut || commit.exitCode !== 0) return { gitCommit: null, dirty: null, dirtyDigest: null };
    const gitCommit = commit.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(gitCommit)) return { gitCommit: null, dirty: null, dirtyDigest: null };
    const status = await runProcess(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    if (status.timedOut || status.exitCode !== 0) return { gitCommit, dirty: null, dirtyDigest: null };
    if (status.stdout.trim() === "") return { gitCommit, dirty: false, dirtyDigest: null };

    const [diff, untracked] = await Promise.all([
      runProcess(["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
        cwd: projectRoot,
        timeoutMs: 10_000,
      }),
      runProcess(["git", "ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: projectRoot,
        timeoutMs: 10_000,
      }),
    ]);
    if (diff.timedOut || diff.exitCode !== 0 || untracked.timedOut || untracked.exitCode !== 0) {
      return { gitCommit, dirty: true, dirtyDigest: null };
    }
    const untrackedEntries = await Promise.all(
      untracked.stdout
        .split("\0")
        .filter((path) => path !== "")
        .sort()
        .map(async (path) => {
          const absolutePath = resolve(projectRoot, path);
          const metadata = await lstat(absolutePath);
          const symlink = metadata.isSymbolicLink();
          const bytes = symlink ? Buffer.from(await readlink(absolutePath), "utf8") : await readFile(absolutePath);
          const mode = symlink ? "120000" : (metadata.mode & 0o111) === 0 ? "100644" : "100755";
          return { path, kind: symlink ? "symlink" : "file", mode, digest: sha256Bytes(bytes) };
        }),
    );
    return {
      gitCommit,
      dirty: true,
      dirtyDigest: canonicalSha256({ status: status.stdout, trackedDiff: diff.stdout, untracked: untrackedEntries }),
    };
  } catch {
    return { gitCommit: null, dirty: null, dirtyDigest: null };
  }
}

function environmentEvidence(
  manifest: Manifest,
  manifestBytes: Uint8Array,
  context: OffckbRunContext,
  sourceRevision: SourceRevision,
  observedDebuggerVersion?: string,
): EnvironmentEvidence {
  return {
    schema: "ckb-verify-environment/1",
    runnerVersion: VERSION,
    requestedToolchain: manifest.toolchain,
    observedToolchain: {
      bun: Bun.version,
      ckb: context.ckbVersion,
      offckb: context.offckbVersion,
      ...(observedDebuggerVersion === undefined ? {} : { ckbDebugger: observedDebuggerVersion }),
    },
    manifestSha256: sha256Bytes(manifestBytes),
    sourceRevision,
    platform: { os: process.platform, arch: process.arch },
    genesisHash: context.genesisHash,
    systemScripts: context.systemScripts,
  };
}

async function evaluateCell(
  assertion: CellAssertion,
  transactionHashes: ReadonlyMap<string, string>,
  transactionOutputCounts: ReadonlyMap<string, number>,
  rpcUrl: string,
  rpc: RunnerRpcCaller,
  signal?: AbortSignal,
): Promise<ClaimEvidence> {
  const txHash = transactionHashes.get(assertion.outPoint.step);
  if (txHash === undefined) throw new Error(`assertion references step ${assertion.outPoint.step} without a transaction`);
  const transactionOutputCount = transactionOutputCounts.get(assertion.outPoint.step);
  if (transactionOutputCount === undefined) {
    throw new Error(`assertion references step ${assertion.outPoint.step} without recorded transaction outputs`);
  }
  if (assertion.outPoint.index >= transactionOutputCount) {
    return {
      kind: "cell",
      target: assertion.outPoint,
      expected: { count: assertion.count },
      observed: { count: 0 },
      ok: false,
      evidence: { reason: "output-index-out-of-range", transactionOutputCount },
    };
  }
  const outPoint = { tx_hash: txHash, index: `0x${assertion.outPoint.index.toString(16)}` };
  const result = await rpc(rpcUrl, "get_live_cell", [outPoint, true], signal);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("get_live_cell result must be an object");
  }
  const record = result as Record<string, unknown>;
  let count: number;
  if (record.status === "live") {
    if (record.cell === null || typeof record.cell !== "object" || Array.isArray(record.cell)) {
      throw new Error("get_live_cell live result must include cell.output");
    }
    const cell = record.cell as Record<string, unknown>;
    if (cell.output === null || typeof cell.output !== "object" || Array.isArray(cell.output)) {
      throw new Error("get_live_cell live result must include cell.output");
    }
    count = 1;
  } else if (record.status === "dead" || record.status === "unknown") {
    count = 0;
  } else {
    throw new Error("get_live_cell status must be live, dead, or unknown");
  }
  return {
    kind: "cell",
    target: assertion.outPoint,
    expected: { count: assertion.count },
    observed: { count },
    ok: count === assertion.count,
    evidence: { resolvedOutPoint: outPoint, response: result },
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function resolveRejectedScript(
  rejection: RejectionEvidence,
  transaction: CkbJsonRpcTransaction,
  rpcUrl: string,
  rpc: RunnerRpcCaller,
  signal?: AbortSignal,
): Promise<{ rejection: RejectionEvidence; evidence: unknown }> {
  if (rejection.source === undefined || rejection.role === undefined) {
    throw new Error("script rejection is missing its source or role");
  }

  let output: Record<string, unknown>;
  let sourceEvidence: unknown;
  if (rejection.source.cell === "input") {
    const input = requireRecord(transaction.inputs[rejection.source.index], `transaction.inputs[${rejection.source.index}]`);
    const outPoint = requireRecord(input.previous_output, `transaction.inputs[${rejection.source.index}].previous_output`);
    const response = await rpc(rpcUrl, "get_live_cell", [outPoint, true], signal);
    const responseRecord = requireRecord(response, "get_live_cell result");
    if (responseRecord.status !== "live") {
      throw new Error(`rejected input ${rejection.source.index} is not a live Cell`);
    }
    const cell = requireRecord(responseRecord.cell, "get_live_cell result.cell");
    output = requireRecord(cell.output, "get_live_cell result.cell.output");
    sourceEvidence = { outPoint, response };
  } else {
    output = requireRecord(transaction.outputs[rejection.source.index], `transaction.outputs[${rejection.source.index}]`);
    sourceEvidence = { output };
  }

  const script = normalizeScript(output[rejection.role]);
  return {
    rejection: { ...rejection, script, scriptHash: scriptHash(script) },
    evidence: { source: rejection.source, role: rejection.role, script, scriptHash: scriptHash(script), sourceEvidence },
  };
}


async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  try {
    await access(source);
  } catch {
    return;
  }
  await copyFile(source, destination);
}

async function scanEvidenceForSecrets(root: string, secrets: readonly string[]): Promise<void> {
  if (secrets.length === 0) return;
  const leaked: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) {
        await rm(path, { force: true, recursive: entry.isDirectory() });
        throw new Error(`evidence contains an unsupported filesystem entry: ${relative(root, path)}`);
      }
      const text = await readFile(path, "utf8");
      const redacted = redact(text, secrets);
      if (redacted === text) continue;
      await writeFile(path, redacted);
      leaked.push(relative(root, path));
    }
  }
  if (leaked.length > 0) {
    throw new Error(`evidence contained an OffCKB development private key; redacted: ${leaked.join(", ")}`);
  }
}

export async function runManifest(options: RunManifestOptions): Promise<RunManifestResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const manifestPath = resolve(projectRoot, options.manifestPath);
  const { manifest, bytes: manifestBytes } = await loadManifest(manifestPath);
  const sourceRevision = await collectSourceRevision(projectRoot);
  const outputDir = resolve(options.outputDir ?? outputDirectory(projectRoot, manifest));
  const reportPath = join(outputDir, "report.json");
  const pendingReportPath = join(outputDir, ".report.json.pending");
  const runStep = options.runStep ?? runCommand;
  const rpc: RunnerRpcCaller =
    options.rpc ??
    ((url, method, params = [], signal) => rpcCall(url, method, params, fetch, 30_000, signal));
  const devnet =
    options.devnet ??
    new OffckbDevnet({
      repositoryRoot: projectRoot,
      ckbVersion: manifest.toolchain.ckb,
      accountCount: manifest.setup.accounts,
    });

  await mkdir(join(outputDir, "steps"), { recursive: true });
  await rm(reportPath, { force: true });
  await rm(pendingReportPath, { force: true });
  await writeFile(join(outputDir, "manifest.toml"), manifestBytes);

  let context: OffckbRunContext | undefined;
  let observedDebuggerVersion: string | undefined;
  let secrets: string[] = [];
  let primaryError: unknown;
  let reportToPublish: RunManifestResult | undefined;
  try {
    throwIfAborted(options.signal);
    context = await devnet.start();
    throwIfAborted(options.signal);
    if (manifest.toolchain.ckbDebugger !== undefined) {
      await devnet.installDebugger();
      observedDebuggerVersion = await devnet.debuggerVersion();
      const requested = manifest.toolchain.ckbDebugger.replaceAll(".", "\\.");
      if (!new RegExp(`(?:^|\\s)${requested}(?:$|\\s)`).test(observedDebuggerVersion)) {
        throw new Error(
          `ckb-debugger version ${observedDebuggerVersion} does not match requested ${manifest.toolchain.ckbDebugger}`,
        );
      }
    }
    secrets = await readSecrets(context.accountsPath);
    const transactionHashes = new Map<string, string>();
    const transactionOutputCounts = new Map<string, number>();
    const steps: RunEvidence["steps"] = [];

    for (const [index, step] of manifest.steps.entries()) {
      throwIfAborted(options.signal);
      const stepDirectory = join(outputDir, "steps", `${String(index + 1).padStart(2, "0")}-${slug(step.name)}`);
      await mkdir(stepDirectory, { recursive: true });
      const resultPath = join(stepDirectory, "result.json");
      const commandResult = await runStep(step.run, {
        cwd: projectRoot,
        timeoutMs: step.timeoutMs,
        env: {
          CKB_VERIFY_RESULT: resultPath,
          CKB_VERIFY_RPC_URL: context.rpcUrl,
          CKB_VERIFY_ACCOUNTS: context.accountsPath,
          CKB_VERIFY_SYSTEM_SCRIPTS: context.systemScriptsPath,
          CKB_VERIFY_CONTEXT: context.contextPath,
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      throwIfAborted(options.signal);
      await writeFile(join(stepDirectory, "stdout.txt"), redact(commandResult.stdout, secrets));
      await writeFile(join(stepDirectory, "stderr.txt"), redact(commandResult.stderr, secrets));
      if (commandResult.timedOut || commandResult.exitCode !== 0) {
        throw new Error(
          `step ${step.name} ${commandResult.timedOut ? "timed out" : `exited ${String(commandResult.exitCode)}`}`,
        );
      }

      const envelope = await loadResultEnvelope(resultPath);
      const tx = envelope.transaction as CkbJsonRpcTransaction;
      const txHash = transactionHash(tx);
      transactionHashes.set(step.name, txHash);
      transactionOutputCounts.set(step.name, tx.outputs.length);
      await writeJson(join(stepDirectory, "transaction.json"), tx);

      let cycles: number | undefined;
      let observedStatus: "committed" | "rejected";
      let rejection: RejectionEvidence | undefined;
      try {
        const dryRun = parseRpcCycles(await rpc(context.rpcUrl, "test_tx_pool_accept", [tx], options.signal));
        cycles = dryRun.cycles;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        await writeJson(join(stepDirectory, "test-tx-pool-error.json"), {
          code: error.code,
          message: error.message,
          data: error.data,
        });
      }

      try {
        const submittedHash = await rpc(context.proxyUrl, "send_transaction", [tx], options.signal);
        if (submittedHash !== txHash) {
          throw new Error(`send_transaction returned ${String(submittedHash)} instead of computed ${txHash}`);
        }
        const terminal = await waitForTransaction(context.rpcUrl, txHash, {
          call: (url, method, params, signal) => rpc(url, method, params, signal),
          intervalMs: 100,
          timeoutMs: 60_000,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        observedStatus = terminal.status;
        if (terminal.status === "rejected") {
          rejection = {
            kind: "node",
            ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
          };
        }
        const transactionRecord = await rpc(context.rpcUrl, "get_transaction", [txHash], options.signal);
        await writeJson(join(stepDirectory, "get-transaction.json"), transactionRecord);
      } catch (error) {
        if (!(error instanceof RpcError) || error.method !== "send_transaction") throw error;
        const parsedRejection = parseRejection(error);
        if (
          parsedRejection.kind !== "script" ||
          parsedRejection.code === undefined ||
          parsedRejection.source === undefined ||
          parsedRejection.role === undefined
        ) {
          throw new Error(`send_transaction failed without a recognized script rejection (RPC ${error.code})`, {
            cause: error,
          });
        }
        observedStatus = "rejected";
        const debugSource = parsedRejection.source;
        const debugRole = parsedRejection.role;
        rejection = parsedRejection;
        await writeJson(join(stepDirectory, "rpc-error.json"), {
          code: error.code,
          message: error.message,
          data: error.data,
        });
        const resolvedScript = await resolveRejectedScript(rejection, tx, context.rpcUrl, rpc, options.signal);
        rejection = resolvedScript.rejection;
        await writeJson(join(stepDirectory, "script-group.json"), resolvedScript.evidence);
        if (observedDebuggerVersion === undefined) {
          await devnet.installDebugger();
          observedDebuggerVersion = await devnet.debuggerVersion();
        }
        const debug = await devnet.debugScript(txHash, { ...debugSource, role: debugRole });
        const debuggerOutput = redact(`${debug.stdout}${debug.stderr === "" ? "" : `\n${debug.stderr}`}`, secrets);
        await writeFile(join(stepDirectory, "debugger.txt"), debuggerOutput);
        const debuggerResult = parseDebuggerResult(debuggerOutput);
        if (debuggerResult.result !== rejection.code) {
          throw new Error(`ckb-debugger result ${debuggerResult.result} does not match RPC script code ${rejection.code}`);
        }
        cycles = debuggerResult.cycles;
        await copyIfExists(
          join(devnet.paths.fullTransactionsPath, `${txHash}.json`),
          join(stepDirectory, "debug-full-transaction.json"),
        );
      }
      await copyIfExists(
        join(devnet.paths.transactionsPath, `${txHash}.json`),
        join(stepDirectory, "proxy-transaction.json"),
      );

      const claims: ClaimEvidence[] = [];
      for (const assertion of step.assertions) {
        claims.push(await evaluateCell(assertion, transactionHashes, transactionOutputCounts, context.rpcUrl, rpc, options.signal));
      }
      steps.push({
        name: step.name,
        ...(step.expect === undefined ? {} : { expectedStatus: step.expect.tx }),
        ...(step.expect?.error?.code === undefined ? {} : { expectedErrorCode: step.expect.error.code }),
        observedStatus,
        ...(cycles === undefined ? {} : { cycles }),
        ...(rejection === undefined ? {} : { rejection }),
        transactionHash: txHash,
        durationMs: commandResult.durationMs,
        claims,
      });
    }

    const assertions: ClaimEvidence[] = [];
    for (const assertion of manifest.assertions) {
      assertions.push(await evaluateCell(assertion, transactionHashes, transactionOutputCounts, context.rpcUrl, rpc, options.signal));
    }
    const evidence: RunEvidence = {
      name: manifest.meta.name,
      spec: manifest.meta.spec,
      steps,
      assertions,
    };
    throwIfAborted(options.signal);
    const environment = environmentEvidence(
      manifest,
      manifestBytes,
      context,
      sourceRevision,
      observedDebuggerVersion,
    );
    const outcomeClaims = buildOutcomeClaims(evidence);
    const digests = buildEvidenceDigests(evidence, environment);
    const verdict = verdictForOutcomeClaims(outcomeClaims);
    const report: CkbVerifyReport = {
      schema: "ckb-verify-report/1",
      verdict,
      createdAt: new Date().toISOString(),
      evidence,
      outcomeClaims,
      environment,
      digests,
    };
    verifyEvidenceDigests(report);
    await writeJson(pendingReportPath, report);
    reportToPublish = { verdict, reportPath, report };
    return reportToPublish;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await scanEvidenceForSecrets(outputDir, secrets);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (context !== undefined) await devnet.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (primaryError !== undefined || cleanupErrors.length > 0) {
      for (const path of [pendingReportPath, reportPath]) {
        try {
          await rm(path, { force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      const errors = primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors];
      const message = errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
      throw new AggregateError(errors, message);
    }
    if (primaryError === undefined && reportToPublish !== undefined) {
      try {
        await rename(pendingReportPath, reportPath);
      } catch (error) {
        const publicationErrors: unknown[] = [error];
        try {
          await rm(pendingReportPath, { force: true });
        } catch (cleanupError) {
          publicationErrors.push(cleanupError);
        }
        throw new AggregateError(
          publicationErrors,
          publicationErrors.map((entry) => (entry instanceof Error ? entry.message : String(entry))).join("; "),
        );
      }
    }
  }
}
