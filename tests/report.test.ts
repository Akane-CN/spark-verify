import { describe, expect, test } from "bun:test";
import {
  EvidenceIntegrityError,
  buildEvidenceDigests,
  buildOutcomeClaims,
  verifyEvidenceDigests,
  type EnvironmentEvidence,
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

const SHA256 = `sha256:${"1".repeat(64)}` as `sha256:${string}`;
const ENVIRONMENT: EnvironmentEvidence = {
  schema: "ckb-verify-environment/2",
  runner: { name: "ckb-verify", version: "0.0.1" },
  toolchain: {
    requested: { ckb: "0.209.0", offckb: "0.4.13" },
    observed: { ckb: "0.209.0", offckb: "0.4.13" },
  },
  provenance: {
    schema: "ckb-verify-provenance/1",
    replay: { declaredDependencies: [], status: "stable", reasons: [] },
    source: { gitCommit: "a".repeat(40), dirty: false, dirtyDigest: null },
    manifest: { sha256: SHA256 },
    lockfile: { path: "bun.lock", sha256: SHA256 },
    runtime: {
      name: "bun",
      requestedVersion: "1.2.19",
      observedVersion: "1.2.19",
      metadata: { path: "package.json", sha256: SHA256 },
    },
    binaries: {
      ckb: {
        version: "0.209.0",
        platform: "linux",
        architecture: "x64",
        asset: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
        sourceUrl: "https://github.com/nervosnetwork/ckb/releases/download/v0.209.0/fixture.tar.gz",
        expectedArchiveSha256: SHA256,
        archiveSha256: SHA256,
        binarySha256: SHA256,
      },
    },
  },
  platform: { os: "linux", arch: "x64" },
  devnet: { network: "devnet", genesisHash: "0xgenesis", systemScripts: {} },
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

  test("changes only the environment fingerprint and taints replay for runtime version drift", () => {
    const first = buildEvidenceDigests(evidence(), ENVIRONMENT);
    const drifted = {
      ...ENVIRONMENT,
      provenance: {
        ...ENVIRONMENT.provenance,
        replay: {
          declaredDependencies: [],
          status: "tainted" as const,
          reasons: [
            {
              scope: "environment" as const,
              code: "runtime_version_drift" as const,
              detail: "requested bun 1.2.19 but observed 1.2.20",
            },
          ],
        },
        runtime: { ...ENVIRONMENT.provenance.runtime, observedVersion: "1.2.20" },
      },
    } satisfies EnvironmentEvidence;
    const second = buildEvidenceDigests(evidence(), drifted);

    expect(drifted.provenance.replay.status).toBe("tainted");
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

    const contradictoryEvidence = evidence();
    contradictoryEvidence.steps[0]!.claims = [
      {
        kind: "cell",
        target: { step: "mint", index: 0 },
        expected: { count: 1 },
        observed: { count: 0 },
        ok: true,
      },
    ];
    const contradictoryClaims = buildOutcomeClaims(contradictoryEvidence);
    expect(() =>
      verifyEvidenceDigests({
        verdict: "PASS",
        evidence: contradictoryEvidence,
        outcomeClaims: contradictoryClaims,
        environment: ENVIRONMENT,
        digests: buildEvidenceDigests(contradictoryEvidence, ENVIRONMENT),
      }),
    ).toThrow("Cell claim result mismatch");

    const contradictoryAssertionEvidence = evidence();
    contradictoryAssertionEvidence.assertions = [
      {
        kind: "cell",
        target: { step: "mint", index: 0 },
        expected: { count: 1 },
        observed: { count: 1 },
        ok: false,
      },
    ];
    expect(() =>
      verifyEvidenceDigests({
        verdict: "FAIL",
        evidence: contradictoryAssertionEvidence,
        outcomeClaims: buildOutcomeClaims(contradictoryAssertionEvidence),
        environment: ENVIRONMENT,
        digests: buildEvidenceDigests(contradictoryAssertionEvidence, ENVIRONMENT),
      }),
    ).toThrow("Cell claim result mismatch");
  });
});
