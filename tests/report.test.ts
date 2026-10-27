import { describe, expect, test } from "bun:test";
import { canonicalSha256 } from "../src/canonical";
import { debuggerEvidence } from "./debugger-integration-fixture";
import * as reportApi from "../src/report";
import {
  EvidenceIntegrityError,
  buildEvidenceDigests,
  buildOutcomeClaims,
  verifyEvidenceDigests,
  verifyReport,
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

// Synthetic v1 components for verifier tests, not execution/acceptance reports.
function syntheticReport() {
  const run = evidence();
  return {
    schema: "ckb-verify-report/1" as const,
    verdict: "PASS",
    evidence: run,
    outcomeClaims: buildOutcomeClaims(run),
    environment: structuredClone(ENVIRONMENT),
    digests: buildEvidenceDigests(run, ENVIRONMENT),
  };
}

describe("v1 component envelope guard", () => {
  test.each(["synthetic-unsupported-report/999", "ckb-verify-report/2", undefined, null, "", 1])(
    "rejects supplied schema %p even after a component cast",
    (schema) => {
      const report = { ...syntheticReport(), schema } as unknown as Parameters<typeof verifyEvidenceDigests>[0];
      for (const allowLegacy of [false, true]) {
        expect(() => verifyEvidenceDigests(report, { allowLegacy })).toThrow(EvidenceIntegrityError);
      }
    },
  );

  test("accepts current components with the v1 schema or no own schema", () => {
    const { schema: _schema, ...components } = syntheticReport();
    expect(() => verifyEvidenceDigests(syntheticReport())).not.toThrow();
    expect(() => verifyEvidenceDigests(components)).not.toThrow();
  });
});

describe("strict complete-report entrypoint", () => {
  // Detect a missing new API with an assertion, not a named-import failure.
  function verifier() {
    const verify = (reportApi as unknown as {
      verifyReport?: (report: unknown, options?: { allowLegacy?: boolean }) => void;
    }).verifyReport;
    expect(typeof verify).toBe("function");
    return verify!;
  }

  test("requires an explicit own schema while the component helper permits omission", () => {
    const verify = verifier();
    const { schema, ...components } = syntheticReport();
    expect(() => verifyEvidenceDigests(components)).not.toThrow();
    for (const allowLegacy of [false, true]) {
      expect(() => verify(syntheticReport(), { allowLegacy })).not.toThrow();
      expect(() => verify(components, { allowLegacy })).toThrow(EvidenceIntegrityError);
      const inherited = Object.assign(Object.create({ schema }), components);
      expect(() => verify(inherited, { allowLegacy })).toThrow(EvidenceIntegrityError);
    }
  });

  test.each(["ckb-verify-report/2", "unknown", undefined, null, 1])("rejects complete schema %p", (schema) => {
    const verify = verifier();
    for (const allowLegacy of [false, true]) {
      expect(() => verify({ ...syntheticReport(), schema }, { allowLegacy })).toThrow(EvidenceIntegrityError);
    }
  });

  test.each([undefined, null, [], "report", 1, {}, { schema: "ckb-verify-report/1" }].map(value => ({ value })))(
    "normalizes unknown input %p to an integrity error",
    ({ value }) => {
      const verify = verifier();
      expect(() => verify(value)).toThrow(EvidenceIntegrityError);
    },
  );

  test("accepts the historical complete report only with explicit legacy opt-in", async () => {
    const verify = verifier();
    const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
    expect(() => verify(historical)).toThrow(EvidenceIntegrityError);
    expect(() => verify(historical, { allowLegacy: true })).not.toThrow();
  });
});

describe("v1 runtime version tuple", () => {
  const invalidVersions = [undefined, null, "unknown", "0.1.0-draft.4", ""];
  for (const slot of ["both", "evidence", "outcomeClaims"] as const) {
    test.each(invalidVersions)(`rejects ${slot} spec %p before digest derivation`, (spec) => {
      const report = syntheticReport();
      for (const field of slot === "both" ? ["evidence", "outcomeClaims"] as const : [slot]) {
        Object.assign(report[field], { spec });
      }
      report.digests.outcome = canonicalSha256(report.outcomeClaims);
      for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
        for (const allowLegacy of [false, true]) {
          expect(() => verify(report, { allowLegacy })).toThrow("unsupported v1 spec");
        }
      }
    });
  }

  test.each([undefined, null, "ckb-verify-outcome/2", "unknown"])("rejects outcome schema %p before derivation", (schema) => {
    const report = syntheticReport();
    Object.assign(report.outcomeClaims, { schema });
    report.digests.outcome = canonicalSha256(report.outcomeClaims);
    for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
      for (const allowLegacy of [false, true]) {
        expect(() => verify(report, { allowLegacy })).toThrow("unsupported outcome schema");
      }
    }
  });

  test("rejects omitted or inherited nested versions without inference", () => {
    for (const slot of ["evidence", "outcomeClaims", "environment", "provenance"] as const) {
      const field = slot === "evidence" ? "spec" : "schema";
      for (const inherited of [false, true]) {
        const report = syntheticReport();
        const target: Record<string, unknown> = (slot === "provenance" ? report.environment.provenance : report[slot]) as unknown as Record<string, unknown>;
        const original = target[field];
        delete target[field];
        if (inherited) Object.setPrototypeOf(target, { [field]: original });
        report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
        for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
          expect(() => verify(report, { allowLegacy: true })).toThrow(EvidenceIntegrityError);
        }
      }
    }
  });

  test("rejects all unsupported environment/provenance pairs after rehashing", () => {
    for (const env of [undefined, null, "unknown", "ckb-verify-environment/2", "ckb-verify-environment/3", "ckb-verify-environment/4"]) {
      for (const prov of [undefined, null, "unknown", "ckb-verify-provenance/1", "ckb-verify-provenance/2", "ckb-verify-provenance/3"]) {
        if ((env === "ckb-verify-environment/3" && prov === "ckb-verify-provenance/2") ||
            (env === "ckb-verify-environment/2" && prov === "ckb-verify-provenance/1")) continue;
        const report = syntheticReport();
        Object.assign(report.environment, { schema: env });
        Object.assign(report.environment.provenance, { schema: prov });
        report.digests.environment = canonicalSha256(report.environment);
        for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
          for (const allowLegacy of [false, true]) {
            expect(() => verify(report, { allowLegacy })).toThrow(EvidenceIntegrityError);
          }
        }
      }
    }
  });

  test("preserves explicit historical opt-in for schema-less components", async () => {
    const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
    const { schema: _schema, ...components } = historical;
    expect(() => verifyEvidenceDigests(components)).toThrow(EvidenceIntegrityError);
    expect(() => verifyEvidenceDigests(components, { allowLegacy: true })).not.toThrow();
    expect(() => reportApi.verifyReport(components, { allowLegacy: true })).toThrow(EvidenceIntegrityError);
  });
});

describe("v1 retained-evidence marker exclusion", () => {
  for (const slot of ["manifestText", "transaction"] as const) {
    test.each([undefined, null, "synthetic future field", {}])(`rejects evidence ${slot} marker %p`, async (value) => {
      const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
      for (const report of [syntheticReport(), historical]) {
        const target = slot === "manifestText" ? report.evidence : report.evidence.steps[0];
        Object.assign(target, { [slot]: value });
        report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
        for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
          // Current pairs are also exercised with no opt-in; historical only with it.
          for (const allowLegacy of report === historical ? [true] : [false, true]) {
            expect(() => verify(report, { allowLegacy })).toThrow(`unsupported v1 semantic marker: evidence.${slot === "transaction" ? "steps[0]." : ""}${slot}`);
          }
        }
      }
    });
  }
});

describe("v1 claim marker exclusion", () => {
  const markers = ["kind", "input", "expected.type", "expected.data", "expected.contains",
    "observed.state", "observed.status", "observed.type", "observed.dataBytes", "observed.present"];
  for (const source of ["evidence", "outcomeClaims"] as const) {
    for (const location of ["step", "final"] as const) {
      const fields = source === "evidence" ? [...markers, "observationValid"] : markers;
      test.each(fields)(`rejects ${source} ${location} claim marker %s before derivation`, async (marker) => {
        const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
        for (const legacy of [false, true]) {
          for (const value of marker === "kind" ? ["tx", "cell-dep", undefined, null, 1] : [undefined, null, false, {}]) {
            const report = syntheticReport();
            report.evidence.assertions = [structuredClone(report.evidence.steps[0]!.claims[0]!)];
            // Separate copies ensure that an outcome-only edit cannot mutate evidence.
            report.outcomeClaims = structuredClone(buildOutcomeClaims(report.evidence));
            if (legacy) Object.assign(report, { environment: historical.environment });
            const claim = location === "step" ? report[source].steps[0]!.claims[0]! : report[source].assertions[0]!;
            const [part, field] = marker.split(".");
            const target = field === undefined ? claim : claim[part as "expected" | "observed"];
            Object.assign(target, { [field ?? part!]: value });
            report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
            const path = `${source}.${location === "step" ? "steps[0].claims" : "assertions"}[0].${marker}`;
            for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
              for (const allowLegacy of legacy ? [true] : [false, true]) {
                expect(() => verify(report, { allowLegacy })).toThrow(`unsupported v1 semantic marker: ${path}`);
              }
            }
          }
        }
      });
    }
  }

  test("rejects matching new claim semantics even when both objects and hashes agree", () => {
    const report = syntheticReport();
    Object.assign(report.evidence.steps[0]!.claims[0]!.expected, { type: null, data: { len: 0 } });
    report.outcomeClaims = buildOutcomeClaims(report.evidence);
    report.digests = buildEvidenceDigests(report.evidence, report.environment);
    for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) {
      expect(() => verify(report)).toThrow("unsupported v1 semantic marker");
    }
  });

  test("preserves nested raw diagnostics, v1 count greater than one, and outcome observationValid", () => {
    for (const observationValid of [true, false]) {
      const report = syntheticReport();
      const claim = report.evidence.steps[0]!.claims[0]!;
      claim.expected.count = 2;
      claim.observed.count = 2;
      claim.ok = observationValid;
      claim.evidence = {
        ...(observationValid ? {} : { reason: "output-index-out-of-range" }),
        type: null, data: "0x", status: "live",
        nested: [{ kind: "tx", input: 1, observationValid: false, manifestText: "diagnostic",
          transaction: {}, expected: { type: null, data: {}, contains: [] },
          observed: { state: "unknown", status: "live", type: null, dataBytes: 0, present: false } }],
      };
      report.evidence.assertions = [structuredClone(claim)];
      report.outcomeClaims = buildOutcomeClaims(report.evidence);
      report.verdict = observationValid ? "PASS" : "FAIL";
      report.digests = buildEvidenceDigests(report.evidence, report.environment);
      expect(report.outcomeClaims.assertions[0]!.observationValid).toBe(observationValid);
      for (const verify of [verifyEvidenceDigests, reportApi.verifyReport]) expect(() => verify(report)).not.toThrow();
    }
  });

  test("preserves the checked sample's deep type/data/status diagnostics without stripping them", async () => {
    const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
    const response = historical.evidence.steps[0].claims[0].evidence.response;
    expect(response.cell.output.type).toBeNull();
    expect(response.cell.data.content).toBe("0x");
    expect(response.status).toBe("live");
    const before = structuredClone(historical);
    reportApi.verifyReport(historical, { allowLegacy: true });
    const { schema: _schema, ...components } = historical;
    verifyEvidenceDigests(components, { allowLegacy: true });
    expect(historical).toEqual(before);
  });
});

describe("strict v1 semantic preservation", () => {
  test.each([
    ["stored outcome digest", "outcome digest mismatch"],
    ["retained evidence", "evidence outcome mismatch"],
    ["stored environment digest", "environment digest mismatch"],
    ["verdict", "verdict mismatch"],
    ["provenance", "provenance integrity mismatch"],
    ["debugger", "debugger"],
    ["step count", "Cell claim result mismatch"],
    ["final count", "Cell claim result mismatch"],
  ])("still rejects contradictory %s through the complete API", (variant, message) => {
    const report = syntheticReport();
    if (variant === "stored outcome digest") report.outcomeClaims.name = "tampered";
    if (variant === "retained evidence") report.evidence.name = "tampered";
    if (variant === "stored environment digest") report.environment.runner.version = "tampered";
    if (variant === "verdict") report.verdict = "FAIL";
    if (variant === "provenance") {
      report.environment.provenance.runtime.observedVersion = "1.2.20";
      report.digests.environment = canonicalSha256(report.environment);
    }
    if (variant === "debugger") {
      report.environment.toolchain.requested.ckbDebugger = "1.1.1";
      report.digests.environment = canonicalSha256(report.environment);
    }
    if (variant === "step count" || variant === "final count") {
      const claim = structuredClone(report.evidence.steps[0]!.claims[0]!);
      claim.expected.count = 2;
      if (variant === "step count") report.evidence.steps[0]!.claims = [claim];
      else report.evidence.assertions = [claim];
      report.outcomeClaims = buildOutcomeClaims(report.evidence);
      report.digests = buildEvidenceDigests(report.evidence, report.environment);
    }
    expect(() => verifyReport(report)).toThrow(EvidenceIntegrityError);
    expect(() => verifyReport(report)).toThrow(message!);
  });

  test("preserves schema-less historical count-greater-than-one PASS and FAIL semantics", async () => {
    const historical = await Bun.file(new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url)).json();
    // Synthetic variations of the retained v1 fixture, never new execution evidence.
    for (const observed of [2, 3]) {
      const report = structuredClone(historical);
      const claim = report.evidence.steps[0].claims[0];
      claim.expected.count = 2;
      claim.observed.count = observed;
      claim.ok = observed === 2;
      report.evidence.assertions = [structuredClone(claim)];
      report.outcomeClaims = buildOutcomeClaims(report.evidence);
      report.digests = buildEvidenceDigests(report.evidence, report.environment);
      report.verdict = claim.ok ? "PASS" : "FAIL";
      expect(() => verifyReport(report, { allowLegacy: true })).not.toThrow();
      const { schema: _schema, ...components } = report;
      expect(() => verifyEvidenceDigests(components, { allowLegacy: true })).not.toThrow();
    }
  });
});

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
    expect(() => verifyReport(historical)).toThrow(EvidenceIntegrityError);
    expect(() => verifyReport(historical, { allowLegacy: true })).not.toThrow();
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
