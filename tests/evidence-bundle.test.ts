import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256 } from "../src/canonical";
import { main } from "../src/cli";
import { BUNDLE_SCHEMA, EvidenceBundleError, packageEvidence, scanForSecrets, verifyBundle } from "../src/evidence-bundle";
import { syntheticReportV2 } from "./fixtures/claims-v2/synthetic";

const SOURCE = "a".repeat(40);
const DEV_KEY = `0x${"7e".repeat(32)}`;

async function project(reports: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evidence-project-"));
  for (const [name, report] of Object.entries(reports)) {
    const directory = join(root, ".ckb-verify", "runs", name);
    await mkdir(join(directory, "steps", "01-produce"), { recursive: true });
    await writeFile(join(directory, "steps", "01-produce", "stdout.txt"), "producer noise\n");
    await writeFile(join(directory, "report.json"), JSON.stringify(report));
  }
  return root;
}

function cli(args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  return main(args, {
    runManifest: async () => { throw new Error("never"); },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  }).then((exitCode) => ({ exitCode, stdout: stdout.join(""), stderr: stderr.join("") }));
}

const bundleOptions = (root: string, out: string) => ({ projectRoot: root, outDir: out, repository: "example/repo", sourceSha: SOURCE,
  workflow: { name: "Verify", job: "secp-transfer", runId: "1", runAttempt: "1" }, knownSecrets: [DEV_KEY], now: new Date("2026-10-28T00:00:00Z") });

describe("secret scan", () => {
  test("flags generic markers, URL credentials, private-key field names, and known keys", () => {
    expect(scanForSecrets("plain report text with 0x" + "ab".repeat(32))).toEqual([]);
    expect(scanForSecrets("token ghp_" + "A".repeat(36))).toContain("GitHub token marker present");
    expect(scanForSecrets("https://user:pa55word@rpc.example/")).toContain("URL credentials marker present");
    expect(scanForSecrets('{"privkey": "0x..."}')).toContain("private-key field name marker present");
    expect(scanForSecrets("GITHUB_TOKEN=abc")).toContain("environment secret marker present");
    expect(scanForSecrets(`found ${DEV_KEY.toUpperCase()}`, [DEV_KEY])).toContain("known development private key present");
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----")).toContain("PEM private key marker present");
  });
});

describe("packageEvidence and verifyBundle", () => {
  test("packages only canonical reports, lists them with checksums, and verifies round-trip", async () => {
    const root = await project({ "run-a": syntheticReportV2(), "run-b": syntheticReportV2() });
    const out = join(root, "bundle");
    try {
      const manifest = await packageEvidence(bundleOptions(root, out));
      expect(manifest.schema).toBe(BUNDLE_SCHEMA);
      expect(manifest.sourceSha).toBe(SOURCE);
      expect(manifest.reports.map((report) => report.path)).toEqual(["reports/run-a/report.json", "reports/run-b/report.json"]);
      expect(await Bun.file(join(out, "reports/run-a/steps/01-produce/stdout.txt")).exists()).toBe(false);
      const sums = await readFile(join(out, "SHA256SUMS"), "utf8");
      expect(sums.split("\n").filter(Boolean)).toHaveLength(3);
      const verification = await verifyBundle(out, { expectSourceSha: SOURCE, expectRepository: "example/repo" });
      expect(verification.problems).toEqual([]);
      expect(verification.reports.every((report) => report.ok)).toBe(true);
      expect(verification.ok).toBe(true);

      const text = await cli(["check-bundle", out, "--source-sha", SOURCE, "--repository", "example/repo"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toStartWith("VALID: evidence bundle");
      expect(text.stdout).toContain("report: reports/run-a/report.json ok verdict PASS");
      const json = await cli(["check-bundle", out, "--json"]);
      expect(JSON.parse(json.stdout).ok).toBe(true);
      expect((await cli(["check-bundle", out, "--source-sha", "b".repeat(40)])).exitCode).toBe(1);
      expect((await cli(["check-bundle", out, "--source-sha", "short"])).exitCode).toBe(2);
      expect((await cli(["check-bundle"])).exitCode).toBe(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each([
    ["pending report", async (root: string) => { await writeFile(join(root, ".ckb-verify/runs/run-a/.report.json.pending"), "{}"); }, "pending report"],
    ["leftover account file", async (root: string) => { await mkdir(join(root, ".ckb-verify/offckb"), { recursive: true }); await writeFile(join(root, ".ckb-verify/offckb/accounts.json"), "{}"); }, "closeout incomplete"],
    ["symlink entry", async (root: string) => { await symlink("/etc/hostname", join(root, ".ckb-verify/runs/run-a/link")); }, "unsupported filesystem entry"],
    ["development key leakage", async (root: string) => {
      const path = join(root, ".ckb-verify/runs/run-a/report.json");
      await writeFile(path, (await readFile(path, "utf8")).replace("synthetic-cell-claims", `leak ${DEV_KEY}`));
    }, "known development private key"],
    ["token marker", async (root: string) => {
      const path = join(root, ".ckb-verify/runs/run-a/report.json");
      await writeFile(path, (await readFile(path, "utf8")).replace("synthetic-cell-claims", "ghp_" + "Q".repeat(36)));
    }, "GitHub token"],
    ["semantic tampering with rehashed digests", async (root: string) => {
      const report = syntheticReportV2();
      (report.outcomeClaims.steps[0]!.claims[0] as { observed: { dataBytes: number } }).observed.dataBytes = 9;
      report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
      await writeFile(join(root, ".ckb-verify/runs/run-a/report.json"), JSON.stringify(report));
    }, "not internally consistent"],
    ["extra top-level field", async (root: string) => {
      const report = { ...syntheticReportV2(), notes: "x" };
      await writeFile(join(root, ".ckb-verify/runs/run-a/report.json"), JSON.stringify(report));
    }, "outside the allowlist"],
    ["wrong source revision", async (root: string) => {
      const report = syntheticReportV2();
      report.environment.provenance.source.gitCommit = "b".repeat(40);
      report.digests.environment = canonicalSha256(report.environment);
      await writeFile(join(root, ".ckb-verify/runs/run-a/report.json"), JSON.stringify(report));
    }, "records source"],
  ])("refuses the whole bundle on %s", async (_label, damage, message) => {
    const root = await project({ "run-a": syntheticReportV2(), "run-b": syntheticReportV2() });
    const out = join(root, "bundle");
    try {
      await damage(root);
      await expect(packageEvidence(bundleOptions(root, out))).rejects.toThrow(message);
      await expect(packageEvidence(bundleOptions(root, out))).rejects.toBeInstanceOf(EvidenceBundleError);
      expect(await Bun.file(join(out, "bundle.json")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("verification rejects a bundle altered after packaging", async () => {
    const root = await project({ "run-a": syntheticReportV2() });
    const out = join(root, "bundle");
    try {
      await packageEvidence(bundleOptions(root, out));
      const path = join(out, "reports/run-a/report.json");
      const original = await readFile(path, "utf8");

      await writeFile(path, original.replace('"verdict":"PASS"', '"verdict":"FAIL"'));
      let verification = await verifyBundle(out);
      expect(verification.ok).toBe(false);
      expect(verification.reports[0]!.problems.join("\n")).toContain("checksum");

      await writeFile(path, original);
      await writeFile(join(out, "reports/run-a/extra.txt"), "stray");
      verification = await verifyBundle(out);
      expect(verification.problems.join("\n")).toContain("not listed");
      await rm(join(out, "reports/run-a/extra.txt"));

      const bundle = JSON.parse(await readFile(join(out, "bundle.json"), "utf8"));
      bundle.reports[0].digests.outcome = `sha256:${"0".repeat(64)}`;
      await writeFile(join(out, "bundle.json"), JSON.stringify(bundle));
      verification = await verifyBundle(out);
      expect(verification.reports[0]!.problems.join("\n")).toContain("outcome digest mismatch");
      expect(verification.problems.join("\n")).toContain("SHA256SUMS mismatch for bundle.json");

      await rm(path);
      verification = await verifyBundle(out);
      expect(verification.reports[0]!.problems.join("\n")).toContain("missing");
      expect(verification.ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
