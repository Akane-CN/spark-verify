// Sanitized, checksummed evidence bundles: an allowlist of canonical reports tied to a source revision.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { sha256Bytes } from "./canonical";
import { inspectReport, type DigestPair } from "./offline";
import { VERSION } from "./version";

export const BUNDLE_SCHEMA = "ckb-verify-evidence-bundle/1";
export const BUNDLE_NOTE =
  "Checksums and digests detect alteration of this bundle; they are not an authenticity signature and do not prove the recorded runs happened.";

const REPORT_TOP_LEVEL = ["schema", "verdict", "createdAt", "evidence", "outcomeClaims", "environment", "digests"] as const;

/** Generic credential markers. Reports legitimately contain 32-byte hashes, so hex alone is never a marker. */
const SECRET_MARKERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "PEM private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { label: "URL credentials", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i },
  { label: "private-key field name", pattern: /"(?:privkey|privateKey|private_key|secretAccessKey|accessToken|refreshToken|clientSecret)"\s*:/i },
  { label: "environment secret", pattern: /\b(?:GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY|CKB_VERIFY_ACCOUNTS)\s*[=:]/ },
];

function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns one problem per detected marker or known secret; an empty array means the text passed the scan. */
export function scanForSecrets(text: string, knownSecrets: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const marker of SECRET_MARKERS) {
    if (marker.pattern.test(text)) problems.push(`${marker.label} marker present`);
  }
  for (const secret of knownSecrets) {
    if (secret.length >= 16 && new RegExp(regexEscape(secret), "i").test(text)) problems.push("known development private key present");
  }
  return [...new Set(problems)];
}

export interface BundleReportEntry {
  path: string;
  sha256: string;
  schema: string;
  spec: string;
  name: string;
  verdict: "PASS" | "FAIL";
  digests: DigestPair;
  source: { gitCommit: string | null; dirty: boolean | null };
}

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  generatedAt: string;
  repository: string | null;
  sourceSha: string | null;
  workflow: { name: string | null; job: string | null; runId: string | null; runAttempt: string | null } | null;
  runner: { name: "ckb-verify"; version: string };
  reports: BundleReportEntry[];
  note: string;
}

export class EvidenceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBundleError";
  }
}

async function regularFile(path: string, label: string): Promise<Buffer> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new EvidenceBundleError(`${label} is missing: ${path}`);
  }
  if (!metadata.isFile() || metadata.nlink !== 1) throw new EvidenceBundleError(`${label} must be a regular unlinked file: ${path}`);
  return readFile(path);
}

export async function assertOnlyRegularEntries(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile()) throw new EvidenceBundleError(`unsupported filesystem entry (symlink, device, or socket): ${relative(root, path)}`);
      if ((await lstat(path)).nlink !== 1) throw new EvidenceBundleError(`hard-linked entry refused: ${relative(root, path)}`);
      files.push(path);
    }
  }
  return files;
}

export interface PackageEvidenceOptions {
  /** The project that ran the fixtures; `.ckb-verify/runs` and `.ckb-verify/offckb` are read from here. */
  projectRoot: string;
  outDir: string;
  repository?: string;
  sourceSha?: string;
  workflow?: BundleManifest["workflow"];
  /** Exact secrets (for example the exported OffCKB development keys) that must not appear in any report. */
  knownSecrets?: readonly string[];
  allowDirty?: boolean;
  now?: Date;
}

/** Packages every canonical `report.json` under the project's run directory, or refuses the whole bundle. */
export async function packageEvidence(options: PackageEvidenceOptions): Promise<BundleManifest> {
  const projectRoot = resolve(options.projectRoot);
  const runsRoot = join(projectRoot, ".ckb-verify", "runs");
  const outDir = resolve(options.outDir);
  if (outDir === projectRoot || outDir.startsWith(runsRoot + sep) || outDir === runsRoot) {
    throw new EvidenceBundleError("bundle output must be outside the run directory");
  }
  if (options.sourceSha !== undefined && !/^[0-9a-f]{40}$/.test(options.sourceSha)) {
    throw new EvidenceBundleError("sourceSha must be a 40-character lowercase hex commit");
  }
  for (const forbidden of [join(projectRoot, ".ckb-verify", "offckb", "accounts.json")]) {
    try {
      await lstat(forbidden);
      throw new EvidenceBundleError(`runtime closeout incomplete: ${relative(projectRoot, forbidden)} still exists`);
    } catch (error) {
      if (error instanceof EvidenceBundleError) throw error;
    }
  }
  let runDirectories: string[];
  try {
    runDirectories = (await readdir(runsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(runsRoot, entry.name)).sort();
  } catch {
    throw new EvidenceBundleError(`no run directory at ${runsRoot}`);
  }
  if (runDirectories.length === 0) throw new EvidenceBundleError("no runs to package");
  for (const file of await assertOnlyRegularEntries(runsRoot)) {
    if (basename(file) === ".report.json.pending") throw new EvidenceBundleError(`pending report must not be published: ${relative(projectRoot, file)}`);
  }

  const entries: BundleReportEntry[] = [];
  const outputs: Array<{ relativePath: string; bytes: Buffer }> = [];
  for (const directory of runDirectories) {
    const reportPath = join(directory, "report.json");
    const bytes = await regularFile(reportPath, `canonical report for ${basename(directory)}`);
    const text = bytes.toString("utf8");
    const secrets = scanForSecrets(text, options.knownSecrets ?? []);
    if (secrets.length > 0) throw new EvidenceBundleError(`${basename(directory)}/report.json refused: ${secrets.join("; ")}`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new EvidenceBundleError(`${basename(directory)}/report.json is not valid JSON`); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new EvidenceBundleError(`${basename(directory)}/report.json is not an object`);
    const keys = Object.keys(parsed as object).sort();
    if (keys.join(",") !== [...REPORT_TOP_LEVEL].sort().join(",")) {
      throw new EvidenceBundleError(`${basename(directory)}/report.json has fields outside the allowlist: ${keys.join(", ")}`);
    }
    const inspection = inspectReport(parsed, { path: reportPath, sha256: sha256Bytes(bytes) });
    if (!inspection.valid) throw new EvidenceBundleError(`${basename(directory)}/report.json is not internally consistent: ${inspection.problems.join("; ")}`);
    if (inspection.source?.dirty !== false && options.allowDirty !== true) {
      throw new EvidenceBundleError(`${basename(directory)}/report.json records a dirty or unknown source revision; pass allowDirty only for local experiments`);
    }
    if (options.sourceSha !== undefined && inspection.source?.gitCommit !== options.sourceSha) {
      throw new EvidenceBundleError(`${basename(directory)}/report.json records source ${inspection.source?.gitCommit ?? "unknown"}, not ${options.sourceSha}`);
    }
    if (inspection.schema === null || inspection.spec === null || inspection.name === null || inspection.verdict === null || inspection.digests.recomputed === null) {
      throw new EvidenceBundleError(`${basename(directory)}/report.json lacks identity fields`);
    }
    const relativePath = `reports/${basename(directory)}/report.json`;
    outputs.push({ relativePath, bytes });
    entries.push({
      path: relativePath,
      sha256: sha256Bytes(bytes),
      schema: inspection.schema,
      spec: inspection.spec,
      name: inspection.name,
      verdict: inspection.verdict,
      digests: inspection.digests.recomputed,
      source: inspection.source ?? { gitCommit: null, dirty: null },
    });
  }

  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    generatedAt: (options.now ?? new Date()).toISOString(),
    repository: options.repository ?? null,
    sourceSha: options.sourceSha ?? entries[0]?.source.gitCommit ?? null,
    workflow: options.workflow ?? null,
    runner: { name: "ckb-verify", version: VERSION },
    reports: entries,
    note: BUNDLE_NOTE,
  };
  // Write only after every report passed: a bundle is all-or-nothing.
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length > 0) throw new EvidenceBundleError(`bundle output directory is not empty: ${outDir}`);
  for (const output of outputs) {
    await mkdir(join(outDir, output.relativePath, ".."), { recursive: true });
    await writeFile(join(outDir, output.relativePath), output.bytes, { flag: "wx" });
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outDir, "bundle.json"), manifestBytes, { flag: "wx" });
  const sums = [...outputs.map((output) => `${createHash("sha256").update(output.bytes).digest("hex")}  ${output.relativePath}`),
    `${createHash("sha256").update(manifestBytes).digest("hex")}  bundle.json`];
  await writeFile(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`, { flag: "wx" });
  return manifest;
}

export interface BundleVerification {
  command: "check-bundle";
  ok: boolean;
  path: string;
  bundle: Pick<BundleManifest, "schema" | "generatedAt" | "repository" | "sourceSha" | "workflow" | "runner"> | null;
  reports: Array<{ path: string; name: string; verdict: "PASS" | "FAIL"; ok: boolean; problems: string[] }>;
  problems: string[];
}

export interface VerifyBundleOptions {
  expectSourceSha?: string;
  expectRepository?: string;
  allowDirty?: boolean;
}

/** Verifies a bundle directory a consumer downloaded: allowlisted files, checksums, and every report's digests. */
export async function verifyBundle(bundleDir: string, options: VerifyBundleOptions = {}): Promise<BundleVerification> {
  const root = resolve(bundleDir);
  const problems: string[] = [];
  const result: BundleVerification = { command: "check-bundle", ok: false, path: root, bundle: null, reports: [], problems };
  let manifestBytes: Buffer;
  try {
    manifestBytes = await regularFile(join(root, "bundle.json"), "bundle manifest");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { problems.push("bundle.json is not valid JSON"); return result; }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) { problems.push("bundle.json is not an object"); return result; }
  const bundle = manifest as Record<string, unknown>;
  if (bundle.schema !== BUNDLE_SCHEMA) { problems.push(`unsupported bundle schema: ${String(bundle.schema)}`); return result; }
  if (!Array.isArray(bundle.reports) || bundle.reports.length === 0) { problems.push("bundle.json lists no reports"); return result; }
  const runner = bundle.runner as Record<string, unknown> | null;
  result.bundle = {
    schema: BUNDLE_SCHEMA,
    generatedAt: String(bundle.generatedAt),
    repository: typeof bundle.repository === "string" ? bundle.repository : null,
    sourceSha: typeof bundle.sourceSha === "string" ? bundle.sourceSha : null,
    workflow: (bundle.workflow as BundleManifest["workflow"]) ?? null,
    runner: { name: "ckb-verify", version: runner !== null && typeof runner === "object" && typeof runner.version === "string" ? runner.version : "unknown" },
  };
  if (options.expectSourceSha !== undefined && result.bundle.sourceSha !== options.expectSourceSha) {
    problems.push(`bundle source ${result.bundle.sourceSha ?? "unknown"} does not match expected ${options.expectSourceSha}`);
  }
  if (options.expectRepository !== undefined && result.bundle.repository !== options.expectRepository) {
    problems.push(`bundle repository ${result.bundle.repository ?? "unknown"} does not match expected ${options.expectRepository}`);
  }

  let files: string[];
  try {
    files = (await assertOnlyRegularEntries(root)).map((file) => relative(root, file));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  const listed = new Set<string>(["bundle.json", "SHA256SUMS"]);
  for (const [index, raw] of bundle.reports.entries()) {
    const entry = raw as Record<string, unknown>;
    const path = typeof entry.path === "string" ? entry.path : `reports[${index}]`;
    const reportProblems: string[] = [];
    const record = { path, name: String(entry.name ?? ""), verdict: (entry.verdict === "FAIL" ? "FAIL" : "PASS") as "PASS" | "FAIL", ok: false, problems: reportProblems };
    result.reports.push(record);
    if (typeof entry.path !== "string" || !entry.path.startsWith("reports/") || entry.path.includes("..") || !entry.path.endsWith("/report.json")) {
      reportProblems.push("entry path outside the reports allowlist");
      continue;
    }
    listed.add(entry.path);
    let bytes: Buffer;
    try { bytes = await regularFile(join(root, entry.path), "listed report"); } catch (error) { reportProblems.push(error instanceof Error ? error.message : String(error)); continue; }
    if (sha256Bytes(bytes) !== entry.sha256) reportProblems.push(`file checksum differs from bundle.json (${sha256Bytes(bytes)})`);
    const digests = entry.digests as Record<string, unknown> | undefined;
    const expected: { outcome?: string; environment?: string } = {};
    if (digests !== undefined && typeof digests.outcome === "string") expected.outcome = digests.outcome;
    if (digests !== undefined && typeof digests.environment === "string") expected.environment = digests.environment;
    if (expected.outcome === undefined || expected.environment === undefined) reportProblems.push("bundle entry lacks outcome/environment digests");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { reportProblems.push("report is not valid JSON"); continue; }
    const inspection = inspectReport(parsed, { command: "check-digest", expected, path: join(root, entry.path), sha256: sha256Bytes(bytes) });
    reportProblems.push(...inspection.problems);
    if (inspection.verdict !== entry.verdict) reportProblems.push(`recorded verdict ${inspection.verdict ?? "unknown"} differs from bundle entry ${String(entry.verdict)}`);
    if (inspection.name !== entry.name) reportProblems.push("report name differs from bundle entry");
    if (result.bundle.sourceSha !== null && inspection.source?.gitCommit !== result.bundle.sourceSha) {
      reportProblems.push(`report source ${inspection.source?.gitCommit ?? "unknown"} differs from bundle source ${result.bundle.sourceSha}`);
    }
    if (inspection.source?.dirty !== false && options.allowDirty !== true) reportProblems.push("report records a dirty or unknown source revision");
    if (inspection.valid && inspection.verdict !== null) record.verdict = inspection.verdict;
    record.ok = inspection.ok && reportProblems.length === 0;
  }
  for (const file of files) {
    if (!listed.has(file)) problems.push(`file is not listed in bundle.json: ${file}`);
  }
  for (const line of (await readFile(join(root, "SHA256SUMS"), "utf8").catch(() => "")).split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (match === null) { problems.push(`malformed SHA256SUMS line: ${line}`); continue; }
    const [, sum, file] = match;
    if (!files.includes(file!)) { problems.push(`SHA256SUMS names an absent file: ${file}`); continue; }
    const actual = createHash("sha256").update(await readFile(join(root, file!))).digest("hex");
    if (actual !== sum) problems.push(`SHA256SUMS mismatch for ${file}`);
  }
  result.ok = problems.length === 0 && result.reports.every((report) => report.ok);
  return result;
}
