// Release evidence: one durable, checksummed archive assembled from verified CI evidence bundles and acceptance records.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as tar from "tar";
import { assertSafeArchiveEntry, tarEntryKind } from "./ckb-binary";
import { assertOnlyRegularEntries, scanForSecrets, verifyBundle, type BundleManifest } from "./evidence-bundle";
import type { DigestPair } from "./offline";
import { VERSION } from "./version";

export const RELEASE_EVIDENCE_SCHEMA = "ckb-verify-release-evidence/1";
/** Top-level directory inside the archive; every entry lives below it. */
export const RELEASE_EVIDENCE_ROOT = "release-evidence";
export const RELEASE_EVIDENCE_NOTE =
  "This archive is the durable copy of CI evidence for one source revision. Checksums detect alteration; they are not an authenticity signature and do not prove the recorded runs happened. A valid archive may contain valid FAIL reports: read each verdict separately.";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECORD_LIMIT = 1024 * 1024;

export interface ReleaseEvidenceReport { path: string; name: string; verdict: "PASS" | "FAIL"; digests: DigestPair }
export interface ReleaseEvidenceBundleEntry {
  name: string;
  path: string;
  workflow: BundleManifest["workflow"];
  reports: ReleaseEvidenceReport[];
}
export interface ReleaseEvidenceRecordEntry { name: string; path: string; sha256: string }
export interface ReleaseEvidenceManifest {
  schema: typeof RELEASE_EVIDENCE_SCHEMA;
  generatedAt: string;
  repository: string;
  sourceSha: string;
  runner: { name: "ckb-verify"; version: string };
  workflow: { runId: string | null; runAttempt: string | null };
  bundles: ReleaseEvidenceBundleEntry[];
  records: ReleaseEvidenceRecordEntry[];
  note: string;
}

export class ReleaseEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseEvidenceError";
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFileBytes(path: string, label: string): Promise<Buffer> {
  let metadata;
  try { metadata = await lstat(path); } catch { throw new ReleaseEvidenceError(`${label} is missing: ${path}`); }
  if (!metadata.isFile() || metadata.nlink !== 1) throw new ReleaseEvidenceError(`${label} must be a regular unlinked file: ${path}`);
  return readFile(path);
}

export interface AssembleReleaseEvidenceOptions {
  /** Verified evidence bundle directories (each holding `bundle.json`); the directory name becomes the bundle name. */
  bundleDirs: readonly string[];
  /** Acceptance or rehearsal records (`.md`) to carry with the evidence. */
  recordFiles?: readonly string[];
  /** Output archive path ending in `.tar.gz`; must not exist. A `<archive>.sha256` file is written next to it. */
  archivePath: string;
  repository: string;
  sourceSha: string;
  runId?: string;
  runAttempt?: string;
  now?: Date;
}

export interface AssembledReleaseEvidence { manifest: ReleaseEvidenceManifest; archivePath: string; sha256: string; bytes: number }

/** Assembles verified bundles and records into one archive, then re-extracts and re-verifies it before reporting success. */
export async function assembleReleaseEvidence(options: AssembleReleaseEvidenceOptions): Promise<AssembledReleaseEvidence> {
  if (!/^[0-9a-f]{40}$/.test(options.sourceSha)) throw new ReleaseEvidenceError("sourceSha must be a 40-character lowercase hex commit");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(options.repository)) throw new ReleaseEvidenceError("repository must be owner/repo");
  if (options.bundleDirs.length === 0) throw new ReleaseEvidenceError("at least one bundle is required");
  const archivePath = resolve(options.archivePath);
  if (!archivePath.endsWith(".tar.gz")) throw new ReleaseEvidenceError("archive path must end with .tar.gz");
  if (await lstat(archivePath).then(() => true, () => false)) throw new ReleaseEvidenceError(`archive already exists: ${archivePath}`);
  const now = options.now ?? new Date();
  const runId = options.runId ?? null;

  const staging = await mkdtemp(join(tmpdir(), "release-evidence-"));
  try {
    const root = join(staging, RELEASE_EVIDENCE_ROOT);
    await mkdir(root);
    const outputs: Array<{ relativePath: string; bytes: Buffer }> = [];
    const bundles: ReleaseEvidenceBundleEntry[] = [];
    let runnerVersion: string | null = null;
    for (const dir of options.bundleDirs) {
      const bundleDir = resolve(dir);
      const name = basename(bundleDir);
      if (!NAME_PATTERN.test(name)) throw new ReleaseEvidenceError(`bundle directory name is not portable: ${name}`);
      if (bundles.some((entry) => entry.name === name)) throw new ReleaseEvidenceError(`duplicate bundle name: ${name}`);
      const verification = await verifyBundle(bundleDir, { expectSourceSha: options.sourceSha, expectRepository: options.repository });
      if (!verification.ok || verification.bundle === null) {
        const problems = [...verification.problems, ...verification.reports.flatMap((report) => report.problems.map((problem) => `${report.path}: ${problem}`))];
        throw new ReleaseEvidenceError(`bundle ${name} did not verify: ${problems.join("; ")}`);
      }
      runnerVersion ??= verification.bundle.runner.version;
      if (verification.bundle.runner.version !== runnerVersion) {
        throw new ReleaseEvidenceError(`bundle ${name} was produced by runner ${verification.bundle.runner.version}, not ${runnerVersion}`);
      }
      if (runId !== null && verification.bundle.workflow?.runId !== runId) {
        throw new ReleaseEvidenceError(`bundle ${name} records workflow run ${verification.bundle.workflow?.runId ?? "unknown"}, not ${runId}`);
      }
      const manifest = JSON.parse((await readFile(join(bundleDir, "bundle.json"))).toString("utf8")) as BundleManifest;
      for (const file of await assertOnlyRegularEntries(bundleDir)) {
        outputs.push({ relativePath: `bundles/${name}/${relative(bundleDir, file).replaceAll("\\", "/")}`, bytes: await readFile(file) });
      }
      bundles.push({
        name,
        path: `bundles/${name}`,
        workflow: manifest.workflow,
        reports: manifest.reports.map((report) => ({ path: report.path, name: report.name, verdict: report.verdict, digests: report.digests })),
      });
    }
    const records: ReleaseEvidenceRecordEntry[] = [];
    for (const file of options.recordFiles ?? []) {
      const path = resolve(file);
      const name = basename(path);
      if (!NAME_PATTERN.test(name) || !name.endsWith(".md")) throw new ReleaseEvidenceError(`record must be a portable .md file name: ${name}`);
      if (records.some((entry) => entry.name === name)) throw new ReleaseEvidenceError(`duplicate record name: ${name}`);
      const bytes = await regularFileBytes(path, `record ${name}`);
      if (bytes.length > RECORD_LIMIT) throw new ReleaseEvidenceError(`record ${name} exceeds ${RECORD_LIMIT} bytes`);
      const secrets = scanForSecrets(bytes.toString("utf8"));
      if (secrets.length > 0) throw new ReleaseEvidenceError(`record ${name} refused: ${secrets.join("; ")}`);
      outputs.push({ relativePath: `records/${name}`, bytes });
      records.push({ name, path: `records/${name}`, sha256: sha256Hex(bytes) });
    }
    const manifest: ReleaseEvidenceManifest = {
      schema: RELEASE_EVIDENCE_SCHEMA,
      generatedAt: now.toISOString(),
      repository: options.repository,
      sourceSha: options.sourceSha,
      runner: { name: "ckb-verify", version: runnerVersion ?? VERSION },
      workflow: { runId, runAttempt: options.runAttempt ?? null },
      bundles,
      records,
      note: RELEASE_EVIDENCE_NOTE,
    };
    outputs.push({ relativePath: "release-evidence.json", bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
    outputs.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    for (const output of outputs) {
      await mkdir(dirname(join(root, output.relativePath)), { recursive: true });
      await writeFile(join(root, output.relativePath), output.bytes, { flag: "wx" });
    }
    await writeFile(join(root, "SHA256SUMS"), `${outputs.map((output) => `${sha256Hex(output.bytes)}  ${output.relativePath}`).join("\n")}\n`, { flag: "wx" });

    await mkdir(dirname(archivePath), { recursive: true });
    await tar.c({ gzip: true, cwd: staging, file: archivePath, portable: true, mtime: now }, [RELEASE_EVIDENCE_ROOT]);
    const archiveBytes = await readFile(archivePath);
    const sha256 = sha256Hex(archiveBytes);
    await writeFile(`${archivePath}.sha256`, `${sha256}  ${basename(archivePath)}\n`, { flag: "wx" });

    // The archive is only reported once the consumer path (extract, verify) succeeds on it.
    const check = await mkdtemp(join(tmpdir(), "release-evidence-check-"));
    try {
      const extracted = await extractReleaseEvidence(archivePath, check);
      const verification = await verifyReleaseEvidence(extracted, { expectSourceSha: options.sourceSha, expectRepository: options.repository });
      if (!verification.ok) throw new ReleaseEvidenceError(`assembled archive failed verification: ${flattenProblems(verification).join("; ")}`);
    } finally {
      await rm(check, { recursive: true, force: true });
    }
    return { manifest, archivePath, sha256, bytes: archiveBytes.length };
  } catch (error) {
    await rm(archivePath, { force: true });
    await rm(`${archivePath}.sha256`, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Extracts an archive into `destination`, refusing links, devices, absolute or dot-dot paths, and entries outside the root directory. */
export async function extractReleaseEvidence(archivePath: string, destination: string): Promise<string> {
  await regularFileBytes(archivePath, "archive");
  let unsafe: unknown;
  await tar.x({
    cwd: destination,
    file: archivePath,
    strict: true,
    preservePaths: false,
    filter: (entryPath, entry) => {
      try {
        assertSafeArchiveEntry(entryPath, tarEntryKind(String((entry as { type?: unknown }).type)));
        const normalized = entryPath.replaceAll("\\", "/").replace(/\/+$/, "");
        if (normalized !== RELEASE_EVIDENCE_ROOT && !normalized.startsWith(`${RELEASE_EVIDENCE_ROOT}/`)) {
          throw new Error(`entry outside ${RELEASE_EVIDENCE_ROOT}/: ${entryPath}`);
        }
        return unsafe === undefined;
      } catch (error) {
        unsafe ??= error;
        return false;
      }
    },
  });
  if (unsafe !== undefined) throw new ReleaseEvidenceError(unsafe instanceof Error ? unsafe.message : String(unsafe));
  return join(destination, RELEASE_EVIDENCE_ROOT);
}

export interface ReleaseEvidenceVerification {
  command: "verify-release-evidence";
  ok: boolean;
  path: string;
  manifest: Pick<ReleaseEvidenceManifest, "schema" | "generatedAt" | "repository" | "sourceSha" | "runner" | "workflow"> | null;
  bundles: Array<{ name: string; path: string; ok: boolean; reports: Array<{ path: string; name: string; verdict: "PASS" | "FAIL"; ok: boolean }>; problems: string[] }>;
  records: Array<{ path: string; ok: boolean; problems: string[] }>;
  problems: string[];
}

export interface VerifyReleaseEvidenceOptions { expectSourceSha?: string; expectRepository?: string }

export function flattenProblems(verification: ReleaseEvidenceVerification): string[] {
  return [
    ...verification.problems,
    ...verification.bundles.flatMap((bundle) => bundle.problems.map((problem) => `${bundle.path}: ${problem}`)),
    ...verification.records.flatMap((record) => record.problems.map((problem) => `${record.path}: ${problem}`)),
  ];
}

/** Verifies an extracted archive root: manifest, complete SHA256SUMS coverage, every bundle via `verifyBundle`, every record, no stray files. */
export async function verifyReleaseEvidence(rootDir: string, options: VerifyReleaseEvidenceOptions = {}): Promise<ReleaseEvidenceVerification> {
  const root = resolve(rootDir);
  const problems: string[] = [];
  const result: ReleaseEvidenceVerification = { command: "verify-release-evidence", ok: false, path: root, manifest: null, bundles: [], records: [], problems };
  let manifestBytes: Buffer;
  try { manifestBytes = await regularFileBytes(join(root, "release-evidence.json"), "release-evidence manifest"); } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch { problems.push("release-evidence.json is not valid JSON"); return result; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { problems.push("release-evidence.json is not an object"); return result; }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.schema !== RELEASE_EVIDENCE_SCHEMA) { problems.push(`unsupported release-evidence schema: ${String(manifest.schema)}`); return result; }
  if (typeof manifest.repository !== "string" || typeof manifest.sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(manifest.sourceSha)) {
    problems.push("release-evidence.json lacks repository or a 40-hex sourceSha");
    return result;
  }
  const runner = manifest.runner as Record<string, unknown> | null;
  const workflow = manifest.workflow as Record<string, unknown> | null;
  result.manifest = {
    schema: RELEASE_EVIDENCE_SCHEMA,
    generatedAt: String(manifest.generatedAt),
    repository: manifest.repository,
    sourceSha: manifest.sourceSha,
    runner: { name: "ckb-verify", version: runner !== null && typeof runner === "object" && typeof runner.version === "string" ? runner.version : "unknown" },
    workflow: {
      runId: workflow !== null && typeof workflow === "object" && typeof workflow.runId === "string" ? workflow.runId : null,
      runAttempt: workflow !== null && typeof workflow === "object" && typeof workflow.runAttempt === "string" ? workflow.runAttempt : null,
    },
  };
  if (options.expectSourceSha !== undefined && manifest.sourceSha !== options.expectSourceSha) {
    problems.push(`release-evidence source ${manifest.sourceSha} does not match expected ${options.expectSourceSha}`);
  }
  if (options.expectRepository !== undefined && manifest.repository !== options.expectRepository) {
    problems.push(`release-evidence repository ${manifest.repository} does not match expected ${options.expectRepository}`);
  }

  let files: string[];
  try { files = (await assertOnlyRegularEntries(root)).map((file) => relative(root, file).replaceAll("\\", "/")); } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  // SHA256SUMS must cover every file except itself, exactly once, with a matching hash.
  const sums = new Map<string, string>();
  for (const line of (await readFile(join(root, "SHA256SUMS"), "utf8").catch(() => "")).split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (match === null) { problems.push(`malformed SHA256SUMS line: ${line}`); continue; }
    if (sums.has(match[2]!)) problems.push(`SHA256SUMS lists ${match[2]} twice`);
    sums.set(match[2]!, match[1]!);
  }
  if (!files.includes("SHA256SUMS")) problems.push("SHA256SUMS is missing");
  for (const file of files) {
    if (file === "SHA256SUMS") continue;
    const expected = sums.get(file);
    if (expected === undefined) { problems.push(`file is not listed in SHA256SUMS: ${file}`); continue; }
    if (sha256Hex(await readFile(join(root, file))) !== expected) problems.push(`SHA256SUMS mismatch for ${file}`);
  }
  for (const listed of sums.keys()) if (!files.includes(listed)) problems.push(`SHA256SUMS names an absent file: ${listed}`);

  const claimed = new Set<string>(["release-evidence.json", "SHA256SUMS"]);
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
  if (bundles.length === 0) problems.push("release-evidence.json lists no bundles");
  for (const [index, raw] of bundles.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : `bundles[${index}]`;
    const bundleProblems: string[] = [];
    const record = { name, path: typeof entry.path === "string" ? entry.path : `bundles[${index}]`, ok: false, reports: [] as ReleaseEvidenceVerification["bundles"][number]["reports"], problems: bundleProblems };
    result.bundles.push(record);
    if (!NAME_PATTERN.test(name) || entry.path !== `bundles/${name}`) { bundleProblems.push("bundle entry path is not bundles/<name>"); continue; }
    const verification = await verifyBundle(join(root, "bundles", name), { expectSourceSha: manifest.sourceSha, expectRepository: manifest.repository });
    bundleProblems.push(...verification.problems);
    record.reports = verification.reports.map((report) => ({ path: report.path, name: report.name, verdict: report.verdict, ok: report.ok }));
    for (const report of verification.reports) bundleProblems.push(...report.problems.map((problem) => `${report.path}: ${problem}`));
    if (verification.bundle !== null) {
      if (verification.bundle.runner.version !== result.manifest.runner.version) {
        bundleProblems.push(`bundle runner ${verification.bundle.runner.version} differs from release-evidence runner ${result.manifest.runner.version}`);
      }
      if (result.manifest.workflow.runId !== null && verification.bundle.workflow?.runId !== result.manifest.workflow.runId) {
        bundleProblems.push(`bundle workflow run ${verification.bundle.workflow?.runId ?? "unknown"} differs from release-evidence run ${result.manifest.workflow.runId}`);
      }
    }
    const listedReports = Array.isArray(entry.reports) ? entry.reports as Array<Record<string, unknown>> : [];
    const summary = (reports: Array<{ path: unknown; name: unknown; verdict: unknown }>) => reports.map((report) => `${String(report.path)}|${String(report.name)}|${String(report.verdict)}`).sort().join("\n");
    if (summary(listedReports as Array<{ path: unknown; name: unknown; verdict: unknown }>) !== summary(verification.reports)) {
      bundleProblems.push("release-evidence.json report list differs from the bundle's verified reports");
    }
    for (const file of files) if (file.startsWith(`bundles/${name}/`)) claimed.add(file);
    record.ok = verification.ok && bundleProblems.length === 0;
  }
  const records = Array.isArray(manifest.records) ? manifest.records : [];
  for (const [index, raw] of records.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const recordProblems: string[] = [];
    const record = { path: typeof entry.path === "string" ? entry.path : `records[${index}]`, ok: false, problems: recordProblems };
    result.records.push(record);
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!NAME_PATTERN.test(name) || !name.endsWith(".md") || entry.path !== `records/${name}`) { recordProblems.push("record entry path is not records/<name>.md"); continue; }
    if (!files.includes(record.path)) { recordProblems.push("record file is missing"); continue; }
    claimed.add(record.path);
    const bytes = await readFile(join(root, record.path));
    if (sha256Hex(bytes) !== entry.sha256) recordProblems.push("record checksum differs from release-evidence.json");
    const secrets = scanForSecrets(bytes.toString("utf8"));
    if (secrets.length > 0) recordProblems.push(secrets.join("; "));
    record.ok = recordProblems.length === 0;
  }
  for (const file of files) if (!claimed.has(file)) problems.push(`file is not claimed by release-evidence.json: ${file}`);
  result.ok = problems.length === 0 && result.bundles.every((bundle) => bundle.ok) && result.records.every((record) => record.ok);
  return result;
}

/** Checks a `<name>.sha256` sidecar (sha256sum format) against the archive bytes. */
export async function verifyArchiveChecksum(archivePath: string): Promise<{ ok: boolean; sha256: string; problems: string[] }> {
  const problems: string[] = [];
  const sha256 = sha256Hex(await regularFileBytes(archivePath, "archive"));
  const sidecar = await readFile(`${archivePath}.sha256`, "utf8").catch(() => null);
  if (sidecar === null) problems.push(`checksum sidecar is missing: ${basename(archivePath)}.sha256`);
  else {
    const match = /^([0-9a-f]{64})  (.+)\n?$/.exec(sidecar);
    if (match === null) problems.push("checksum sidecar is malformed");
    else if (match[2] !== basename(archivePath)) problems.push(`checksum sidecar names ${match[2]}, not ${basename(archivePath)}`);
    else if (match[1] !== sha256) problems.push("archive sha256 differs from its sidecar");
  }
  return { ok: problems.length === 0, sha256, problems };
}

