import { canonicalSha256 } from "./canonical";
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function verifyEnvironmentContract(value: unknown, evidence: RunEvidence, allowLegacy: boolean): void {
  const environment = record(value, "environment");
  const provenance = record(environment.provenance, "provenance");
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

export function verifyEvidenceDigests(report: {
  verdict: string;
  evidence: RunEvidence;
  outcomeClaims: OutcomeClaims;
  environment: unknown;
  digests: EvidenceDigests;
}, options: { allowLegacy?: boolean } = {}): void {
  try {
    verifyEnvironmentContract(report.environment, report.evidence, options.allowLegacy === true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvidenceIntegrityError(`provenance integrity mismatch: ${detail}`);
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
