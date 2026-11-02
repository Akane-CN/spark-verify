import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Bytes } from "./canonical";
import type { InstalledCkbBinary } from "./ckb-binary";
import { assertDebuggerBinaryEvidence, type DebuggerBinaryEvidence } from "./debugger-binary";
import type { ReplayDependency } from "./types";

export interface SourceRevision {
  gitCommit: string | null;
  dirty: boolean | null;
  dirtyDigest: string | null;
}

export type ProvenanceReasonCode =
  | ReplayDependency
  | "dirty_source"
  | "source_revision_unavailable"
  | "source_state_unavailable"
  | "runtime_pin_missing"
  | "runtime_version_drift"
  | "tool_version_drift"
  | "lockfile_missing";

export interface ProvenanceReason {
  scope: "environment" | "outcome";
  code: ProvenanceReasonCode;
  detail: string;
}

export interface LegacyProvenanceEvidence {
  schema: "ckb-verify-provenance/1";
  replay: {
    declaredDependencies: ReplayDependency[];
    status: "stable" | "tainted";
    reasons: ProvenanceReason[];
  };
  source: SourceRevision;
  manifest: { sha256: string };
  lockfile: { path: "bun.lock"; sha256: string | null };
  runtime: {
    name: "bun";
    requestedVersion: string | null;
    observedVersion: string;
    metadata: { path: "package.json"; sha256: string | null };
  };
  binaries: { ckb: Omit<InstalledCkbBinary, "path"> };
}

export interface ProvenanceEvidence extends Omit<LegacyProvenanceEvidence, "schema" | "binaries"> {
  schema: "ckb-verify-provenance/2";
  binaries: { ckb: Omit<InstalledCkbBinary, "path">; ckbDebugger: DebuggerBinaryEvidence | null };
}
/** Tool-version drift recorded as a replay input: requested vs observed CKB and whether the run allowed the difference. */
export interface ToolchainDrift { ckb: { requested: string; observed: string; driftAllowed: boolean } }
export interface ProvenanceEvidenceV3 extends Omit<ProvenanceEvidence, "schema"> {
  schema: "ckb-verify-provenance/3";
  toolchain: ToolchainDrift;
}
export type AnyProvenanceEvidence = ProvenanceEvidence | ProvenanceEvidenceV3 | LegacyProvenanceEvidence;

export interface CollectProvenanceOptions {
  projectRoot: string;
  manifestBytes: Uint8Array;
  replayDependencies: readonly ReplayDependency[];
  sourceRevision: SourceRevision;
  ckbBinary: Omit<InstalledCkbBinary, "path">;
  ckbDebuggerBinary?: DebuggerBinaryEvidence | null;
  observedRuntimeVersion?: string;
  /** When present, provenance/3 is written and tool-version drift becomes a replay reason. */
  toolchain?: ToolchainDrift;
}

async function readOptionalFile(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function runtimePin(packageJsonBytes: Uint8Array | null): string | null {
  if (packageJsonBytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(packageJsonBytes));
  } catch (error) {
    throw new Error("package.json is not valid JSON", error instanceof Error ? { cause: error } : undefined);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const packageManager = (parsed as Record<string, unknown>).packageManager;
  if (typeof packageManager !== "string") return null;
  return /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1] ?? null;
}

function validateSourceRevision(source: SourceRevision): void {
  if (source.gitCommit !== null && !/^[0-9a-f]{40}$/.test(source.gitCommit)) {
    throw new Error("source git commit must be a lowercase 40-character hash");
  }
  if (source.dirty !== true && source.dirtyDigest !== null) {
    throw new Error("only a dirty source revision may include a dirty digest");
  }
  if (source.dirtyDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(source.dirtyDigest)) {
    throw new Error("source dirty digest must be SHA-256");
  }
}

function replayReasons(
  dependencies: readonly ReplayDependency[],
  source: SourceRevision,
  runtime: { requestedVersion: string | null; observedVersion: string },
  lockfileSha256: string | null,
  toolchain?: ToolchainDrift,
): ProvenanceReason[] {
  const reasons: ProvenanceReason[] = dependencies.map((dependency) => ({
    scope: "outcome",
    code: dependency,
    detail: `manifest declares replay dependency ${dependency}`,
  }));

  if (source.gitCommit === null) {
    reasons.push({
      scope: "environment",
      code: "source_revision_unavailable",
      detail: "source git revision is unavailable",
    });
  }
  if (source.dirty === null) {
    reasons.push({
      scope: "environment",
      code: "source_state_unavailable",
      detail: "source dirty state is unavailable",
    });
  } else if (source.dirty) {
    reasons.push({
      scope: "environment",
      code: "dirty_source",
      detail: "source tree differs from the recorded git commit",
    });
  }
  if (runtime.requestedVersion === null) {
    reasons.push({
      scope: "environment",
      code: "runtime_pin_missing",
      detail: "package.json does not contain an exact bun@x.y.z packageManager pin",
    });
  } else if (runtime.requestedVersion !== runtime.observedVersion) {
    reasons.push({
      scope: "environment",
      code: "runtime_version_drift",
      detail: `requested bun ${runtime.requestedVersion} but observed ${runtime.observedVersion}`,
    });
  }
  if (lockfileSha256 === null) {
    reasons.push({ scope: "environment", code: "lockfile_missing", detail: "bun.lock is missing" });
  }
  if (toolchain !== undefined && toolchain.ckb.requested !== toolchain.ckb.observed) {
    reasons.push({ scope: "environment", code: "tool_version_drift",
      detail: `requested ckb ${toolchain.ckb.requested} but observed ${toolchain.ckb.observed} (allowed by --allow-version-drift)` });
  }
  return reasons;
}

function sameReasons(actual: readonly ProvenanceReason[], expected: readonly ProvenanceReason[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (reason, index) =>
        reason.scope === expected[index]?.scope &&
        reason.code === expected[index]?.code &&
        reason.detail === expected[index]?.detail,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Narrow only the versioned provenance seam; this is not a full report parser.
function hasToolchainDrift(value: unknown): value is ToolchainDrift {
  return isRecord(value) && isRecord(value.ckb) && typeof value.ckb.requested === "string" && typeof value.ckb.observed === "string" &&
    typeof value.ckb.driftAllowed === "boolean" && Object.keys(value).length === 1 && Object.keys(value.ckb).length === 3;
}
function hasProvenanceShape(value: unknown): value is AnyProvenanceEvidence {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.manifest) || !isRecord(value.lockfile) ||
      !isRecord(value.runtime) || !isRecord(value.runtime.metadata) || !isRecord(value.replay) ||
      !isRecord(value.binaries) || !isRecord(value.binaries.ckb)) return false;
  const { source, runtime, replay, binaries } = value;
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  const dependencies = ["external_time", "randomness", "fee_estimation", "dynamic_since", "external_network"];
  return nullableString(source.gitCommit) && nullableString(source.dirtyDigest) &&
    (source.dirty === null || typeof source.dirty === "boolean") &&
    typeof value.manifest.sha256 === "string" && value.lockfile.path === "bun.lock" && nullableString(value.lockfile.sha256) &&
    runtime.name === "bun" && nullableString(runtime.requestedVersion) && typeof runtime.observedVersion === "string" &&
    isRecord(runtime.metadata) && runtime.metadata.path === "package.json" && nullableString(runtime.metadata.sha256) &&
    (replay.status === "stable" || replay.status === "tainted") && Array.isArray(replay.declaredDependencies) &&
    replay.declaredDependencies.every(v => typeof v === "string" && dependencies.includes(v)) &&
    Array.isArray(replay.reasons) && replay.reasons.every(v => isRecord(v) &&
      (v.scope === "environment" || v.scope === "outcome") && typeof v.code === "string" && typeof v.detail === "string") &&
    isRecord(binaries.ckb) && ["version", "platform", "architecture", "asset", "sourceUrl", "expectedArchiveSha256", "archiveSha256", "binarySha256"]
      .every(key => typeof (binaries.ckb as Record<string, unknown>)[key] === "string") &&
    (value.schema === "ckb-verify-provenance/1" || value.schema === "ckb-verify-provenance/2" ||
      (value.schema === "ckb-verify-provenance/3" && hasToolchainDrift(value.toolchain)));
}

export function assertProvenanceConsistency(
  provenance: unknown, options: { allowLegacy?: boolean } = {},
): asserts provenance is AnyProvenanceEvidence {
  if (!hasProvenanceShape(provenance)) throw new Error("invalid provenance structure or schema");
  if (provenance.schema === "ckb-verify-provenance/1") {
    if (!options.allowLegacy) throw new Error("legacy provenance requires explicit allowLegacy");
  } else if (provenance.binaries.ckbDebugger !== null) {
    assertDebuggerBinaryEvidence(provenance.binaries.ckbDebugger);
  }
  validateSourceRevision(provenance.source);
  if (provenance.binaries.ckb.expectedArchiveSha256 !== provenance.binaries.ckb.archiveSha256) {
    throw new Error("CKB archive provenance mismatch");
  }
  if (provenance.runtime.requestedVersion !== null && provenance.runtime.metadata.sha256 === null) {
    throw new Error("a pinned Bun runtime must include the package.json digest");
  }
  const toolchain = provenance.schema === "ckb-verify-provenance/3" ? provenance.toolchain : undefined;
  if (toolchain !== undefined && toolchain.ckb.requested !== toolchain.ckb.observed && !toolchain.ckb.driftAllowed) {
    throw new Error("tool-version drift was recorded without being allowed");
  }
  const expectedReasons = replayReasons(
    provenance.replay.declaredDependencies,
    provenance.source,
    provenance.runtime,
    provenance.lockfile.sha256,
    toolchain,
  );
  if (!sameReasons(provenance.replay.reasons, expectedReasons)) {
    throw new Error("provenance replay reasons do not match the recorded inputs");
  }
  const expectedStatus = expectedReasons.length === 0 ? "stable" : "tainted";
  if (provenance.replay.status !== expectedStatus) {
    throw new Error(`provenance replay status must be ${expectedStatus}`);
  }
}

export async function collectProvenance(options: CollectProvenanceOptions & { toolchain: ToolchainDrift }): Promise<ProvenanceEvidenceV3>;
export async function collectProvenance(options: CollectProvenanceOptions): Promise<ProvenanceEvidence>;
export async function collectProvenance(options: CollectProvenanceOptions): Promise<ProvenanceEvidence | ProvenanceEvidenceV3> {
  validateSourceRevision(options.sourceRevision);
  if (options.ckbBinary.expectedArchiveSha256 !== options.ckbBinary.archiveSha256) {
    throw new Error("CKB archive provenance mismatch");
  }

  const [packageJsonBytes, lockfileBytes] = await Promise.all([
    readOptionalFile(join(options.projectRoot, "package.json")),
    readOptionalFile(join(options.projectRoot, "bun.lock")),
  ]);
  const requestedVersion = runtimePin(packageJsonBytes);
  const observedVersion = options.observedRuntimeVersion ?? Bun.version;
  const lockfileSha256 = lockfileBytes === null ? null : sha256Bytes(lockfileBytes);
  const reasons = replayReasons(
    options.replayDependencies,
    options.sourceRevision,
    { requestedVersion, observedVersion },
    lockfileSha256,
    options.toolchain,
  );

  const status: "stable" | "tainted" = reasons.length === 0 ? "stable" : "tainted";
  const base = {
    replay: {
      declaredDependencies: [...options.replayDependencies],
      status,
      reasons,
    },
    source: { ...options.sourceRevision },
    manifest: { sha256: sha256Bytes(options.manifestBytes) },
    lockfile: { path: "bun.lock" as const, sha256: lockfileSha256 },
    runtime: {
      name: "bun" as const,
      requestedVersion,
      observedVersion,
      metadata: {
        path: "package.json" as const,
        sha256: packageJsonBytes === null ? null : sha256Bytes(packageJsonBytes),
      },
    },
    binaries: { ckb: { ...options.ckbBinary }, ckbDebugger: options.ckbDebuggerBinary ?? null },
  };
  const provenance: ProvenanceEvidence | ProvenanceEvidenceV3 = options.toolchain === undefined
    ? { schema: "ckb-verify-provenance/2", ...base }
    : { schema: "ckb-verify-provenance/3", ...base, toolchain: { ckb: { ...options.toolchain.ckb } } };
  assertProvenanceConsistency(provenance);
  return provenance;
}
