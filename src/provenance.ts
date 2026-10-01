import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Bytes } from "./canonical";
import type { InstalledCkbBinary } from "./ckb-binary";
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
  | "lockfile_missing";

export interface ProvenanceReason {
  scope: "environment" | "outcome";
  code: ProvenanceReasonCode;
  detail: string;
}

export interface ProvenanceEvidence {
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

export interface CollectProvenanceOptions {
  projectRoot: string;
  manifestBytes: Uint8Array;
  replayDependencies: readonly ReplayDependency[];
  sourceRevision: SourceRevision;
  ckbBinary: Omit<InstalledCkbBinary, "path">;
  observedRuntimeVersion?: string;
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

export function assertProvenanceConsistency(provenance: ProvenanceEvidence): void {
  validateSourceRevision(provenance.source);
  if (provenance.binaries.ckb.expectedArchiveSha256 !== provenance.binaries.ckb.archiveSha256) {
    throw new Error("CKB archive provenance mismatch");
  }
  if (provenance.runtime.requestedVersion !== null && provenance.runtime.metadata.sha256 === null) {
    throw new Error("a pinned Bun runtime must include the package.json digest");
  }
  const expectedReasons = replayReasons(
    provenance.replay.declaredDependencies,
    provenance.source,
    provenance.runtime,
    provenance.lockfile.sha256,
  );
  if (!sameReasons(provenance.replay.reasons, expectedReasons)) {
    throw new Error("provenance replay reasons do not match the recorded inputs");
  }
  const expectedStatus = expectedReasons.length === 0 ? "stable" : "tainted";
  if (provenance.replay.status !== expectedStatus) {
    throw new Error(`provenance replay status must be ${expectedStatus}`);
  }
}

export async function collectProvenance(options: CollectProvenanceOptions): Promise<ProvenanceEvidence> {
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
  );

  const provenance: ProvenanceEvidence = {
    schema: "ckb-verify-provenance/1",
    replay: {
      declaredDependencies: [...options.replayDependencies],
      status: reasons.length === 0 ? "stable" : "tainted",
      reasons,
    },
    source: { ...options.sourceRevision },
    manifest: { sha256: sha256Bytes(options.manifestBytes) },
    lockfile: { path: "bun.lock", sha256: lockfileSha256 },
    runtime: {
      name: "bun",
      requestedVersion,
      observedVersion,
      metadata: {
        path: "package.json",
        sha256: packageJsonBytes === null ? null : sha256Bytes(packageJsonBytes),
      },
    },
    binaries: { ckb: { ...options.ckbBinary } },
  };
  assertProvenanceConsistency(provenance);
  return provenance;
}
