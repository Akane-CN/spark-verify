import { canonicalSha256 } from "./canonical";
import { bindManifestV2, deriveOutcomeV2, equalSemantic, verdictForOutcomeV2, verifyStoredClaimsV2 } from "./cell-claims";
import type { ResolvedSystemScripts } from "./offckb";
import { assertProvenanceConsistency, type ProvenanceEvidence, type LegacyProvenanceEvidence } from "./provenance";
import type { ManifestToolchain, TransactionExpectation } from "./types";

export interface ClaimEvidence {
  kind: "cell";
  target: { step: string; index: number };
  expected: { count: number };
  observed: { count: number };
  ok: boolean;
  evidence?: Record<string, unknown>;
}

export interface RejectionEvidence {
  kind: "script" | "node";
  reason?: string;
  rpcCode?: number;
  code?: number;
  role?: "lock" | "type";
  source?: { cell: "input" | "output"; index: number };
  script?: { codeHash: string; hashType: string; args: string };
  scriptHash?: string;
}

export interface StepEvidence {
  name: string;
  expectedStatus?: TransactionExpectation;
  expectedErrorCode?: number;
  observedStatus?: TransactionExpectation;
  cycles?: number;
  rejection?: RejectionEvidence;
  transactionHash?: string;
  durationMs: number;
  claims: ClaimEvidence[];
}

export interface RunEvidence {
  name: string;
  spec: string;
  steps: StepEvidence[];
  assertions: ClaimEvidence[];
}

export interface OutcomeClaim extends Omit<ClaimEvidence, "evidence"> {
  observationValid: boolean;
}

export interface OutcomeClaims {
  schema: "ckb-verify-outcome/1";
  name: string;
  spec: string;
  steps: Array<{
    name: string;
    expectedStatus?: TransactionExpectation;
    expectedErrorCode?: number;
    observedStatus?: TransactionExpectation;
    cycles?: number;
    rejection?: RejectionEvidence;
    claims: OutcomeClaim[];
  }>;
  assertions: OutcomeClaim[];
}

export interface LegacyEnvironmentEvidence {
  schema: "ckb-verify-environment/2";
  runner: {
    name: "ckb-verify";
    version: string;
  };
  toolchain: {
    requested: ManifestToolchain;
    observed: {
      ckb: string;
      offckb: "0.4.13";
      ckbDebugger?: string;
    };
  };
  provenance: LegacyProvenanceEvidence;
  platform: {
    os: NodeJS.Platform;
    arch: string;
  };
  devnet: {
    network: "devnet";
    genesisHash: string;
    systemScripts: ResolvedSystemScripts;
  };
}

export interface EnvironmentEvidence extends Omit<LegacyEnvironmentEvidence, "schema" | "provenance"> {
  schema: "ckb-verify-environment/3";
  provenance: ProvenanceEvidence;
}

export interface EvidenceDigests {
  outcome: string;
  environment: string;
}

export class EvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

function normalizeClaim(claim: ClaimEvidence): OutcomeClaim {
  return {
    kind: claim.kind,
    target: claim.target,
    expected: claim.expected,
    observed: claim.observed,
    observationValid: claim.evidence?.reason !== "output-index-out-of-range",
    ok: claim.ok,
  };
}

export function buildOutcomeClaims(evidence: RunEvidence): OutcomeClaims {
  return {
    schema: "ckb-verify-outcome/1",
    name: evidence.name,
    spec: evidence.spec,
    steps: evidence.steps.map((step) => ({
      name: step.name,
      ...(step.expectedStatus === undefined ? {} : { expectedStatus: step.expectedStatus }),
      ...(step.expectedErrorCode === undefined ? {} : { expectedErrorCode: step.expectedErrorCode }),
      ...(step.observedStatus === undefined ? {} : { observedStatus: step.observedStatus }),
      ...(step.cycles === undefined ? {} : { cycles: step.cycles }),
      ...(step.rejection === undefined ? {} : { rejection: step.rejection }),
      claims: step.claims.map(normalizeClaim),
    })),
    assertions: evidence.assertions.map(normalizeClaim),
  };
}

export function buildEvidenceDigests(evidence: RunEvidence, environment: EnvironmentEvidence | LegacyEnvironmentEvidence): EvidenceDigests {
  return {
    outcome: canonicalSha256(buildOutcomeClaims(evidence)),
    environment: canonicalSha256(environment),
  };
}

function cellClaimPassed(claim: OutcomeClaim): boolean {
  const derived = claim.observationValid && claim.expected.count === claim.observed.count;
  if (claim.ok !== derived) {
    throw new EvidenceIntegrityError(
      `Cell claim result mismatch for ${claim.target.step}[${claim.target.index}]: expected ok=${derived}, observed ok=${claim.ok}`,
    );
  }
  return derived;
}

export function verdictForOutcomeClaims(outcomeClaims: OutcomeClaims): "PASS" | "FAIL" {
  const stepClaimsPassed = outcomeClaims.steps.map((step) => step.claims.map(cellClaimPassed).every(Boolean));
  const assertionsPassed = outcomeClaims.assertions.map(cellClaimPassed).every(Boolean);
  const passed =
    outcomeClaims.steps.every(
      (step, index) =>
        (step.expectedStatus === undefined || step.expectedStatus === step.observedStatus) &&
        (step.expectedErrorCode === undefined || step.expectedErrorCode === step.rejection?.code) &&
        stepClaimsPassed[index] === true,
    ) && assertionsPassed;
  return passed ? "PASS" : "FAIL";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EvidenceIntegrityError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function verifyEnvironmentContract(value: unknown, evidence: { steps: Array<Pick<StepEvidence, "rejection" | "expectedStatus">> }, allowLegacy: boolean): void {
  const environment = record(value, "environment");
  const provenance = record(environment.provenance, "provenance");
  if (!Object.hasOwn(environment, "schema") || !Object.hasOwn(provenance, "schema")) {
    throw new Error("explicit environment/provenance schemas required");
  }
  const current = environment.schema === "ckb-verify-environment/3" && provenance.schema === "ckb-verify-provenance/2";
  const historical = environment.schema === "ckb-verify-environment/2" && provenance.schema === "ckb-verify-provenance/1";
  if (!current && !(allowLegacy && historical)) throw new Error("unsupported environment/provenance pair (legacy requires allowLegacy)");
  assertProvenanceConsistency(provenance, { allowLegacy: historical && allowLegacy });
  if (provenance.schema === "ckb-verify-provenance/1") return; // No retroactive artifact claim.
  const toolchain = record(environment.toolchain, "toolchain");
  const requested = record(toolchain.requested, "requested toolchain");
  const observed = record(toolchain.observed, "observed toolchain");
  const binary = provenance.binaries.ckbDebugger;
  if (binary === null) {
    if ("ckbDebugger" in requested || "ckbDebugger" in observed ||
        evidence.steps.some(step => step.rejection?.kind === "script" || step.expectedStatus === "rejected")) {
      throw new Error("requested or used debugger requires binary identity");
    }
  } else {
    // assertProvenanceConsistency already checked every identity against source
    // pins, including requested/binary version equality. Never use host defaults.
    const platform = record(environment.platform, "recorded platform");
    if (requested.ckbDebugger !== binary.version || observed.ckbDebugger !== `ckb-debugger ${binary.version}` ||
        platform.os !== binary.platform || platform.arch !== binary.architecture) {
      throw new Error("debugger versions or recorded platform contradict binary identity");
    }
  }
}

function rejectV1Markers(value: Record<string, unknown>, label: string, fields: readonly string[]): void {
  for (const field of fields) {
    if (Object.hasOwn(value, field)) {
      throw new EvidenceIntegrityError(`unsupported v1 semantic marker: ${label}.${field}`);
    }
  }
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new EvidenceIntegrityError(`${label} must be an array`);
  return value;
}

function verifyV1Claims(value: unknown, label: string, rawEvidence: boolean): void {
  array(value, label).forEach((value, index) => {
    const path = `${label}[${index}]`;
    const claim = record(value, path);
    if (claim.kind !== "cell") throw new EvidenceIntegrityError(`unsupported v1 semantic marker: ${path}.kind`);
    rejectV1Markers(claim, path, rawEvidence ? ["input", "observationValid"] : ["input"]);
    rejectV1Markers(record(claim.expected, `${path}.expected`), `${path}.expected`, ["type", "data", "contains"]);
    rejectV1Markers(record(claim.observed, `${path}.observed`), `${path}.observed`, ["state", "status", "type", "dataBytes", "present"]);
    // Do not recurse into claim.evidence: historical RPC diagnostics may use all
    // these names. Outcome observationValid also already belongs to v1.
  });
}

/** Complete-artifact version/semantic verification, not a deep JSON schema. */
export function verifyReport(report: unknown, options: { allowLegacy?: boolean } = {}): void {
  try {
    const artifact = record(report, "report");
    if (!Object.hasOwn(artifact, "schema")) throw new EvidenceIntegrityError("explicit report schema required");
    if (artifact.schema === "ckb-verify-report/2") {
      // Check only fields consumed by this branch; this is not a full envelope schema.
      const retained = (value: object, keys: string[], path: string): void => {
        // The report/2 container itself must survive JSON, not just its members.
        for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
          if (descriptor === undefined) continue;
          if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value === "function") {
            throw new EvidenceIntegrityError(`${path}.toJSON: serialization hook not supported`);
          }
          break;
        }
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            throw new EvidenceIntegrityError(`${path}.${key}: required own enumerable data member`);
          }
        }
      };
      retained(artifact, ["schema", "evidence", "outcomeClaims", "environment", "verdict", "digests"], "report");
      const evidence = record(artifact.evidence, "evidence"), outcome = record(artifact.outcomeClaims, "outcomeClaims");
      const environment = record(artifact.environment, "environment"), provenance = record(environment.provenance, "provenance");
      retained(environment, ["schema"], "environment");
      retained(provenance, ["schema"], "provenance");
      if (!Object.hasOwn(outcome, "schema") || outcome.schema !== "ckb-verify-outcome/2" ||
          !Object.hasOwn(evidence, "spec") || evidence.spec !== "0.1.0-draft.4" ||
          !Object.hasOwn(outcome, "spec") || outcome.spec !== "0.1.0-draft.4" ||
          !Object.hasOwn(environment, "schema") || environment.schema !== "ckb-verify-environment/3" ||
          !Object.hasOwn(provenance, "schema") || provenance.schema !== "ckb-verify-provenance/2") {
        throw new EvidenceIntegrityError("unsupported report/2 version tuple");
      }
      bindManifestV2(evidence, environment);
      const derived = deriveOutcomeV2(evidence, environment);
      verifyEnvironmentContract(environment, derived, false);
      verifyStoredClaimsV2(evidence, derived);
      equalSemantic(outcome, derived, "outcomeClaims");
      equalSemantic(artifact.verdict, verdictForOutcomeV2(derived), "verdict");
      equalSemantic(artifact.digests, { outcome: canonicalSha256(derived), environment: canonicalSha256(environment) }, "digests");
      return;
    }
    if (artifact.schema !== "ckb-verify-report/1") throw new EvidenceIntegrityError("unsupported report schema");
    verifyEvidenceDigests(artifact as unknown as Parameters<typeof verifyEvidenceDigests>[0], options);
  } catch (error) {
    if (error instanceof EvidenceIntegrityError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvidenceIntegrityError(`report integrity mismatch: ${detail}`);
  }
}

export function verifyEvidenceDigests(report: {
  schema?: "ckb-verify-report/1";
  verdict: string;
  evidence: RunEvidence;
  outcomeClaims: OutcomeClaims;
  environment: unknown;
  digests: EvidenceDigests;
}, options: { allowLegacy?: boolean } = {}): void {
  record(report, "report components");
  if (Object.hasOwn(report, "schema") && report.schema !== "ckb-verify-report/1") {
    throw new EvidenceIntegrityError("unsupported report schema: expected ckb-verify-report/1");
  }
  const evidence = record(report.evidence, "evidence");
  const outcome = record(report.outcomeClaims, "outcomeClaims");
  if (!Object.hasOwn(outcome, "schema") || outcome.schema !== "ckb-verify-outcome/1") {
    throw new EvidenceIntegrityError("unsupported outcome schema: expected ckb-verify-outcome/1");
  }
  if (!Object.hasOwn(evidence, "spec") || evidence.spec !== "0.1.0-draft.3" ||
      !Object.hasOwn(outcome, "spec") || outcome.spec !== "0.1.0-draft.3") {
    throw new EvidenceIntegrityError("unsupported v1 spec: evidence and outcomeClaims require 0.1.0-draft.3");
  }
  try {
    verifyEnvironmentContract(report.environment, report.evidence, options.allowLegacy === true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvidenceIntegrityError(`provenance integrity mismatch: ${detail}`);
  }
  rejectV1Markers(evidence, "evidence", ["manifestText"]);
  for (const [label, material] of [["evidence", evidence], ["outcomeClaims", outcome]] as const) {
    const rawEvidence = label === "evidence";
    array(material.steps, `${label}.steps`).forEach((value, index) => {
      const path = `${label}.steps[${index}]`;
      const step = record(value, path);
      if (rawEvidence) rejectV1Markers(step, path, ["transaction"]);
      verifyV1Claims(step.claims, `${path}.claims`, rawEvidence);
    });
    verifyV1Claims(material.assertions, `${label}.assertions`, rawEvidence);
  }
  const actualOutcome = canonicalSha256(report.outcomeClaims);
  if (actualOutcome !== report.digests.outcome) {
    throw new EvidenceIntegrityError(`outcome digest mismatch: expected ${report.digests.outcome}, recomputed ${actualOutcome}`);
  }
  const evidenceOutcome = canonicalSha256(buildOutcomeClaims(report.evidence));
  if (evidenceOutcome !== report.digests.outcome) {
    throw new EvidenceIntegrityError(
      `evidence outcome mismatch: expected ${report.digests.outcome}, recomputed ${evidenceOutcome}`,
    );
  }
  const expectedVerdict = verdictForOutcomeClaims(report.outcomeClaims);
  if (report.verdict !== expectedVerdict) {
    throw new EvidenceIntegrityError(`verdict mismatch: expected ${expectedVerdict}, observed ${report.verdict}`);
  }
  const actualEnvironment = canonicalSha256(report.environment);
  if (actualEnvironment !== report.digests.environment) {
    throw new EvidenceIntegrityError(
      `environment digest mismatch: expected ${report.digests.environment}, recomputed ${actualEnvironment}`,
    );
  }
}
