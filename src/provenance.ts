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
  const reasons: ProvenanceReason[] = options.replayDependencies.map((dependency) => ({
    scope: "outcome",
    code: dependency,
    detail: `manifest declares replay dependency ${dependency}`,
  }));

  if (options.sourceRevision.gitCommit === null) {
    reasons.push({
      scope: "environment",
      code: "source_revision_unavailable",
      detail: "source git revision is unavailable",
    });
  }
  if (options.sourceRevision.dirty === null) {
    reasons.push({
      scope: "environment",
      code: "source_state_unavailable",
      detail: "source dirty state is unavailable",
    });
  } else if (options.sourceRevision.dirty) {
    reasons.push({
      scope: "environment",
      code: "dirty_source",
      detail: "source tree differs from the recorded git commit",
    });
  }
  if (requestedVersion === null) {
    reasons.push({
      scope: "environment",
      code: "runtime_pin_missing",
      detail: "package.json does not contain an exact bun@x.y.z packageManager pin",
    });
  } else if (requestedVersion !== observedVersion) {
    reasons.push({
      scope: "environment",
      code: "runtime_version_drift",
      detail: `requested bun ${requestedVersion} but observed ${observedVersion}`,
    });
  }
  if (lockfileBytes === null) {
    reasons.push({ scope: "environment", code: "lockfile_missing", detail: "bun.lock is missing" });
  }

  return {
    schema: "ckb-verify-provenance/1",
    replay: {
      declaredDependencies: [...options.replayDependencies],
      status: reasons.length === 0 ? "stable" : "tainted",
      reasons,
    },
    source: { ...options.sourceRevision },
    manifest: { sha256: sha256Bytes(options.manifestBytes) },
    lockfile: { path: "bun.lock", sha256: lockfileBytes === null ? null : sha256Bytes(lockfileBytes) },
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
}
