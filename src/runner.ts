import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalSha256, sha256Bytes } from "./canonical";
import { loadManifest } from "./manifest";
import { resolvePinnedDebuggerAsset } from "./debugger-binary";
import type { OffckbRunContext, OffckbPaths, PreparedDebugger } from "./offckb";
import { OffckbDevnet } from "./offckb";
import { runCommand, runProcess, type CommandResult, type RunCommandOptions } from "./process";
import { collectProvenance, type SourceRevision } from "./provenance";
import {
  buildEvidenceDigests,
  buildOutcomeClaims,
  verdictForOutcomeClaims,
  verifyReport,
  type EnvironmentEvidence, type EnvironmentEvidenceV4,
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
import { isManifestV4, isManifestV5, type CellAssertion, type ClaimV4, type ClaimV5, type Manifest, type ManifestV3 } from "./types";
import {
  claimDefinitionV3, deriveOutcomeV3, expectedSearchKey, populateEvidenceV3, resolutionContextFromEnvironment, validateIndexerInput, verdictForOutcomeV3,
  type CellInputV3, type ClaimInputV3, type IndexerInput, type IndexerPage, type IndexerSearchKey, type OutcomeV3, type RunEvidenceV3, type RunInputV3,
} from "./claims-v3";
import { INDEXER_PAGE_LIMIT, MAX_SELECTED_CELLS } from "./limits";
import { claimDefinition, deriveOutcomeV2, populateEvidenceV2, validateLiveCellResponse, validateTransaction,
  verdictForOutcomeV2, type CellInput, type ClaimInputV2, type RunInputV2, type RunEvidenceV2, type OutcomeV2 } from "./cell-claims";
import { VERSION } from "./version";

export type Verdict = "PASS" | "FAIL" | "ERROR";

export type StepCommandRunner = (command: string, options: RunCommandOptions) => Promise<CommandResult>;
export type RunnerRpcCaller = (url: string, method: string, params?: unknown[], signal?: AbortSignal) => Promise<unknown>;

export interface DevnetAdapter {
  paths: Pick<OffckbPaths, "transactionsPath" | "fullTransactionsPath">;
  start(signal?: AbortSignal): Promise<OffckbRunContext>;
  prepareDebugger(version: string): Promise<PreparedDebugger>;
  debugScript(
    txHash: string,
    source: { cell: "input" | "output"; index: number; role: "lock" | "type" },
  ): Promise<CommandResult>;
  stop(): Promise<void>;
}

export interface CkbVerifyReportV1 {
  schema: "ckb-verify-report/1";
  verdict: Verdict;
  createdAt: string;
  evidence: RunEvidence;
  outcomeClaims: ReturnType<typeof buildOutcomeClaims>;
  environment: EnvironmentEvidence;
  digests: ReturnType<typeof buildEvidenceDigests>;
}

export interface CkbVerifyReportV2 extends Omit<CkbVerifyReportV1, "schema" | "evidence" | "outcomeClaims"> {
  schema: "ckb-verify-report/2";
  evidence: RunEvidenceV2;
  outcomeClaims: OutcomeV2;
}
export interface CkbVerifyReportV3 extends Omit<CkbVerifyReportV1, "schema" | "evidence" | "outcomeClaims" | "environment"> {
  schema: "ckb-verify-report/3";
  evidence: RunEvidenceV3;
  outcomeClaims: OutcomeV3;
  environment: EnvironmentEvidenceV4;
}
export type CkbVerifyReport = CkbVerifyReportV1 | CkbVerifyReportV2 | CkbVerifyReportV3;

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

function redactPreparationError(error: unknown, secrets: readonly string[]): Error {
  const message = redact(error instanceof Error ? error.message : String(error), secrets);
  if (error instanceof AggregateError) {
    return new AggregateError(error.errors.map(entry => redactPreparationError(entry, secrets)), message);
  }
  return new Error(message, error instanceof Error && error.cause !== undefined
    ? { cause: redactPreparationError(error.cause, secrets) } : undefined);
}

function outputDirectory(root: string, manifest: Manifest): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(root, ".ckb-verify", "runs", `${timestamp}-${process.pid}-${slug(manifest.meta.name)}`);
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

function sameSourceRevision(left: SourceRevision, right: SourceRevision): boolean {
  return (
    left.gitCommit === right.gitCommit &&
    left.dirty === right.dirty &&
    left.dirtyDigest === right.dirtyDigest
  );
}

async function environmentEvidence(
  projectRoot: string,
  manifest: Manifest,
  manifestBytes: Uint8Array,
  context: OffckbRunContext,
  sourceRevision: SourceRevision,
  preparedDebugger?: PreparedDebugger,
): Promise<EnvironmentEvidence | EnvironmentEvidenceV4> {
  const provenance = await collectProvenance({
    projectRoot,
    manifestBytes,
    replayDependencies: manifest.replay.dependencies,
    sourceRevision,
    ckbBinary: context.ckbBinary,
    ckbDebuggerBinary: preparedDebugger?.binary ?? null,
  });
  const base = {
    runner: { name: "ckb-verify" as const, version: VERSION },
    toolchain: {
      requested: manifest.toolchain,
      observed: {
        ckb: context.ckbVersion,
        offckb: context.offckbVersion,
        ...(preparedDebugger === undefined ? {} : { ckbDebugger: preparedDebugger.version }),
      },
    },
    provenance,
    platform: { os: process.platform, arch: process.arch },
    devnet: {
      network: context.network,
      genesisHash: context.genesisHash,
      systemScripts: context.systemScripts,
    },
  };
  if (isManifestV5(manifest)) {
    return { schema: "ckb-verify-environment/4", ...base, devnet: { ...base.devnet, accounts: context.accounts.slice(0, manifest.setup.accounts).map((a) => ({ index: a.index, address: a.address, lock: { ...a.lock } })) } };
  }
  return { schema: "ckb-verify-environment/3", ...base };
}

/** Pages an indexer `get_cells` query with the fixed page size; refuses more than MAX_SELECTED_CELLS. */
async function queryIndexer(searchKey: IndexerSearchKey, rpcUrl: string, rpc: RunnerRpcCaller, signal?: AbortSignal): Promise<IndexerInput> {
  const pages: IndexerPage[] = [];
  let afterCursor: string | null = null;
  let total = 0;
  for (;;) {
    const response = requireRecord(await rpc(rpcUrl, "get_cells", [searchKey, "asc", `0x${INDEXER_PAGE_LIMIT.toString(16)}`, afterCursor], signal), "get_cells result");
    if (!Array.isArray(response.objects) || typeof response.last_cursor !== "string") throw new Error("get_cells result must carry objects and last_cursor");
    pages.push({ after_cursor: afterCursor, response: { objects: response.objects as IndexerPage["response"]["objects"], last_cursor: response.last_cursor } });
    total += response.objects.length;
    if (total > MAX_SELECTED_CELLS) throw new Error(`indexer query selected more than ${MAX_SELECTED_CELLS} live Cells; narrow the selector`);
    if (response.objects.length < INDEXER_PAGE_LIMIT) break;
    afterCursor = response.last_cursor;
  }
  return validateIndexerInput({ kind: "indexer", search_key: searchKey, pages }, "get_cells");
}

async function collectClaimsV3(
  claims: ClaimV5[], transactions: ReadonlyMap<string, CkbJsonRpcTransaction>, hashes: ReadonlyMap<string, string>,
  environment: EnvironmentEvidenceV4, rpcUrl: string, rpc: RunnerRpcCaller, signal?: AbortSignal,
): Promise<ClaimInputV3[]> {
  const context = resolutionContextFromEnvironment(environment);
  const snapshots = new Map<string, CellInputV3 | IndexerInput>();
  const collected: ClaimInputV3[] = [];
  for (const claim of claims) {
    const definition = claimDefinitionV3(claim);
    if (definition.kind === "cell_deps") { collected.push(definition); continue; }
    if (definition.kind === "cell" && definition.target.outPoint !== undefined) {
      const key = JSON.stringify(definition.target.outPoint);
      let input = snapshots.get(key) as CellInputV3 | undefined;
      if (input === undefined) {
        const tx = transactions.get(definition.target.outPoint.step), hash = hashes.get(definition.target.outPoint.step);
        if (tx === undefined || hash === undefined) throw new Error("missing retained target transaction");
        if (definition.target.outPoint.index >= tx.outputs.length) input = { kind: "missing-output" };
        else {
          const outPoint = { tx_hash: hash, index: `0x${definition.target.outPoint.index.toString(16)}` };
          input = { kind: "query", outPoint, response: validateLiveCellResponse(await rpc(rpcUrl, "get_live_cell", [outPoint, true], signal)) };
        }
        snapshots.set(key, input);
      }
      collected.push({ ...definition, input });
      continue;
    }
    const searchKey = expectedSearchKey(definition, context);
    const key = JSON.stringify(searchKey);
    let input = snapshots.get(key) as IndexerInput | undefined;
    if (input === undefined) { input = await queryIndexer(searchKey, rpcUrl, rpc, signal); snapshots.set(key, input); }
    collected.push(definition.kind === "cell" ? { ...definition, input } : { ...definition, input });
  }
  return collected;
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

async function collectClaimsV2(
  claims: ClaimV4[], transactions: ReadonlyMap<string, CkbJsonRpcTransaction>,
  hashes: ReadonlyMap<string, string>, rpcUrl: string, rpc: RunnerRpcCaller, signal?: AbortSignal,
): Promise<ClaimInputV2[]> {
  const snapshots = new Map<string, CellInput>();
  const collected: ClaimInputV2[] = [];
  for (const claim of claims) {
    if (claim.kind === "cell_deps") { collected.push(claimDefinition(claim)); continue; }
    const key = JSON.stringify(claim.outPoint);
    let input = snapshots.get(key);
    if (input === undefined) {
      const tx = transactions.get(claim.outPoint.step), hash = hashes.get(claim.outPoint.step);
      if (tx === undefined || hash === undefined) throw new Error("missing retained target transaction");
      if (claim.outPoint.index >= tx.outputs.length) input = { kind: "missing-output" };
      else {
        const outPoint = { tx_hash: hash, index: `0x${claim.outPoint.index.toString(16)}` };
        const response = validateLiveCellResponse(await rpc(rpcUrl, "get_live_cell", [outPoint, true], signal));
        input = { kind: "query", outPoint, response };
      }
      snapshots.set(key, input);
    }
    collected.push({ ...claimDefinition(claim), input });
  }
  return collected;
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
  if (manifest.toolchain.ckbDebugger !== undefined) {
    resolvePinnedDebuggerAsset(manifest.toolchain.ckbDebugger, process.platform, process.arch);
  }
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
  let preparedDebugger: PreparedDebugger | undefined;
  let secrets: string[] = [];
  let primaryError: unknown;
  let reportToPublish: RunManifestResult | undefined;
  try {
    throwIfAborted(options.signal);
    context = await devnet.start(options.signal);
    secrets = await readSecrets(context.accountsPath);
    throwIfAborted(options.signal);
    if (manifest.toolchain.ckbDebugger !== undefined) {
      try {
        preparedDebugger = await devnet.prepareDebugger(manifest.toolchain.ckbDebugger);
      } catch (error) { throw redactPreparationError(error, secrets); }
    }
    const transactionHashes = new Map<string, string>();
    const transactionOutputCounts = new Map<string, number>();
    const steps: RunEvidence["steps"] = [];
    const modernSteps: RunInputV2["steps"] = [];
    const transactions = new Map<string, CkbJsonRpcTransaction>();
    const modernManifest = isManifestV4(manifest) ? manifest : undefined;
    const legacyManifest = manifest.meta.spec === "0.1.0-draft.3" ? (manifest as ManifestV3) : undefined;
    const v5Manifest = isManifestV5(manifest) ? manifest : undefined;
    const v5Steps: RunInputV3["steps"] = [];
    // draft.5 claims resolve account and builtin references against the environment the report will carry.
    const v5Environment = v5Manifest === undefined ? undefined : (await environmentEvidence(projectRoot, manifest, manifestBytes, context, sourceRevision, preparedDebugger)) as EnvironmentEvidenceV4;

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
      if (modernManifest !== undefined) validateTransaction(tx);
      const txHash = transactionHash(tx);
      transactionHashes.set(step.name, txHash);
      transactionOutputCounts.set(step.name, tx.outputs.length);
      transactions.set(step.name, tx);
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
        if (preparedDebugger === undefined) throw new Error("script rejection requires a prepared pinned debugger");
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

      const stepEvidence = {
        name: step.name,
        ...(step.expect === undefined ? {} : { expectedStatus: step.expect.tx }),
        ...(step.expect?.error?.code === undefined ? {} : { expectedErrorCode: step.expect.error.code }),
        ...(step.expect?.cycles === undefined ? {} : { expectedCycles: step.expect.cycles }),
        observedStatus,
        ...(cycles === undefined ? {} : { cycles }),
        ...(rejection === undefined ? {} : { rejection }),
        transactionHash: txHash,
        durationMs: commandResult.durationMs,
      };
      if (v5Manifest !== undefined && v5Environment !== undefined) {
        v5Steps.push({ ...stepEvidence, transaction: tx,
          claims: await collectClaimsV3(v5Manifest.steps[index]!.assertions, transactions, transactionHashes, v5Environment, context.rpcUrl, rpc, options.signal) });
      } else if (modernManifest !== undefined) {
        modernSteps.push({ ...stepEvidence, transaction: tx,
          claims: await collectClaimsV2(modernManifest.steps[index]!.assertions, transactions, transactionHashes, context.rpcUrl, rpc, options.signal) });
      } else if (legacyManifest !== undefined) {
        const claims: ClaimEvidence[] = [];
        for (const assertion of legacyManifest.steps[index]!.assertions) {
          claims.push(await evaluateCell(assertion, transactionHashes, transactionOutputCounts, context.rpcUrl, rpc, options.signal));
        }
        steps.push({ ...stepEvidence, claims });
      }
    }

    const assertions: ClaimEvidence[] = [];
    for (const assertion of legacyManifest?.assertions ?? []) {
      assertions.push(await evaluateCell(assertion, transactionHashes, transactionOutputCounts, context.rpcUrl, rpc, options.signal));
    }
    const evidence: RunEvidence = {
      name: manifest.meta.name,
      spec: manifest.meta.spec,
      steps,
      assertions,
    };
    const modernAssertions = modernManifest === undefined ? [] : await collectClaimsV2(modernManifest.assertions, transactions, transactionHashes, context.rpcUrl, rpc, options.signal);
    const v5Assertions = v5Manifest === undefined || v5Environment === undefined ? [] : await collectClaimsV3(v5Manifest.assertions, transactions, transactionHashes, v5Environment, context.rpcUrl, rpc, options.signal);
    throwIfAborted(options.signal);
    const finalSourceRevision = await collectSourceRevision(projectRoot);
    if (!sameSourceRevision(sourceRevision, finalSourceRevision)) {
      throw new Error("source revision changed during verification");
    }
    const environment = await environmentEvidence(
      projectRoot,
      manifest,
      manifestBytes,
      context,
      finalSourceRevision,
      preparedDebugger,
    );
    let report: CkbVerifyReport;
    if (v5Manifest !== undefined) {
      const input: RunInputV3 = { name: v5Manifest.meta.name, spec: v5Manifest.meta.spec,
        manifestText: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes), steps: v5Steps, assertions: v5Assertions };
      const outcomeClaims = deriveOutcomeV3(input, environment);
      report = { schema: "ckb-verify-report/3", verdict: verdictForOutcomeV3(outcomeClaims), createdAt: new Date().toISOString(),
        evidence: populateEvidenceV3(input, outcomeClaims), outcomeClaims, environment: environment as EnvironmentEvidenceV4,
        digests: { outcome: canonicalSha256(outcomeClaims), environment: canonicalSha256(environment) } };
    } else if (modernManifest !== undefined) {
      const input: RunInputV2 = { name: modernManifest.meta.name, spec: modernManifest.meta.spec,
        manifestText: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes), steps: modernSteps, assertions: modernAssertions };
      const outcomeClaims = deriveOutcomeV2(input, environment);
      report = { schema: "ckb-verify-report/2", verdict: verdictForOutcomeV2(outcomeClaims), createdAt: new Date().toISOString(),
        evidence: populateEvidenceV2(input, outcomeClaims), outcomeClaims, environment: environment as EnvironmentEvidence,
        digests: { outcome: canonicalSha256(outcomeClaims), environment: canonicalSha256(environment) } };
    } else {
      const outcomeClaims = buildOutcomeClaims(evidence);
      const digests = buildEvidenceDigests(evidence, environment as EnvironmentEvidence);
      const verdict = verdictForOutcomeClaims(outcomeClaims);
      report = {
        schema: "ckb-verify-report/1",
        verdict,
        createdAt: new Date().toISOString(),
        evidence,
        outcomeClaims,
        environment: environment as EnvironmentEvidence,
        digests,
      };
    }
    verifyReport(report);
    await writeJson(pendingReportPath, report);
    reportToPublish = { verdict: report.verdict, reportPath, report };
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
      throwIfAborted(options.signal);
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
        // v2 publication is gated on the actual pending bytes after scan/stop,
        // not a second serialization of the already-verified in-memory object.
        if (reportToPublish.report.schema !== "ckb-verify-report/1") {
          verifyReport(JSON.parse(await readFile(pendingReportPath, "utf8")));
        }
        await rename(pendingReportPath, reportPath);
      } catch (error) {
        const publicationErrors: unknown[] = [error];
        const paths = reportToPublish.report.schema !== "ckb-verify-report/1" ? [pendingReportPath, reportPath] : [pendingReportPath];
        for (const path of paths) {
          try {
            await rm(path, { force: true });
          } catch (cleanupError) {
            publicationErrors.push(cleanupError);
          }
        }
        throw new AggregateError(
          publicationErrors,
          publicationErrors.map((entry) => (entry instanceof Error ? entry.message : String(entry))).join("; "),
        );
      }
    }
  }
}
