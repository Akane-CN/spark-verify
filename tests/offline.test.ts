import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256, sha256Bytes } from "../src/canonical";
import { claimDefinition, deriveOutcomeV2, populateEvidenceV2, verdictForOutcomeV2, type ClaimEvidenceV2, type ClaimInputV2, type RunInputV2 } from "../src/cell-claims";
import { parseManifestText } from "../src/manifest";
import { isManifestV4, type ClaimV4 } from "../src/types";
import { main } from "../src/cli";
import { inspectReport, inspectReportFile, validateManifestFile } from "../src/offline";
import { syntheticReportV2 } from "./fixtures/claims-v2/synthetic";

const root = join(import.meta.dir, "..");
const legacySample = join(root, "docs/examples/secp-transfer-committed-report.json");

async function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ckb-verify-offline-"));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function cli(args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const run = main(args, {
    runManifest: async () => { throw new Error("offline commands must never run a manifest"); },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return run.then((exitCode) => ({ exitCode, stdout: stdout.join(""), stderr: stderr.join("") }));
}

describe("validate", () => {
  test("accepts every repository showcase manifest without executing anything", async () => {
    const glob = new Bun.Glob("showcases/*/verify.*.toml");
    let count = 0;
    for await (const relative of glob.scan({ cwd: root })) {
      const validation = await validateManifestFile(join(root, relative));
      expect(validation.ok).toBe(true);
      expect(validation.executed).toBe(false);
      if (validation.ok) {
        expect(validation.manifest.claimCount).toBeGreaterThan(0);
        expect(validation.manifest.requiresDebugger).toBe(validation.manifest.toolchain.ckbDebugger !== null);
      }
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(9);
  });

  test("never runs step commands, even for a valid manifest", () => withDirectory(async (directory) => {
    const sentinel = join(directory, "executed");
    const path = join(directory, "verify.toml");
    await writeFile(path, `[meta]\nname = "sentinel"\nspec = "0.1.0-draft.4"\n\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\n\n` +
      `[replay]\ndependencies = []\n\n[setup]\naccounts = 1\n\n[[step]]\nname = "touch"\nrun = "touch ${sentinel}"\ntimeout = "5s"\nexpect.tx = "committed"\n`);
    const result = await cli(["validate", path]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("VALID: manifest parsed under the strict 0.1.0-draft.4 grammar\n");
    expect(result.stdout).toContain("executed: nothing");
    expect(await Bun.file(sentinel).exists()).toBe(false);
  }));

  test("reports the field path of an unknown key and exits 1", () => withDirectory(async (directory) => {
    const path = join(directory, "verify.toml");
    const text = await readFile(join(root, "showcases/secp-transfer/verify.committed.toml"), "utf8");
    await writeFile(path, text.replace("[setup]\naccounts = 2", "[setup]\naccounts = 2\nextra = true"));
    const result = await cli(["validate", path, "--json"]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.executed).toBe(false);
    expect(parsed.problems.join("\n")).toContain("setup");
    expect(parsed.problems.join("\n")).toContain("extra");
  }));

  test("treats a missing file as invalid input, not as a crash", () => withDirectory(async (directory) => {
    const result = await cli(["validate", join(directory, "absent.toml")]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("does not exist");
  }));

  test("rejects unknown options and extra positionals with exit 2", async () => {
    expect((await cli(["validate", "a.toml", "b.toml"])).exitCode).toBe(2);
    expect((await cli(["validate", "--bogus"])).exitCode).toBe(2);
    expect((await cli(["digest"])).exitCode).toBe(2);
    expect((await cli(["check-digest", legacySample])).exitCode).toBe(2);
    expect((await cli(["check-digest", legacySample, "--outcome", "nothex"])).exitCode).toBe(2);
    expect((await cli(["digest", join(root, "nope.json")])).exitCode).toBe(2);
  });
});

describe("digest and check-digest", () => {
  test("re-derives both digests of a consistent report/2 and keeps validity separate from the verdict", () => {
    const report = syntheticReportV2();
    const inspection = inspectReport(report);
    expect(inspection.ok).toBe(true);
    expect(inspection.valid).toBe(true);
    expect(inspection.verdict).toBe("PASS");
    expect(inspection.digests.recomputed).toEqual(report.digests);
    expect(inspection.replay?.status).toBe("stable");
    expect(inspection.problems).toEqual([]);
  });

  test("a valid FAIL report verifies but is reported as FAIL, never as success", () => {
    const report = syntheticReportV2();
    // Claim a 9-byte minimum that the retained 2-byte data cannot satisfy.
    const text = report.evidence.manifestText.replaceAll("data = { min_bytes = 1 }", "data = { min_bytes = 9 }");
    report.evidence.manifestText = text;
    report.environment.provenance.manifest.sha256 = sha256Bytes(Buffer.from(text));
    const stale = inspectReport(report);
    expect(stale.valid).toBe(false); // the stored projection still claims ok=true: a contradiction, not a FAIL
    expect(stale.problems.join("\n")).toContain("mismatch");

    // Re-derive the projection honestly: the report becomes a valid FAIL.
    const manifest = parseManifestText(text);
    if (!isManifestV4(manifest)) throw new Error("fixture must be draft.4");
    const definition = (claim: ClaimEvidenceV2, declared: ClaimV4): ClaimInputV2 => {
      if (declared.kind === "cell_deps") return claimDefinition(declared);
      if (claim.kind !== "cell") throw new Error("fixture claim order mismatch");
      return { ...claimDefinition(declared), input: claim.input };
    };
    const input: RunInputV2 = { name: report.evidence.name, spec: report.evidence.spec, manifestText: text,
      steps: report.evidence.steps.map((step, index) => ({ ...step,
        claims: step.claims.map((claim, position) => definition(claim, manifest.steps[index]!.assertions[position]!)) })),
      assertions: report.evidence.assertions.map((claim, position) => definition(claim, manifest.assertions[position]!)) };
    const outcome = deriveOutcomeV2(input, report.environment);
    report.outcomeClaims = outcome;
    report.evidence = populateEvidenceV2(input, outcome);
    report.verdict = verdictForOutcomeV2(outcome);
    report.digests = { outcome: canonicalSha256(outcome), environment: canonicalSha256(report.environment) };
    const honest = inspectReport(report, { command: "check-digest", expected: { outcome: report.digests.outcome } });
    expect(honest.valid).toBe(true);
    expect(honest.ok).toBe(true);
    expect(honest.verdict).toBe("FAIL");
    expect(honest.problems).toEqual([]);
  });

  test("tampered observations, verdicts, and recomputed digests are all rejected", () => {
    const tamperedVerdict = syntheticReportV2();
    tamperedVerdict.verdict = "FAIL";
    expect(inspectReport(tamperedVerdict).valid).toBe(false);

    const tamperedObservation = syntheticReportV2();
    (tamperedObservation.outcomeClaims.steps[0]!.claims[0] as { observed: { dataBytes: number } }).observed.dataBytes = 7;
    // Recomputed-hash attack: refresh the stored digests after the edit.
    tamperedObservation.digests = {
      outcome: canonicalSha256(tamperedObservation.outcomeClaims),
      environment: canonicalSha256(tamperedObservation.environment),
    };
    const inspection = inspectReport(tamperedObservation);
    expect(inspection.valid).toBe(false);
    expect(inspection.ok).toBe(false);
    expect(inspection.digests.stored).toEqual(tamperedObservation.digests);

    const tamperedDigest = syntheticReportV2();
    tamperedDigest.digests = { ...tamperedDigest.digests, outcome: `sha256:${"0".repeat(64)}` };
    expect(inspectReport(tamperedDigest).problems.join("\n")).toContain("digests");

    const falselyStable = syntheticReportV2();
    falselyStable.environment.provenance.source.dirty = true;
    expect(inspectReport(falselyStable).valid).toBe(false);

    const wrongSchema = syntheticReportV2();
    (wrongSchema as { schema: string }).schema = "ckb-verify-report/9";
    expect(inspectReport(wrongSchema).problems.join("\n")).toContain("unsupported report schema");
  });

  test("expected digests are compared against the re-derived values", () => {
    const report = syntheticReportV2();
    const matching = inspectReport(report, { command: "check-digest", expected: { outcome: report.digests.outcome } });
    expect(matching.ok).toBe(true);
    expect(matching.expected).toEqual({ outcome: report.digests.outcome, environment: null, outcomeMatches: true, environmentMatches: null });
    const other = `sha256:${"f".repeat(64)}`;
    const mismatch = inspectReport(report, { command: "check-digest", expected: { outcome: report.digests.outcome, environment: other } });
    expect(mismatch.valid).toBe(true);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.expected?.environmentMatches).toBe(false);
    expect(mismatch.problems[0]).toContain("environment digest mismatch");
  });

  test("legacy environment/2 reports require --allow-legacy", async () => {
    const strict = await inspectReportFile(legacySample);
    expect(strict.valid).toBe(false);
    expect(strict.problems.join("\n")).toContain("legacy requires allowLegacy");
    const legacy = await inspectReportFile(legacySample, { allowLegacy: true });
    expect(legacy.valid).toBe(true);
    expect(legacy.schema).toBe("ckb-verify-report/1");
    expect(legacy.runner).toEqual({ name: "ckb-verify", version: "0.0.1" });
    expect(legacy.digests.recomputed).toEqual(legacy.digests.stored);
  });

  test("CLI exit codes and JSON output follow the documented contract", () => withDirectory(async (directory) => {
    const path = join(directory, "report.json");
    const report = syntheticReportV2();
    await writeFile(path, JSON.stringify(report));
    const text = await cli(["digest", path]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toStartWith("VALID: report is internally consistent\n");
    expect(text.stdout).toContain(`outcome: ${report.digests.outcome}\n`);
    expect(text.stdout).toContain("validity is not claim success");

    const json = await cli(["check-digest", path, "--outcome", report.digests.outcome, "--environment", report.digests.environment, "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.command).toBe("check-digest");
    expect(parsed.ok).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.verdict).toBe("PASS");
    expect(parsed.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const mismatch = await cli(["check-digest", path, "--outcome", `sha256:${"e".repeat(64)}`]);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stdout).toContain("expected outcome: MISMATCH");

    report.verdict = "FAIL";
    await writeFile(path, JSON.stringify(report));
    const invalid = await cli(["digest", path, "--json"]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).valid).toBe(false);

    await writeFile(path, "{not json");
    const malformed = await cli(["digest", path]);
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stdout).toContain("not valid JSON");
  }));
});
