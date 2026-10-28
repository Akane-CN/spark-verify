// Offline inspection of manifests and reports: no chain, no producer code, no network.
import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalSha256, sha256Bytes } from "./canonical";
import { deriveOutcomeV2 } from "./cell-claims";
import { ManifestError } from "./errors";
import { loadManifest } from "./manifest";
import { buildOutcomeClaims, verifyReport, type RunEvidence } from "./report";
import type { Manifest } from "./types";

export interface ManifestStepSummary {
  name: string;
  timeoutMs: number;
  expect: { tx: "committed" | "rejected"; errorCode?: number } | null;
  claims: number;
}

export interface ManifestSummary {
  path: string;
  sha256: string;
  name: string;
  spec: Manifest["meta"]["spec"];
  description: string | null;
  toolchain: { ckb: string; offckb: string; ckbDebugger: string | null };
  replayDependencies: string[];
  accounts: number;
  steps: ManifestStepSummary[];
  finalClaims: number;
  claimCount: number;
  requiresDebugger: boolean;
}

export type ManifestValidation =
  | { command: "validate"; ok: true; executed: false; path: string; manifest: ManifestSummary; problems: [] }
  | { command: "validate"; ok: false; executed: false; path: string; manifest: null; problems: string[] };

/** Parses with the runner's strict grammar; never runs `step.run`, installs tools, or opens sockets. */
export async function validateManifestFile(path: string): Promise<ManifestValidation> {
  const absolute = resolve(path);
  try {
    const { manifest, bytes } = await loadManifest(absolute);
    const steps = manifest.steps.map((step) => ({
      name: step.name,
      timeoutMs: step.timeoutMs,
      expect: step.expect === undefined ? null : {
        tx: step.expect.tx,
        ...(step.expect.error?.code === undefined ? {} : { errorCode: step.expect.error.code }),
      },
      claims: step.assertions.length,
    }));
    const claimCount = steps.reduce((count, step) => count + (step.expect === null ? 0 : 1) + step.claims, manifest.assertions.length);
    return {
      command: "validate", ok: true, executed: false, path: absolute, problems: [],
      manifest: {
        path: absolute,
        sha256: sha256Bytes(bytes),
        name: manifest.meta.name,
        spec: manifest.meta.spec,
        description: manifest.meta.description ?? null,
        toolchain: { ckb: manifest.toolchain.ckb, offckb: manifest.toolchain.offckb, ckbDebugger: manifest.toolchain.ckbDebugger ?? null },
        replayDependencies: [...manifest.replay.dependencies],
        accounts: manifest.setup.accounts,
        steps,
        finalClaims: manifest.assertions.length,
        claimCount,
        requiresDebugger: manifest.toolchain.ckbDebugger !== undefined,
      },
    };
  } catch (error) {
    if (error instanceof ManifestError) {
      return { command: "validate", ok: false, executed: false, path: absolute, manifest: null, problems: [error.message] };
    }
    throw error;
  }
}

export interface DigestPair { outcome: string; environment: string }
export interface ExpectedDigests { outcome?: string; environment?: string }

export interface ReportInspection {
  command: "digest" | "check-digest";
  /** True only when the artifact is internally consistent AND every supplied expected digest matches. */
  ok: boolean;
  /** Internal consistency as established by the strict verifier. Never implies the claims passed. */
  valid: boolean;
  path: string | null;
  sha256: string | null;
  schema: string | null;
  spec: string | null;
  name: string | null;
  /** The recorded claim verdict. Only meaningful when `valid` is true. */
  verdict: "PASS" | "FAIL" | null;
  digests: { stored: DigestPair | null; recomputed: DigestPair | null };
  expected: { outcome: string | null; environment: string | null; outcomeMatches: boolean | null; environmentMatches: boolean | null } | null;
  replay: { status: string; reasons: Array<{ scope: string; code: string; detail: string }> } | null;
  source: { gitCommit: string | null; dirty: boolean | null } | null;
  runner: { name: string; version: string } | null;
  legacyAllowed: boolean;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function digestPair(value: unknown): DigestPair | null {
  if (!isRecord(value) || typeof value.outcome !== "string" || typeof value.environment !== "string") return null;
  return { outcome: value.outcome, environment: value.environment };
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function recomputeDigests(report: Record<string, unknown>): DigestPair | null {
  try {
    const environment = canonicalSha256(report.environment);
    if (report.schema === "ckb-verify-report/2") {
      return { outcome: canonicalSha256(deriveOutcomeV2(report.evidence, report.environment)), environment };
    }
    if (report.schema === "ckb-verify-report/1") {
      return { outcome: canonicalSha256(buildOutcomeClaims(report.evidence as RunEvidence)), environment };
    }
    return null;
  } catch {
    return null; // The strict verifier explains why; a partial recomputation must not look authoritative.
  }
}

/** Pure inspection of a parsed artifact. `path`/`sha256` describe the file when read through `inspectReportFile`. */
export function inspectReport(
  report: unknown,
  options: { command?: "digest" | "check-digest"; allowLegacy?: boolean; expected?: ExpectedDigests; path?: string; sha256?: string } = {},
): ReportInspection {
  const command = options.command ?? "digest";
  const problems: string[] = [];
  const record = isRecord(report) ? report : undefined;
  if (record === undefined) problems.push("report must be a JSON object");
  let valid = false;
  if (record !== undefined) {
    try {
      verifyReport(record, { allowLegacy: options.allowLegacy === true });
      valid = true;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const environment = record !== undefined && isRecord(record.environment) ? record.environment : undefined;
  const provenance = environment !== undefined && isRecord(environment.provenance) ? environment.provenance : undefined;
  const replay = provenance !== undefined && isRecord(provenance.replay) ? provenance.replay : undefined;
  const source = provenance !== undefined && isRecord(provenance.source) ? provenance.source : undefined;
  const runner = environment !== undefined && isRecord(environment.runner) ? environment.runner : undefined;
  const evidence = record !== undefined && isRecord(record.evidence) ? record.evidence : undefined;
  const stored = record === undefined ? null : digestPair(record.digests);
  const recomputed = record === undefined ? null : recomputeDigests(record);
  const verdict = record !== undefined && (record.verdict === "PASS" || record.verdict === "FAIL") ? record.verdict : null;

  let expected: ReportInspection["expected"] = null;
  if (options.expected !== undefined && (options.expected.outcome !== undefined || options.expected.environment !== undefined)) {
    // Compare against the digests the verifier re-derived, never against the stored strings alone.
    const actual = valid ? recomputed : null;
    const compare = (key: keyof DigestPair): boolean | null => {
      const want = options.expected?.[key];
      if (want === undefined) return null;
      if (actual === null) return false;
      return actual[key] === want;
    };
    expected = {
      outcome: options.expected.outcome ?? null,
      environment: options.expected.environment ?? null,
      outcomeMatches: compare("outcome"),
      environmentMatches: compare("environment"),
    };
    for (const key of ["outcome", "environment"] as const) {
      const matches = expected[`${key}Matches`];
      if (matches === false) {
        problems.push(`${key} digest mismatch: expected ${options.expected[key]}, ${valid ? `recomputed ${recomputed?.[key]}` : "report is not internally consistent"}`);
      }
    }
  }

  return {
    command,
    ok: valid && (expected === null || (expected.outcomeMatches !== false && expected.environmentMatches !== false)),
    valid,
    path: options.path ?? null,
    sha256: options.sha256 ?? null,
    schema: record === undefined ? null : optionalString(record.schema),
    spec: evidence === undefined ? null : optionalString(evidence.spec),
    name: evidence === undefined ? null : optionalString(evidence.name),
    verdict,
    digests: { stored, recomputed },
    expected,
    replay: replay === undefined || typeof replay.status !== "string" ? null : {
      status: replay.status,
      reasons: Array.isArray(replay.reasons)
        ? replay.reasons.filter(isRecord).map((reason) => ({
          scope: String(reason.scope), code: String(reason.code), detail: String(reason.detail),
        }))
        : [],
    },
    source: source === undefined ? null : {
      gitCommit: optionalString(source.gitCommit),
      dirty: typeof source.dirty === "boolean" ? source.dirty : null,
    },
    runner: runner === undefined || typeof runner.name !== "string" || typeof runner.version !== "string" ? null
      : { name: runner.name, version: runner.version },
    legacyAllowed: options.allowLegacy === true,
    problems,
  };
}

export class OfflineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineInputError";
  }
}

/** Reads one regular report file. Missing or unreadable inputs are usage errors, not invalid evidence. */
export async function inspectReportFile(
  path: string,
  options: { command?: "digest" | "check-digest"; allowLegacy?: boolean; expected?: ExpectedDigests } = {},
): Promise<ReportInspection> {
  const absolute = resolve(path);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch {
    throw new OfflineInputError(`report file does not exist: ${absolute}`);
  }
  if (!metadata.isFile()) throw new OfflineInputError(`report path is not a regular file: ${absolute}`);
  const bytes = await readFile(absolute);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    const base = inspectReport(null, { ...options, path: absolute, sha256: sha256Bytes(bytes) });
    return { ...base, problems: [`report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return inspectReport(parsed, { ...options, path: absolute, sha256: sha256Bytes(bytes) });
}
