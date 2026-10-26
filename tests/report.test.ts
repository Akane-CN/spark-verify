import { describe, expect, test } from "bun:test";
import { canonicalSha256 } from "../src/canonical";
import { debuggerEvidence } from "./debugger-integration-fixture";
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
  schema: "ckb-verify-environment/3",
  runner: { name: "ckb-verify", version: "0.0.1" },
  toolchain: {
    requested: { ckb: "0.209.0", offckb: "0.4.13" },
    observed: { ckb: "0.209.0", offckb: "0.4.13" },
  },
  provenance: {
    schema: "ckb-verify-provenance/2",
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
      ckbDebugger: null,
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
  test("debugger identity contradictions cannot be waived by taint or recomputed digests", () => {
    const environment = structuredClone(ENVIRONMENT);
    environment.toolchain.requested.ckbDebugger = "1.1.1";
    environment.toolchain.observed.ckbDebugger = "ckb-debugger 1.1.1";
    environment.provenance.binaries.ckbDebugger = debuggerEvidence();
    const e = evidence();
    const verify = (env: unknown, run = e) => verifyEvidenceDigests({ verdict: "PASS", evidence: run,
      outcomeClaims: buildOutcomeClaims(run), environment: env,
      digests: { outcome: canonicalSha256(buildOutcomeClaims(run)), environment: canonicalSha256(env) } });
    expect(() => verify(environment)).not.toThrow();
    for (const mutate of [
      (v: any) => { delete v.toolchain.requested.ckbDebugger; },
      (v: any) => { delete v.toolchain.observed.ckbDebugger; },
      (v: any) => { delete v.provenance.binaries.ckbDebugger; },
      (v: any) => { v.provenance.binaries.ckbDebugger = null; },
      (v: any) => { v.toolchain.requested.ckbDebugger = "1.1.2"; },
      (v: any) => { v.toolchain.observed.ckbDebugger = "ckb-debugger 1.1.1 extra"; },
      (v: any) => { v.platform.os = "darwin"; },
      (v: any) => { v.platform.arch = "arm64"; },
      (v: any) => { v.provenance.binaries.ckbDebugger.executable.observed.bytes--; },
      (v: any) => { v.provenance.binaries.ckbDebugger.archive.expected.sha256 = `sha256:${"0".repeat(64)}`; },
    ]) {
      for (const tainted of [false, true]) {
        const bad = structuredClone(environment);
        if (tainted) {
          bad.provenance.replay = { status: "tainted", declaredDependencies: ["external_network"],
            reasons: [{ scope: "outcome", code: "external_network", detail: "manifest declares replay dependency external_network" }] };
        }
        mutate(bad);
        expect(() => verify(bad)).toThrow(EvidenceIntegrityError);
      }
    }
    const script = evidence(); script.steps[0]!.rejection = { kind: "script", code: -11 };
    expect(() => verify(ENVIRONMENT, script)).toThrow("debugger");
    // The verifier host is irrelevant: only the recorded platform selects pins.
    const descriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { ...descriptor, value: "arm64" });
    try { expect(() => verify(environment)).not.toThrow(); }
    finally { Object.defineProperty(process, "arch", descriptor); }
  });
  test("dispatches exactly current or explicitly opted-in historical contract pairs", async () => {
    const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
    expect(() => verifyEvidenceDigests(historical)).toThrow();
    expect(() => verifyEvidenceDigests(historical, { allowLegacy: true })).not.toThrow();
    const e = evidence();
    for (const [env, prov] of [["ckb-verify-environment/3", "ckb-verify-provenance/1"],
      ["ckb-verify-environment/2", "ckb-verify-provenance/2"], ["ckb-verify-environment/4", "ckb-verify-provenance/2"],
      ["ckb-verify-environment/3", "ckb-verify-provenance/3"]]) {
      const environment = { ...ENVIRONMENT, schema: env, provenance: { ...ENVIRONMENT.provenance, schema: prov } };
      const report = { verdict: "PASS", evidence: e, outcomeClaims: buildOutcomeClaims(e), environment,
        digests: { outcome: canonicalSha256(buildOutcomeClaims(e)), environment: canonicalSha256(environment) } };
      for (const allowLegacy of [false, true]) expect(() => verifyEvidenceDigests(report, { allowLegacy })).toThrow();
    }
  });
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

  test("rejects replay qualifications that contradict provenance inputs even when digests are recomputed", () => {
    const runEvidence = evidence();
    const outcomeClaims = buildOutcomeClaims(runEvidence);
    const contradictoryEnvironments: EnvironmentEvidence[] = [];

    const stableRuntimeDrift = structuredClone(ENVIRONMENT);
    stableRuntimeDrift.provenance.runtime.observedVersion = "1.2.20";
    contradictoryEnvironments.push(stableRuntimeDrift);

    const falseRuntimeTaint = structuredClone(ENVIRONMENT);
    falseRuntimeTaint.provenance.replay = {
      declaredDependencies: [],
      status: "tainted",
      reasons: [
        {
          scope: "environment",
          code: "runtime_version_drift",
          detail: "requested bun 1.2.19 but observed 1.2.20",
        },
      ],
    };
    contradictoryEnvironments.push(falseRuntimeTaint);

    const mismatchedArchive = structuredClone(ENVIRONMENT);
    mismatchedArchive.provenance.binaries.ckb.archiveSha256 = `sha256:${"2".repeat(64)}`;
    contradictoryEnvironments.push(mismatchedArchive);

    const falseLockfileTaint = structuredClone(ENVIRONMENT);
    falseLockfileTaint.provenance.replay = {
      declaredDependencies: [],
      status: "tainted",
      reasons: [{ scope: "environment", code: "lockfile_missing", detail: "bun.lock is missing" }],
    };
    contradictoryEnvironments.push(falseLockfileTaint);

    const falseDirtySourceTaint = structuredClone(ENVIRONMENT);
    falseDirtySourceTaint.provenance.replay = {
      declaredDependencies: [],
      status: "tainted",
      reasons: [
        {
          scope: "environment",
          code: "dirty_source",
          detail: "source tree differs from the recorded git commit",
        },
      ],
    };
    contradictoryEnvironments.push(falseDirtySourceTaint);

    const undeclaredDependencyReason = structuredClone(ENVIRONMENT);
    undeclaredDependencyReason.provenance.replay = {
      declaredDependencies: [],
      status: "tainted",
      reasons: [
        {
          scope: "outcome",
          code: "external_network",
          detail: "manifest declares replay dependency external_network",
        },
      ],
    };
    contradictoryEnvironments.push(undeclaredDependencyReason);

    const missingDependencyReason = structuredClone(ENVIRONMENT);
    missingDependencyReason.provenance.replay.declaredDependencies = ["external_network"];
    contradictoryEnvironments.push(missingDependencyReason);

    const pinnedRuntimeWithoutMetadata = structuredClone(ENVIRONMENT);
    pinnedRuntimeWithoutMetadata.provenance.runtime.metadata.sha256 = null;
    contradictoryEnvironments.push(pinnedRuntimeWithoutMetadata);

    for (const environment of contradictoryEnvironments) {
      expect(() =>
        verifyEvidenceDigests({
          verdict: "PASS",
          evidence: runEvidence,
          outcomeClaims,
          environment,
          digests: buildEvidenceDigests(runEvidence, environment),
        }),
      ).toThrow(EvidenceIntegrityError);
    }
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
