// Assemble verified evidence bundles and acceptance records into one durable release-evidence archive, or verify one.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleReleaseEvidence, extractReleaseEvidence, flattenProblems, ReleaseEvidenceError, verifyArchiveChecksum, verifyReleaseEvidence,
} from "../src/release-evidence";

function usage(message?: string): never {
  if (message !== undefined) console.error(`release-evidence: ${message}`);
  console.error([
    "usage:",
    "  bun run scripts/release-evidence.ts assemble --out <archive.tar.gz> --bundle <dir> [--bundle <dir>...] [--record <file.md>...]",
    "      --repository owner/repo --source-sha <40 hex> [--run-id <id>] [--run-attempt <n>]",
    "  bun run scripts/release-evidence.ts verify <archive.tar.gz | extracted release-evidence dir> [--source-sha <40 hex>] [--repository owner/repo] [--json]",
  ].join("\n"));
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args.shift();
if (command !== "assemble" && command !== "verify") usage(command === undefined ? "a command is required" : `unknown command: ${command}`);
const single = new Map<string, string>();
const multi = new Map<string, string[]>();
const flags = new Set<string>();
const positional: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (!arg.startsWith("--")) { positional.push(arg); continue; }
  const name = arg.slice(2);
  if (name === "json") { flags.add(name); continue; }
  const value = args[++index];
  if (value === undefined || value.startsWith("--")) usage(`--${name} requires a value`);
  if (name === "bundle" || name === "record") multi.set(name, [...(multi.get(name) ?? []), value]);
  else if (single.has(name)) usage(`--${name} given twice`);
  else single.set(name, value);
}

try {
  if (command === "assemble") {
    if (positional.length > 0) usage(`unexpected argument: ${positional[0]}`);
    const out = single.get("out"), repository = single.get("repository"), sourceSha = single.get("source-sha");
    if (out === undefined || repository === undefined || sourceSha === undefined) usage("--out, --repository, and --source-sha are required");
    if ((multi.get("bundle") ?? []).length === 0) usage("at least one --bundle is required");
    const assembled = await assembleReleaseEvidence({
      bundleDirs: multi.get("bundle")!,
      recordFiles: multi.get("record") ?? [],
      archivePath: out,
      repository,
      sourceSha,
      ...(single.has("run-id") ? { runId: single.get("run-id")! } : {}),
      ...(single.has("run-attempt") ? { runAttempt: single.get("run-attempt")! } : {}),
    });
    console.log(JSON.stringify({
      archive: assembled.archivePath,
      sha256: assembled.sha256,
      bytes: assembled.bytes,
      sourceSha: assembled.manifest.sourceSha,
      runner: assembled.manifest.runner,
      workflow: assembled.manifest.workflow,
      bundles: assembled.manifest.bundles.map((bundle) => ({ name: bundle.name, reports: bundle.reports.length, verdicts: bundle.reports.map((report) => report.verdict) })),
      records: assembled.manifest.records.map((record) => record.name),
    }, null, 2));
  } else {
    if (positional.length !== 1) usage("verify takes exactly one archive or directory");
    const target = positional[0]!;
    const expectations = {
      ...(single.has("source-sha") ? { expectSourceSha: single.get("source-sha")! } : {}),
      ...(single.has("repository") ? { expectRepository: single.get("repository")! } : {}),
    };
    if (expectations.expectSourceSha !== undefined && !/^[0-9a-f]{40}$/.test(expectations.expectSourceSha)) usage("--source-sha must be 40 lowercase hex characters");
    let scratch: string | null = null;
    let archive: { ok: boolean; sha256: string; problems: string[] } | null = null;
    try {
      let root = target;
      if (target.endsWith(".tar.gz")) {
        archive = await verifyArchiveChecksum(target);
        scratch = await mkdtemp(join(tmpdir(), "release-evidence-verify-"));
        root = await extractReleaseEvidence(target, scratch);
      }
      const verification = await verifyReleaseEvidence(root, expectations);
      const ok = verification.ok && (archive === null || archive.ok);
      const problems = [...(archive?.problems ?? []), ...flattenProblems(verification)];
      if (flags.has("json")) {
        console.log(JSON.stringify({ ...verification, ok, archive: archive === null ? null : { path: target, ...archive }, problems: [...(archive?.problems ?? []), ...verification.problems] }, null, 2));
      } else {
        console.log(`${ok ? "VALID" : "INVALID"}: release evidence ${target}`);
        if (archive !== null) console.log(`archive sha256: ${archive.sha256}`);
        if (verification.manifest !== null) {
          console.log(`repository: ${verification.manifest.repository}\nsource: ${verification.manifest.sourceSha}\nrunner: ckb-verify ${verification.manifest.runner.version}\nworkflow run: ${verification.manifest.workflow.runId ?? "unknown"}`);
        }
        for (const bundle of verification.bundles) {
          console.log(`bundle: ${bundle.path} ${bundle.ok ? "ok" : "INVALID"}`);
          for (const report of bundle.reports) console.log(`  report: ${report.path} ${report.ok ? "ok" : "INVALID"} verdict ${report.verdict}`);
        }
        for (const record of verification.records) console.log(`record: ${record.path} ${record.ok ? "ok" : "INVALID"}`);
        for (const problem of problems) console.log(`problem: ${problem}`);
        console.log("Validity means the archive is internally consistent and unaltered; it is not an authenticity signature, and FAIL verdicts stay FAIL.");
      }
      process.exit(ok ? 0 : 1);
    } finally {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true });
    }
  }
} catch (error) {
  if (error instanceof ReleaseEvidenceError) {
    console.error(`release-evidence: refused: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
