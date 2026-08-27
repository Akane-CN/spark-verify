import { describe, expect, test } from "bun:test";
import {
  EvidenceIntegrityError,
  buildEvidenceDigests,
  buildOutcomeClaims,
  verifyEvidenceDigests,
  type RunEvidence,
} from "../src/report";

function evidence(): RunEvidence {
  return {
    name: "secp-transfer",
    spec: "0.1.0-draft.3",
    steps: [
      {
        name: "transfer",
        expectedStatus: "committed",
        observedStatus: "committed",
        cycles: 1234,
        transactionHash: "0xaaaa",
        durationMs: 25,
        claims: [
          {
            kind: "cell",
            target: { step: "transfer", index: 0 },
            expected: { count: 1 },
            observed: { count: 1 },
            ok: true,
            evidence: { resolvedOutPoint: { txHash: "0xaaaa", index: "0x0" } },
          },
        ],
      },
    ],
    assertions: [],
  };
}

const ENVIRONMENT = {
  schema: "ckb-verify-environment/1" as const,
  runnerVersion: "0.0.1",
  requestedToolchain: { ckb: "0.209.0", offckb: "0.4.13" },
  observedToolchain: { bun: "1.2.19", ckb: "0.209.0", offckb: "0.4.13" },
  source: { commit: "abc123", dirtyDigest: "sha256:clean", repository: "github.com/Akane-CN/spark-verify" },
  manifestSha256: "sha256:manifest",
  platform: { os: "linux", arch: "x64" },
  genesisHash: "0xgenesis",
};

describe("evidence report digests", () => {
  test("excludes raw transaction identity and runtime locations from outcome claims", () => {
    const first = evidence();
    const second = evidence();
    second.steps[0]!.transactionHash = "0xbbbb";
    second.steps[0]!.durationMs = 9_999;
    second.steps[0]!.claims[0]!.evidence = {
      resolvedOutPoint: { txHash: "0xbbbb", index: "0x0" },
      logPath: "/tmp/another-run/rpc.log",
    };

    expect(buildOutcomeClaims(second)).toEqual(buildOutcomeClaims(first));
    expect(buildEvidenceDigests(second, ENVIRONMENT).outcome).toBe(buildEvidenceDigests(first, ENVIRONMENT).outcome);
  });

  test("changes the environment fingerprint for tool version drift only", () => {
    const first = buildEvidenceDigests(evidence(), ENVIRONMENT);
    const drifted = {
      ...ENVIRONMENT,
      observedToolchain: { ...ENVIRONMENT.observedToolchain, ckb: "0.210.0" },
    };
    const second = buildEvidenceDigests(evidence(), drifted);

    expect(second.outcome).toBe(first.outcome);
    expect(second.environment).not.toBe(first.environment);
  });

  test("recomputes both embedded canonical objects and rejects tampering", () => {
    const runEvidence = evidence();
    const outcomeClaims = buildOutcomeClaims(runEvidence);
    const digests = buildEvidenceDigests(runEvidence, ENVIRONMENT);
    const report = { verdict: "PASS", evidence: runEvidence, outcomeClaims, environment: ENVIRONMENT, digests };

    expect(() => verifyEvidenceDigests(report)).not.toThrow();
    expect(() =>
      verifyEvidenceDigests({
        verdict: "PASS",
        evidence: runEvidence,
        outcomeClaims: { ...outcomeClaims, name: "tampered" },
        environment: ENVIRONMENT,
        digests,
      }),
    ).toThrow(EvidenceIntegrityError);
    expect(() => verifyEvidenceDigests({ ...report, verdict: "FAIL" })).toThrow("verdict mismatch");

    const tamperedEvidence = evidence();
    tamperedEvidence.steps[0]!.observedStatus = "rejected";
    expect(() => verifyEvidenceDigests({ ...report, evidence: tamperedEvidence })).toThrow("evidence outcome mismatch");
  });
});
