import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { hashCkb } from "@ckb-ccc/core";
import { deriveOutcomeV4, populateEvidenceV4, verdictForOutcomeV4, resolutionContextV4, validateSetupScripts, TERMINAL_NODE_REJECTION_CODES, TYPE_ID_CODE_HASH,
  type InputCellRecord, type OutcomeV4, type RunEvidenceV4, type RunInputV4, type SetupScriptRecord, type StepInputV4 } from "./claims-v4";
import { defaultDevnet, type SealingConfiguration } from "./devnet-identity";
import { MAX_DEPLOY_BYTES } from "./manifest-v6";
import { collectProvenanceV4, parseToolVersion, sanitizeRepositoryUrl, type RuntimeTool } from "./provenance-v4";
import { canonicalSha256, sha256Bytes } from "./canonical";
import { loadManifest } from "./manifest";
import { resolvePinnedDebuggerAsset } from "./debugger-binary";
import type { OffckbRunContext, OffckbPaths, PreparedDebugger } from "./offckb";
import { OffckbDevnet } from "./offckb";
import { runCommand, runProcess, type CommandResult, type RunCommandOptions } from "./process";
import { collectProvenance, type SourceRevision } from "./provenance";
import { assertSupportedRuntimePlatform } from "./runtime-ownership";
import {
  buildEvidenceDigests,
  buildOutcomeClaims,
  verdictForOutcomeClaims,
  verifyReport,
  type EnvironmentEvidence, type EnvironmentEvidenceV4, type EnvironmentEvidenceV5,
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
import { isManifestV4, isManifestV5, isManifestV6, type CellAssertion, type ClaimV4, type ClaimV5, type Manifest, type ManifestV3, type ManifestV6 } from "./types";
import {
  claimDefinitionV3, deriveOutcomeV3, expectedSearchKey, populateEvidenceV3, resolutionContextFromEnvironment, validateIndexerInput, verdictForOutcomeV3, type ResolutionContext,
  type CellInputV3, type ClaimInputV3, type IndexerInput, type IndexerPage, type IndexerSearchKey, type OutcomeV3, type RunEvidenceV3, type RunInputV3,
} from "./claims-v3";
import { INDEXER_PAGE_LIMIT, MAX_SELECTED_CELLS } from "./limits";
import { resolvePinnedCkbAsset } from "./ckb-binary";
/** The only CKB release with pinned archives; drift-allowed runs fall back to it. */
export const PINNED_CKB_VERSION = "0.209.0";
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
  /** Development keys to redact beyond the exported accounts (every key the devnet reported). */
  redactionSecrets?(): readonly string[];
  /** 0.2.0: deploys a repository binary and returns its code Cell; the runner verifies it on chain. */
  deployBinary?(name: string, bytes: Uint8Array, typeId: boolean): Promise<{ txHash: string; index: number }>;
  /** 0.2.0: the running devnet's sealing configuration. */
  sealing?(): Promise<SealingConfiguration>;
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
export interface CkbVerifyReportV4 extends Omit<CkbVerifyReportV1, "schema" | "evidence" | "outcomeClaims" | "environment"> {
  schema: "ckb-verify-report/4";
  evidence: RunEvidenceV4;
  outcomeClaims: OutcomeV4;
  environment: EnvironmentEvidenceV5;
}
export type CkbVerifyReport = CkbVerifyReportV1 | CkbVerifyReportV2 | CkbVerifyReportV3 | CkbVerifyReportV4;

export interface RunManifestOptions {
  manifestPath: string;
  projectRoot?: string;
  outputDir?: string;
  devnet?: DevnetAdapter;
  runStep?: StepCommandRunner;
  rpc?: RunnerRpcCaller;
  signal?: AbortSignal;
  /** 0.1.0 and draft.5 only: run on the pinned CKB when the manifest requests another exact version; recorded and tainting. */
  allowVersionDrift?: boolean;
  /** Called as the run enters each stage; the stage of a failure is also on the thrown error (`runFailureStage`). */
  onStage?: (stage: string) => void;
  /** How long indexer-backed claims wait for the node indexer to reach the chain tip (defaults: 30 s, polled every 200 ms). */
  indexerSync?: Partial<IndexerSyncPolicy>;
}

export interface IndexerSyncPolicy { timeoutMs: number; pollMs: number }
const DEFAULT_INDEXER_SYNC: IndexerSyncPolicy = { timeoutMs: 30_000, pollMs: 200 };

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

export class SourceSnapshotError extends Error {}

/**
 * Git-visible snapshot of the project, taken before and after a run. Outside a git repository (or before
 * the first commit) there is nothing to compare and every field is null; replay is then tainted. Inside a
 * repository every git call and every untracked entry must be readable, and any failure refuses the run:
 * a snapshot that silently degraded to nulls on both sides would compare equal and switch the guard off.
 * Untracked files are listed for the whole repository, and the runner's own `.ckb-verify/` output under
 * the project is excluded, because it is written by the run itself.
 */
export async function collectSourceRevision(projectRoot: string): Promise<SourceRevision> {
  const unavailable = { gitCommit: null, dirty: null, dirtyDigest: null } as const;
  let commit;
  try {
    commit = await runProcess(["git", "rev-parse", "--verify", "HEAD"], { cwd: projectRoot, timeoutMs: 10_000 });
  } catch {
    return unavailable; // git is not installed
  }
  if (commit.timedOut || commit.exitCode !== 0) return unavailable; // not a repository, or no commit yet
  const gitCommit = commit.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new SourceSnapshotError(`git rev-parse returned an unexpected commit: ${gitCommit}`);

  const git = async (args: string[]): Promise<string> => {
    const result = await runProcess(["git", ...args], { cwd: projectRoot, timeoutMs: 10_000 });
    if (result.timedOut || result.exitCode !== 0) {
      throw new SourceSnapshotError(`cannot snapshot the project source: git ${args[0]} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  const prefix = (await git(["rev-parse", "--show-prefix"])).trim();
  const toTop = (await git(["rev-parse", "--show-cdup"])).trim();
  const pathspec = [":(top)", `:(exclude,top)${prefix}.ckb-verify`];
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspec]);
  if (status.trim() === "") return { gitCommit, dirty: false, dirtyDigest: null };

  const [diff, untracked] = await Promise.all([
    git(["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...pathspec]),
    git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...pathspec]),
  ]);
  const untrackedEntries = await Promise.all(
    untracked
      .split("\0")
      .filter((path) => path !== "")
      .sort()
      .map(async (path) => {
        const absolutePath = resolve(projectRoot, toTop, path);
        let metadata;
        try { metadata = await lstat(absolutePath); } catch (error) {
          throw new SourceSnapshotError(`cannot snapshot untracked ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (metadata.isDirectory()) {
          throw new SourceSnapshotError(`cannot snapshot untracked ${path}: it is a nested repository or directory git does not descend into; commit it, add it as a submodule, or ignore it`);
        }
        const symlink = metadata.isSymbolicLink();
        if (!symlink && !metadata.isFile()) throw new SourceSnapshotError(`cannot snapshot untracked ${path}: not a regular file or symlink`);
        let bytes: Buffer;
        try { bytes = symlink ? Buffer.from(await readlink(absolutePath), "utf8") : await readFile(absolutePath); } catch (error) {
          throw new SourceSnapshotError(`cannot snapshot untracked ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const mode = symlink ? "120000" : (metadata.mode & 0o111) === 0 ? "100644" : "100755";
        return { path, kind: symlink ? "symlink" : "file", mode, digest: sha256Bytes(bytes) };
      }),
  );
  return {
    gitCommit,
    dirty: true,
    dirtyDigest: canonicalSha256({ status, trackedDiff: diff, untracked: untrackedEntries }),
  };
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
  preparedDebugger: PreparedDebugger | undefined,
  driftAllowed: boolean,
): Promise<EnvironmentEvidence | EnvironmentEvidenceV4> {
  const common = {
    projectRoot,
    manifestBytes,
    replayDependencies: manifest.replay.dependencies,
    sourceRevision,
    ckbBinary: context.ckbBinary,
    ckbDebuggerBinary: preparedDebugger?.binary ?? null,
  };
  const provenance = isManifestV5(manifest)
    ? await collectProvenance({ ...common, toolchain: { ckb: { requested: manifest.toolchain.ckb, observed: context.ckbBinary.version, driftAllowed } } })
    : await collectProvenance(common);
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
    platform: { os: process.platform, arch: process.arch },
    devnet: {
      network: context.network,
      genesisHash: context.genesisHash,
      systemScripts: context.systemScripts,
    },
  };
  if (isManifestV5(manifest) && provenance.schema === "ckb-verify-provenance/3") {
    return { schema: "ckb-verify-environment/4", ...base, provenance, devnet: { ...base.devnet, accounts: context.accounts.slice(0, manifest.setup.accounts).map((a) => ({ index: a.index, address: a.address, lock: { ...a.lock } })) } };
  }
  if (provenance.schema !== "ckb-verify-provenance/2") throw new Error("provenance/2 required for draft.3 and draft.4 reports");
  return { schema: "ckb-verify-environment/3", ...base, provenance };
}

// ---- spec 0.2.0 setup ----

/** A repository binary read and hashed before any runtime mutation: the RFC requires hashing before deployment. */
interface RepositoryBinary { name: string; path: string; hashType: "type" | "data" | "data1" | "data2"; bytes: Uint8Array }

/** Reads every `[setup.scripts]` binary, refusing anything OffCKB would not deploy faithfully. */
export async function readRepositoryBinaries(projectRoot: string, manifest: ManifestV6): Promise<RepositoryBinary[]> {
  const root = await realpath(projectRoot);
  const binaries: RepositoryBinary[] = [];
  for (const script of manifest.setup.scripts) {
    if (script.kind !== "binary") continue;
    const label = `setup.scripts.${script.name}.binary (${script.path})`;
    let resolved: string;
    try { resolved = await realpath(resolve(projectRoot, script.path)); } catch (error) {
      throw new Error(`${label} does not exist: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error(`${label} resolves outside the repository`);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size === 0 || info.size > MAX_DEPLOY_BYTES) throw new Error(`${label} is ${info.size} bytes; OffCKB 0.4.13 deploys 1..${MAX_DEPLOY_BYTES} bytes`);
    const bytes = new Uint8Array(await readFile(resolved));
    // OffCKB 0.4.13 refuses files without a byte above 0x7f as "not a binary"; say so before starting a devnet.
    if (!bytes.some((byte) => byte > 0x7f)) throw new Error(`${label} has no byte above 0x7f, which OffCKB 0.4.13 refuses to deploy as a binary`);
    binaries.push({ name: script.name, path: script.path, hashType: script.hashType, bytes });
  }
  return binaries;
}

function requireRecordValue(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

/** Deploys the binaries in declaration order and verifies each code Cell on chain against its bytes. */
async function deploySetupScripts(
  manifest: ManifestV6, binaries: readonly RepositoryBinary[], devnet: DevnetAdapter, context: OffckbRunContext, rpc: RunnerRpcCaller, signal?: AbortSignal,
): Promise<SetupScriptRecord[]> {
  const records: SetupScriptRecord[] = [];
  for (const script of manifest.setup.scripts) {
    throwIfAborted(signal);
    if (script.kind === "builtin") {
      const binding = context.systemScripts[script.builtin];
      if (binding === undefined) throw new Error(`setup.scripts.${script.name}: OffCKB exports no system script ${script.builtin}`);
      records.push({ name: script.name, kind: "builtin", builtin: script.builtin, codeHash: binding.codeHash, hashType: binding.hashType, cellDeps: binding.cellDeps.map((d) => ({ ...d, outPoint: { ...d.outPoint } })) });
      continue;
    }
    const binary = binaries.find((candidate) => candidate.name === script.name);
    if (binary === undefined) throw new Error(`setup.scripts.${script.name}: binary was not read`);
    if (devnet.deployBinary === undefined) throw new Error("this devnet adapter cannot deploy repository binaries");
    const outPoint = await devnet.deployBinary(script.name, binary.bytes, script.hashType === "type");
    const live = validateLiveCellResponse(await rpc(context.rpcUrl, "get_live_cell", [{ tx_hash: outPoint.txHash, index: `0x${outPoint.index.toString(16)}` }, true], signal));
    if (live.status !== "live") throw new Error(`setup.scripts.${script.name}: deployed code Cell is not live`);
    const dataHash = hashCkb(binary.bytes);
    if (live.cell.data.hash !== dataHash) throw new Error(`setup.scripts.${script.name}: deployed Cell data does not match the repository binary`);
    let typeId: Extract<SetupScriptRecord, { kind: "binary" }>["typeId"] = null;
    let codeHash: string = dataHash;
    if (script.hashType === "type") {
      const type = live.cell.output.type;
      if (type == null || type.code_hash !== TYPE_ID_CODE_HASH || type.hash_type !== "type") throw new Error(`setup.scripts.${script.name}: deployed Cell has no Type ID`);
      const typeScript = { codeHash: TYPE_ID_CODE_HASH, hashType: "type" as const, args: type.args };
      codeHash = scriptHash(typeScript);
      typeId = { script: typeScript, scriptHash: codeHash };
    }
    records.push({
      name: script.name, kind: "binary", path: binary.path, size: binary.bytes.length, binarySha256: sha256Bytes(binary.bytes), dataHash,
      hashType: script.hashType, codeHash, cellDep: { outPoint: { txHash: outPoint.txHash, index: outPoint.index }, depType: "code" }, typeId,
      deployment: { output: { capacity: live.cell.output.capacity, lock: { ...live.cell.output.lock }, type: live.cell.output.type == null ? null : { ...live.cell.output.type } }, dataHash: live.cell.data.hash },
    });
  }
  return records;
}

async function originRemote(projectRoot: string): Promise<string | null> {
  try {
    const result = await runProcess(["git", "remote", "get-url", "origin"], { cwd: projectRoot, timeoutMs: 10_000 });
    if (result.timedOut || result.exitCode !== 0) return null;
    return sanitizeRepositoryUrl(result.stdout);
  } catch { return null; }
}

/** `<tool> --version` in the environment step commands inherit; null when the tool is absent or fails. */
async function observeTool(tool: RuntimeTool, projectRoot: string): Promise<string | null> {
  try {
    const result = await runProcess([tool, "--version"], { cwd: projectRoot, timeoutMs: 20_000 });
    if (result.timedOut || result.exitCode !== 0) return null;
    return parseToolVersion(result.stdout);
  } catch { return null; }
}

async function environmentEvidenceV5(
  projectRoot: string, manifest: ManifestV6, manifestBytes: Uint8Array, context: OffckbRunContext, sourceRevision: SourceRevision,
  preparedDebugger: PreparedDebugger | undefined, driftAllowed: boolean, scripts: SetupScriptRecord[], sealing: SealingConfiguration,
): Promise<EnvironmentEvidenceV5> {
  const pinned = defaultDevnet(context.ckbBinary.version);
  const provenance = await collectProvenanceV4({
    projectRoot, manifestBytes, replayDependencies: manifest.replay.dependencies, sourceRevision,
    repositoryUrl: await originRemote(projectRoot), ckbBinary: context.ckbBinary, ckbDebuggerBinary: preparedDebugger?.binary ?? null,
    toolchain: { ckb: { requested: manifest.toolchain.ckb, observed: context.ckbBinary.version, driftAllowed } },
    sealingFingerprint: sealing.fingerprint, defaultSealingFingerprint: pinned.sealingFingerprint,
    observeTool: (tool) => observeTool(tool, projectRoot),
  });
  return {
    schema: "ckb-verify-environment/5",
    runner: { name: "ckb-verify", version: VERSION },
    toolchain: {
      requested: manifest.toolchain,
      observed: { ckb: context.ckbVersion, offckb: context.offckbVersion, ...(preparedDebugger === undefined ? {} : { ckbDebugger: preparedDebugger.version }) },
    },
    provenance,
    platform: { os: process.platform, arch: process.arch },
    devnet: {
      network: context.network, genesisHash: context.genesisHash, systemScripts: context.systemScripts,
      accounts: context.accounts.slice(0, manifest.setup.accounts).map((a) => ({ index: a.index, address: a.address, lock: { ...a.lock } })),
      scripts, sealing,
    },
  };
}

/** For a script rejection: every consumed Cell, so the group check and the input's script verify offline. */
async function retainInputCells(tx: CkbJsonRpcTransaction, rpcUrl: string, rpc: RunnerRpcCaller, signal?: AbortSignal): Promise<InputCellRecord[]> {
  const cells: InputCellRecord[] = [];
  for (const [i, raw] of tx.inputs.entries()) {
    const previous = requireRecordValue(requireRecordValue(raw, `transaction.inputs[${i}]`).previous_output, `transaction.inputs[${i}].previous_output`);
    const outPoint = { tx_hash: String(previous.tx_hash), index: String(previous.index) };
    const response = validateLiveCellResponse(await rpc(rpcUrl, "get_live_cell", [outPoint, true], signal));
    if (response.status !== "live") throw new Error(`input ${i} of the script-rejected transaction is not live`);
    cells.push({ outPoint, response });
  }
  return cells;
}

function blockNumber(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new Error(`${path} must be a canonical hex block number`);
  return BigInt(value);
}

/**
 * The node indexer follows the chain asynchronously, so a `get_cells` page read right after a commit can
 * miss the committing block and record a self-consistent but wrong selection that no offline check can
 * detect. Before a phase's indexer queries, wait (bounded) until the indexer has reached the chain tip
 * observed now, which is at or above every block committed so far; otherwise fail without a verdict.
 */
export async function awaitIndexerSync(rpcUrl: string, rpc: RunnerRpcCaller, policy: IndexerSyncPolicy, signal?: AbortSignal): Promise<void> {
  const tip = blockNumber(await rpc(rpcUrl, "get_tip_block_number", [], signal), "get_tip_block_number result");
  const deadline = Date.now() + policy.timeoutMs;
  let indexed: bigint | undefined;
  for (;;) {
    throwIfAborted(signal);
    const result = await rpc(rpcUrl, "get_indexer_tip", [], signal);
    if (result !== null) indexed = blockNumber(requireRecord(result, "get_indexer_tip result").block_number, "get_indexer_tip result.block_number");
    if (indexed !== undefined && indexed >= tip) return;
    if (Date.now() >= deadline) {
      throw new Error(`node indexer did not reach chain tip ${tip} within ${policy.timeoutMs} ms (indexed: ${indexed ?? "none"}); no indexer-backed claim was evaluated`);
    }
    await new Promise((resolve) => setTimeout(resolve, policy.pollMs));
  }
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
  environment: EnvironmentEvidenceV4 | EnvironmentEvidenceV5, rpcUrl: string, rpc: RunnerRpcCaller, sync: IndexerSyncPolicy, signal?: AbortSignal,
  resolution?: ResolutionContext,
): Promise<ClaimInputV3[]> {
  const context = resolution ?? resolutionContextFromEnvironment(environment);
  let synced = false;
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
    if (input === undefined) {
      if (!synced) { await awaitIndexerSync(rpcUrl, rpc, sync, signal); synced = true; }
      input = await queryIndexer(searchKey, rpcUrl, rpc, signal); snapshots.set(key, input);
    }
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

/** The recorded form of a 0.2.0 transaction step: its declared expectations, then what was observed. */
function v6TransactionStep(manifest: ManifestV6, index: number, observed: Omit<Extract<StepInputV4, { kind: "transaction" }>,
  "name" | "kind" | "expectedStatus" | "expectedErrorCode" | "expectedErrorGroup" | "expectedCycles">): StepInputV4 {
  const step = manifest.steps[index]!;
  if (step.kind !== "transaction") throw new Error(`step ${step.name} is not a transaction step`);
  return {
    name: step.name, kind: "transaction", expectedStatus: step.expect.tx,
    ...(step.expect.error?.code === undefined ? {} : { expectedErrorCode: step.expect.error.code }),
    ...(step.expect.error?.group === undefined ? {} : { expectedErrorGroup: step.expect.error.group }),
    ...(step.expect.cycles === undefined ? {} : { expectedCycles: step.expect.cycles }),
    ...observed,
  };
}

/**
 * Where a run stopped, for the error a no-verdict run throws: "manifest", "preflight", "devnet", "setup",
 * `step "<name>": command|result|submission|claims`, "final claims", "source guard", "report", or "cleanup".
 * It separates a project or manifest problem from a toolchain one, which a bare message often does not.
 */
export function runFailureStage(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const stage = (error as { ckbVerifyStage?: unknown }).ckbVerifyStage;
  return typeof stage === "string" ? stage : undefined;
}

export async function runManifest(options: RunManifestOptions): Promise<RunManifestResult> {
  const progress = { stage: "manifest" };
  const enter = (stage: string) => { progress.stage = stage; options.onStage?.(stage); };
  try {
    return await runManifestStages(options, enter);
  } catch (error) {
    // The thrown error is kept as is (tests and callers inspect it); the stage rides along, not enumerable.
    if (error !== null && typeof error === "object" && runFailureStage(error) === undefined) {
      try { Object.defineProperty(error, "ckbVerifyStage", { value: progress.stage, enumerable: false, configurable: true }); } catch { /* frozen error objects keep no stage */ }
    }
    throw error;
  }
}

async function runManifestStages(options: RunManifestOptions, enter: (stage: string) => void): Promise<RunManifestResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const manifestPath = resolve(projectRoot, options.manifestPath);
  const { manifest, bytes: manifestBytes } = await loadManifest(manifestPath);
  // Refuse unsupported platforms before the run directory, manifest copy, or any cache is written.
  // An injected devnet (tests) owns no runtime, so the gate applies to the real OffCKB path only.
  enter("preflight");
  if (options.devnet === undefined) assertSupportedRuntimePlatform();
  if (manifest.toolchain.ckbDebugger !== undefined) {
    resolvePinnedDebuggerAsset(manifest.toolchain.ckbDebugger, process.platform, process.arch);
  }
  const sourceRevision = await collectSourceRevision(projectRoot);
  const v6Manifest = isManifestV6(manifest) ? manifest : undefined;
  // 0.2.0: read and hash every repository binary before any runtime mutation.
  const binaries = v6Manifest === undefined ? [] : await readRepositoryBinaries(projectRoot, v6Manifest);
  // Tool-version drift: only draft.5-grammar manifests (0.1.0, 0.1.0-draft.5) may run on the pinned CKB when
  // they request another exact version, and only when explicitly allowed; the drift is recorded in
  // provenance/3 and taints replay.
  let ckbVersion = manifest.toolchain.ckb;
  let driftAllowed = false;
  if (options.allowVersionDrift === true) {
    if (!isManifestV5(manifest) && !isManifestV6(manifest)) throw new Error("--allow-version-drift requires a 0.2.0, 0.1.0, or 0.1.0-draft.5 manifest");
    driftAllowed = true;
    try { resolvePinnedCkbAsset(ckbVersion, process.platform, process.arch); }
    catch { ckbVersion = PINNED_CKB_VERSION; }
  } else {
    resolvePinnedCkbAsset(ckbVersion, process.platform, process.arch); // fail before any runtime mutation
  }
  const outputDir = resolve(options.outputDir ?? outputDirectory(projectRoot, manifest));
  const reportPath = join(outputDir, "report.json");
  const pendingReportPath = join(outputDir, ".report.json.pending");
  const runStep = options.runStep ?? runCommand;
  const indexerSync: IndexerSyncPolicy = { ...DEFAULT_INDEXER_SYNC, ...options.indexerSync };
  const rpc: RunnerRpcCaller =
    options.rpc ??
    ((url, method, params = [], signal) => rpcCall(url, method, params, fetch, 30_000, signal));
  const devnet =
    options.devnet ??
    new OffckbDevnet({
      repositoryRoot: projectRoot,
      ckbVersion,
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
    enter("devnet");
    context = await devnet.start(options.signal);
    secrets = [...new Set([...await readSecrets(context.accountsPath), ...(devnet.redactionSecrets?.() ?? [])])];
    throwIfAborted(options.signal);
    if (manifest.toolchain.ckbDebugger !== undefined) {
      try {
        preparedDebugger = await devnet.prepareDebugger(manifest.toolchain.ckbDebugger);
      } catch (error) { throw redactPreparationError(error, secrets); }
    }
    // 0.2.0 setup: the genesis must be the pinned default devnet's; then deploy and record the scripts.
    let v6Environment: EnvironmentEvidenceV5 | undefined;
    let v6Resolution: ResolutionContext | undefined;
    let v6Scripts: SetupScriptRecord[] = [];
    let v6Sealing: SealingConfiguration | undefined;
    let scriptsPath: string | undefined;
    if (v6Manifest !== undefined) {
      enter("setup");
      const pinned = defaultDevnet(context.ckbBinary.version);
      if (context.genesisHash !== pinned.genesisHash) {
        throw new Error(`devnet genesis ${context.genesisHash} is not the pinned default OffCKB devnet genesis ${pinned.genesisHash} for CKB ${context.ckbBinary.version}`);
      }
      if (devnet.sealing === undefined) throw new Error("this devnet adapter cannot report its sealing configuration");
      v6Sealing = await devnet.sealing();
      try { v6Scripts = await deploySetupScripts(v6Manifest, binaries, devnet, context, rpc, options.signal); }
      catch (error) { throw redactPreparationError(error, secrets); }
      scriptsPath = join(outputDir, "setup-scripts.json");
      await writeJson(scriptsPath, { scripts: Object.fromEntries(v6Scripts.map((script) => [script.name, script.kind === "builtin"
        ? { kind: "builtin", builtin: script.builtin, codeHash: script.codeHash, hashType: script.hashType, cellDeps: script.cellDeps }
        : { kind: "binary", codeHash: script.codeHash, hashType: script.hashType, cellDeps: [script.cellDep], binarySha256: script.binarySha256, dataHash: script.dataHash }])) });
      v6Environment = await environmentEvidenceV5(projectRoot, v6Manifest, manifestBytes, context, sourceRevision, preparedDebugger, driftAllowed, v6Scripts, v6Sealing);
      v6Resolution = resolutionContextV4(v6Environment, validateSetupScripts(v6Environment, v6Manifest));
    }
    const v6Steps: StepInputV4[] = [];
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
    const v5Environment = v5Manifest === undefined ? undefined : (await environmentEvidence(projectRoot, manifest, manifestBytes, context, sourceRevision, preparedDebugger, driftAllowed)) as EnvironmentEvidenceV4;

    for (const [index, step] of manifest.steps.entries()) {
      throwIfAborted(options.signal);
      const stepDirectory = join(outputDir, "steps", `${String(index + 1).padStart(2, "0")}-${slug(step.name)}`);
      await mkdir(stepDirectory, { recursive: true });
      const resultPath = join(stepDirectory, "result.json");
      enter(`step "${step.name}": command`);
      const commandResult = await runStep(step.run, {
        cwd: projectRoot,
        timeoutMs: step.timeoutMs,
        env: {
          CKB_VERIFY_RESULT: resultPath,
          CKB_VERIFY_RPC_URL: context.rpcUrl,
          CKB_VERIFY_ACCOUNTS: context.accountsPath,
          CKB_VERIFY_SYSTEM_SCRIPTS: context.systemScriptsPath,
          CKB_VERIFY_CONTEXT: context.contextPath,
          ...(scriptsPath === undefined ? {} : { CKB_VERIFY_SCRIPTS: scriptsPath }),
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

      if (v6Manifest !== undefined && v6Environment !== undefined && v6Manifest.steps[index]!.kind === "pure") {
        // A pure step submits nothing; writing a result is a contract violation, not something to ignore.
        enter(`step "${step.name}": result`);
        let wrote = true;
        try { await lstat(resultPath); } catch (error) {
          if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") wrote = false; else throw error;
        }
        if (wrote) throw new Error(`pure step "${step.name}" wrote CKB_VERIFY_RESULT; declare expect.tx to make it a transaction step`);
        enter(`step "${step.name}": claims`);
        v6Steps.push({ name: step.name, kind: "pure", durationMs: commandResult.durationMs,
          claims: await collectClaimsV3(v6Manifest.steps[index]!.assertions, transactions, transactionHashes, v6Environment, context.rpcUrl, rpc, indexerSync, options.signal, v6Resolution) });
        continue;
      }
      enter(`step "${step.name}": result`);
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
      let inputCells: InputCellRecord[] | undefined;
      enter(`step "${step.name}": submission`);
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
        if (v6Manifest !== undefined && parsedRejection.kind === "node" && TERMINAL_NODE_REJECTION_CODES.includes(error.code)) {
          // 0.2.0: the node refused the transaction itself (dead input, failed verification, fee, …).
          observedStatus = "rejected";
          rejection = { kind: "node", rpcCode: error.code, reason: error.message };
          await writeJson(join(stepDirectory, "rpc-error.json"), { code: error.code, message: error.message, data: error.data });
          transactionHashes.set(step.name, txHash);
          enter(`step "${step.name}": claims`);
          v6Steps.push(v6TransactionStep(v6Manifest, index, { observedStatus, rejection, transactionHash: txHash, transaction: tx, durationMs: commandResult.durationMs,
            claims: await collectClaimsV3(v6Manifest.steps[index]!.assertions, transactions, transactionHashes, v6Environment!, context.rpcUrl, rpc, indexerSync, options.signal, v6Resolution) }));
          continue;
        }
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
        if (v6Manifest !== undefined) inputCells = await retainInputCells(tx, context.rpcUrl, rpc, options.signal);
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
      enter(`step "${step.name}": claims`);
      if (v6Manifest !== undefined && v6Environment !== undefined) {
        v6Steps.push(v6TransactionStep(v6Manifest, index, { observedStatus, ...(cycles === undefined ? {} : { cycles }), ...(rejection === undefined ? {} : { rejection }),
          ...(inputCells === undefined ? {} : { inputCells }), transactionHash: txHash, transaction: tx, durationMs: commandResult.durationMs,
          claims: await collectClaimsV3(v6Manifest.steps[index]!.assertions, transactions, transactionHashes, v6Environment, context.rpcUrl, rpc, indexerSync, options.signal, v6Resolution) }));
      } else if (v5Manifest !== undefined && v5Environment !== undefined) {
        v5Steps.push({ ...stepEvidence, transaction: tx,
          claims: await collectClaimsV3(v5Manifest.steps[index]!.assertions, transactions, transactionHashes, v5Environment, context.rpcUrl, rpc, indexerSync, options.signal) });
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

    enter("final claims");
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
    const v5Assertions = v5Manifest === undefined || v5Environment === undefined ? [] : await collectClaimsV3(v5Manifest.assertions, transactions, transactionHashes, v5Environment, context.rpcUrl, rpc, indexerSync, options.signal);
    const v6Assertions = v6Manifest === undefined || v6Environment === undefined ? [] : await collectClaimsV3(v6Manifest.assertions, transactions, transactionHashes, v6Environment, context.rpcUrl, rpc, indexerSync, options.signal, v6Resolution);
    throwIfAborted(options.signal);
    enter("source guard");
    const finalSourceRevision = await collectSourceRevision(projectRoot);
    if (!sameSourceRevision(sourceRevision, finalSourceRevision)) {
      throw new Error("source revision changed during verification");
    }
    const environment = v6Manifest !== undefined
      ? await environmentEvidenceV5(projectRoot, v6Manifest, manifestBytes, context, finalSourceRevision, preparedDebugger, driftAllowed, v6Scripts, v6Sealing!)
      : await environmentEvidence(projectRoot, manifest, manifestBytes, context, finalSourceRevision, preparedDebugger, driftAllowed);
    enter("report");
    let report: CkbVerifyReport;
    if (v6Manifest !== undefined) {
      const input: RunInputV4 = { name: v6Manifest.meta.name, spec: "0.2.0",
        manifestText: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes), steps: v6Steps, assertions: v6Assertions };
      const outcomeClaims = deriveOutcomeV4(input, environment);
      report = { schema: "ckb-verify-report/4", verdict: verdictForOutcomeV4(outcomeClaims), createdAt: new Date().toISOString(),
        evidence: populateEvidenceV4(input, outcomeClaims), outcomeClaims, environment: environment as EnvironmentEvidenceV5,
        digests: { outcome: canonicalSha256(outcomeClaims), environment: canonicalSha256(environment) } };
    } else if (v5Manifest !== undefined) {
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
      if (primaryError === undefined) enter("cleanup");
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
