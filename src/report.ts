import { canonicalSha256 } from "./canonical";
import type { TransactionExpectation } from "./types";

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

export interface EnvironmentEvidence {
  schema: "ckb-verify-environment/1";
  [key: string]: unknown;
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

export function buildEvidenceDigests(evidence: RunEvidence, environment: EnvironmentEvidence): EvidenceDigests {
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

export function verifyEvidenceDigests(report: {
  verdict: string;
  evidence: RunEvidence;
  outcomeClaims: OutcomeClaims;
  environment: EnvironmentEvidence;
  digests: EvidenceDigests;
}): void {
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
