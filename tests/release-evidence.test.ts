import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { packageEvidence } from "../src/evidence-bundle";
import {
  assembleReleaseEvidence, extractReleaseEvidence, flattenProblems, RELEASE_EVIDENCE_ROOT, RELEASE_EVIDENCE_SCHEMA, ReleaseEvidenceError,
  verifyArchiveChecksum, verifyReleaseEvidence,
} from "../src/release-evidence";
import { VERSION } from "../src/version";
import { syntheticReportV2 } from "./fixtures/claims-v2/synthetic";

const SOURCE = "a".repeat(40); // the synthetic report records this source revision
const REPOSITORY = "example/repo";

async function project(root: string, reports: Record<string, unknown>): Promise<string> {
  const projectRoot = join(root, "project");
  for (const [name, report] of Object.entries(reports)) {
    const directory = join(projectRoot, ".ckb-verify", "runs", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "report.json"), JSON.stringify(report));
  }
  return projectRoot;
}

/** Two verified bundles (as two CI jobs of one run would publish) plus one acceptance record. */
async function fixture(): Promise<{ root: string; bundles: string[]; record: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-test-"));
  const bundles: string[] = [];
  for (const job of ["secp-transfer", "cell-properties"]) {
    const projectRoot = await project(join(root, job), { "run-a": syntheticReportV2(), "run-b": syntheticReportV2() });
    const out = join(root, "bundles", `evidence-${job}-${SOURCE}`);
    await packageEvidence({ projectRoot, outDir: out, repository: REPOSITORY, sourceSha: SOURCE,
      workflow: { name: "Verify", job, runId: "41", runAttempt: "1" }, knownSecrets: [], now: new Date("2026-10-30T00:00:00Z") });
    bundles.push(out);
  }
  const record = join(root, "2026-10-30-consumer-matrix.md");
  await writeFile(record, "# Acceptance record\n\n| scenario | result |\n| --- | --- |\n| committed | PASS |\n");
  return { root, bundles, record, archive: join(root, "out", `release-evidence-${SOURCE}.tar.gz`) };
}

const options = (f: Awaited<ReturnType<typeof fixture>>) => ({
  bundleDirs: f.bundles, recordFiles: [f.record], archivePath: f.archive, repository: REPOSITORY, sourceSha: SOURCE, runId: "41", runAttempt: "1",
  now: new Date("2026-10-30T12:00:00Z"),
});

describe("release evidence", () => {
  test("assembles verified bundles and records into one archive that re-extracts and re-verifies", async () => {
    const f = await fixture();
    try {
      const assembled = await assembleReleaseEvidence(options(f));
      expect(assembled.manifest.schema).toBe(RELEASE_EVIDENCE_SCHEMA);
      expect(assembled.manifest.runner).toEqual({ name: "ckb-verify", version: VERSION });
      expect(assembled.manifest.bundles.map((bundle) => bundle.path)).toEqual([`bundles/evidence-secp-transfer-${SOURCE}`, `bundles/evidence-cell-properties-${SOURCE}`]);
      expect(assembled.manifest.bundles[0]!.reports).toHaveLength(2);
      expect(assembled.manifest.records).toEqual([expect.objectContaining({ path: "records/2026-10-30-consumer-matrix.md" })]);
      expect(assembled.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(`${f.archive}.sha256`, "utf8")).toBe(`${assembled.sha256}  release-evidence-${SOURCE}.tar.gz\n`);
      expect((await verifyArchiveChecksum(f.archive)).ok).toBe(true);

      // Reproducible for the same inputs and timestamp.
      const again = await assembleReleaseEvidence({ ...options(f), archivePath: join(f.root, "out", "again.tar.gz") });
      expect(again.sha256).toBe(assembled.sha256);

      const scratch = join(f.root, "extract");
      await mkdir(scratch);
      const extracted = await extractReleaseEvidence(f.archive, scratch);
      expect(extracted).toBe(join(scratch, RELEASE_EVIDENCE_ROOT));
      const sums = (await readFile(join(extracted, "SHA256SUMS"), "utf8")).trim().split("\n");
      expect(sums).toHaveLength(2 * 4 + 1 + 1); // two bundles × (bundle.json, SHA256SUMS, two reports) + record + manifest
      const verification = await verifyReleaseEvidence(extracted, { expectSourceSha: SOURCE, expectRepository: REPOSITORY });
      expect(flattenProblems(verification)).toEqual([]);
      expect(verification.ok).toBe(true);
      expect(verification.bundles.every((bundle) => bundle.ok)).toBe(true);
      expect(verification.records).toEqual([{ path: "records/2026-10-30-consumer-matrix.md", ok: true, problems: [] }]);
      expect((await verifyReleaseEvidence(extracted, { expectSourceSha: "d".repeat(40) })).problems.join("\n")).toContain("does not match expected");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test.each([
    ["a bundle from another source revision", async (f: Awaited<ReturnType<typeof fixture>>) => {
      const bundle = JSON.parse(await readFile(join(f.bundles[1]!, "bundle.json"), "utf8"));
      bundle.sourceSha = "d".repeat(40);
      await writeFile(join(f.bundles[1]!, "bundle.json"), JSON.stringify(bundle));
      return {};
    }, "did not verify"],
    ["a bundle from another workflow run", async () => ({ runId: "42" }), "records workflow run 41, not 42"],
    ["a bundle altered after packaging", async (f: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(f.bundles[0]!, "reports/run-a/report.json");
      await writeFile(path, (await readFile(path, "utf8")).replace('"verdict":"PASS"', '"verdict":"FAIL"'));
      return {};
    }, "did not verify"],
    ["a record carrying a credential marker", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await writeFile(f.record, `# record\n\nGITHUB_TOKEN=ghp_${"Z".repeat(36)}\n`);
      return {};
    }, "GitHub token marker"],
    ["a record that is not Markdown", async (f: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(f.root, "accounts.json");
      await writeFile(path, "{}");
      return { recordFiles: [path] };
    }, "portable .md file name"],
    ["a record that is a symlink", async (f: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(f.root, "linked.md");
      await symlink(f.record, path);
      return { recordFiles: [path] };
    }, "regular unlinked file"],
    ["duplicate bundle names", async (f: Awaited<ReturnType<typeof fixture>>) => ({ bundleDirs: [f.bundles[0]!, f.bundles[0]!] }), "duplicate bundle name"],
    ["no bundles", async () => ({ bundleDirs: [] }), "at least one bundle"],
    ["a malformed source sha", async () => ({ sourceSha: "abc" }), "40-character"],
  ])("refuses %s and leaves no archive behind", async (_label, damage, message) => {
    const f = await fixture();
    try {
      const overrides = await damage(f);
      await expect(assembleReleaseEvidence({ ...options(f), ...overrides })).rejects.toThrow(message);
      await expect(assembleReleaseEvidence({ ...options(f), ...overrides })).rejects.toBeInstanceOf(ReleaseEvidenceError);
      expect(await Bun.file(f.archive).exists()).toBe(false);
      expect(await Bun.file(`${f.archive}.sha256`).exists()).toBe(false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("verification pinpoints alteration, stray files, and manifest drift after extraction", async () => {
    const f = await fixture();
    try {
      await assembleReleaseEvidence(options(f));
      const scratch = join(f.root, "extract");
      await mkdir(scratch);
      const root = await extractReleaseEvidence(f.archive, scratch);
      const manifestPath = join(root, "release-evidence.json");
      const original = await readFile(manifestPath, "utf8");

      const reportPath = join(root, `bundles/evidence-secp-transfer-${SOURCE}/reports/run-a/report.json`);
      const report = await readFile(reportPath, "utf8");
      await writeFile(reportPath, report.replace('"verdict":"PASS"', '"verdict":"FAIL"'));
      let verification = await verifyReleaseEvidence(root);
      expect(verification.ok).toBe(false);
      expect(verification.problems.join("\n")).toContain(`SHA256SUMS mismatch for bundles/evidence-secp-transfer-${SOURCE}/reports/run-a/report.json`);
      expect(verification.bundles[0]!.problems.join("\n")).toContain("checksum");
      await writeFile(reportPath, report);

      await writeFile(join(root, "bundles", "notes.txt"), "stray");
      verification = await verifyReleaseEvidence(root);
      expect(verification.problems).toEqual(expect.arrayContaining(["file is not listed in SHA256SUMS: bundles/notes.txt", "file is not claimed by release-evidence.json: bundles/notes.txt"]));
      await rm(join(root, "bundles", "notes.txt"));

      const manifest = JSON.parse(original);
      manifest.bundles[0].reports[0].verdict = "FAIL";
      await writeFile(manifestPath, JSON.stringify(manifest));
      verification = await verifyReleaseEvidence(root);
      expect(verification.bundles[0]!.problems.join("\n")).toContain("report list differs");
      expect(verification.problems.join("\n")).toContain("SHA256SUMS mismatch for release-evidence.json");

      manifest.bundles[0].reports[0].verdict = "PASS";
      manifest.workflow.runId = "99";
      await writeFile(manifestPath, JSON.stringify(manifest));
      verification = await verifyReleaseEvidence(root);
      expect(verification.bundles[0]!.problems.join("\n")).toContain("differs from release-evidence run 99");

      await writeFile(manifestPath, original);
      await rm(join(root, `bundles/evidence-cell-properties-${SOURCE}`), { recursive: true });
      verification = await verifyReleaseEvidence(root);
      expect(verification.bundles[1]!.ok).toBe(false);
      expect(verification.problems.join("\n")).toContain("SHA256SUMS names an absent file");

      const sidecar = `${f.archive}.sha256`;
      await writeFile(sidecar, `${"0".repeat(64)}  release-evidence-${SOURCE}.tar.gz\n`);
      expect((await verifyArchiveChecksum(f.archive)).problems).toEqual(["archive sha256 differs from its sidecar"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("extraction refuses symlinks, dot-dot paths, and entries outside the root directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-evidence-unsafe-"));
    try {
      const source = join(root, "source", RELEASE_EVIDENCE_ROOT);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "release-evidence.json"), "{}");
      await symlink("/etc/hostname", join(source, "link"));
      const linked = join(root, "linked.tar.gz");
      await tar.c({ gzip: true, cwd: join(root, "source"), file: linked, portable: true }, [RELEASE_EVIDENCE_ROOT]);
      await mkdir(join(root, "out-a"));
      await expect(extractReleaseEvidence(linked, join(root, "out-a"))).rejects.toThrow("unsafe archive entry type symlink");

      await rm(join(source, "link"));
      await mkdir(join(root, "source", "other"));
      await writeFile(join(root, "source", "other", "file.txt"), "outside");
      const outside = join(root, "outside.tar.gz");
      await tar.c({ gzip: true, cwd: join(root, "source"), file: outside, portable: true }, [RELEASE_EVIDENCE_ROOT, "other"]);
      await mkdir(join(root, "out-b"));
      await expect(extractReleaseEvidence(outside, join(root, "out-b"))).rejects.toThrow(`entry outside ${RELEASE_EVIDENCE_ROOT}/`);
      expect(await Bun.file(join(root, "out-b", "other", "file.txt")).exists()).toBe(false);

      await expect(extractReleaseEvidence(join(root, "missing.tar.gz"), join(root, "out-b"))).rejects.toThrow("archive is missing");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("the script assembles and verifies through real processes with documented exit codes", async () => {
    const f = await fixture();
    try {
      const run = (args: string[]) => Bun.spawnSync(["bun", "run", "scripts/release-evidence.ts", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      const assemble = run(["assemble", "--out", f.archive, "--bundle", f.bundles[0]!, "--bundle", f.bundles[1]!, "--record", f.record,
        "--repository", REPOSITORY, "--source-sha", SOURCE, "--run-id", "41", "--run-attempt", "1"]);
      expect(assemble.stderr.toString()).toBe("");
      expect(assemble.exitCode).toBe(0);
      const summary = JSON.parse(assemble.stdout.toString());
      expect(summary.bundles).toEqual([
        { name: `evidence-secp-transfer-${SOURCE}`, reports: 2, verdicts: ["PASS", "PASS"] },
        { name: `evidence-cell-properties-${SOURCE}`, reports: 2, verdicts: ["PASS", "PASS"] },
      ]);

      const verify = run(["verify", f.archive, "--source-sha", SOURCE, "--repository", REPOSITORY]);
      expect(verify.exitCode).toBe(0);
      expect(verify.stdout.toString()).toStartWith(`VALID: release evidence ${f.archive}`);
      expect(verify.stdout.toString()).toContain(`archive sha256: ${summary.sha256}`);
      expect(verify.stdout.toString()).toContain("record: records/2026-10-30-consumer-matrix.md ok");
      const json = run(["verify", f.archive, "--json"]);
      expect(JSON.parse(json.stdout.toString()).ok).toBe(true);

      expect(run(["verify", f.archive, "--source-sha", "d".repeat(40)]).exitCode).toBe(1);
      expect(run(["verify", f.archive, "--source-sha", "short"]).exitCode).toBe(2);
      expect(run(["assemble", "--out", f.archive]).exitCode).toBe(2);
      expect(run(["assemble", "--out", f.archive, "--bundle", f.bundles[0]!, "--repository", REPOSITORY, "--source-sha", SOURCE]).exitCode).toBe(1); // exists
      expect(run([]).exitCode).toBe(2);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 60_000);
});
