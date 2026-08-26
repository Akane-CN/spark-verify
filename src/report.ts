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
    claims: Array<Omit<ClaimEvidence, "evidence">>;
  }>;
  assertions: Array<Omit<ClaimEvidence, "evidence">>;
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

function normalizeClaim(claim: ClaimEvidence): Omit<ClaimEvidence, "evidence"> {
  return {
    kind: claim.kind,
    target: claim.target,
    expected: claim.expected,
    observed: claim.observed,
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

export function verifyEvidenceDigests(report: {
  outcomeClaims: OutcomeClaims;
  environment: EnvironmentEvidence;
  digests: EvidenceDigests;
}): void {
  const actualOutcome = canonicalSha256(report.outcomeClaims);
  if (actualOutcome !== report.digests.outcome) {
    throw new EvidenceIntegrityError(`outcome digest mismatch: expected ${report.digests.outcome}, recomputed ${actualOutcome}`);
  }
  const actualEnvironment = canonicalSha256(report.environment);
  if (actualEnvironment !== report.digests.environment) {
    throw new EvidenceIntegrityError(
      `environment digest mismatch: expected ${report.digests.environment}, recomputed ${actualEnvironment}`,
    );
  }
}
