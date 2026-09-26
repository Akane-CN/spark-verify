interface AuditAdvisory {
  id: number;
  url: string;
  severity: string;
  title?: string;
  vulnerable_versions?: string;
}

const ALLOWED_AUDIT_FINDINGS = new Map<string, { severity: "low"; url: string }>([
  [
    "elliptic:1112030",
    {
      severity: "low",
      url: "https://github.com/advisories/GHSA-848j-6mx2-7j84",
    },
  ],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAdvisory(packageName: string, value: unknown): AuditAdvisory {
  if (
    !isObject(value) ||
    typeof value.id !== "number" ||
    typeof value.url !== "string" ||
    typeof value.severity !== "string"
  ) {
    throw new Error(`bun audit returned an invalid advisory for ${packageName}`);
  }
  return {
    id: value.id,
    url: value.url,
    severity: value.severity,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.vulnerable_versions === "string" ? { vulnerable_versions: value.vulnerable_versions } : {}),
  };
}

function auditFindings(report: unknown): Array<{ packageName: string; advisory: AuditAdvisory }> {
  if (!isObject(report)) throw new Error("bun audit did not return a JSON object");
  const findings: Array<{ packageName: string; advisory: AuditAdvisory }> = [];
  for (const [packageName, rawAdvisories] of Object.entries(report)) {
    if (!Array.isArray(rawAdvisories)) throw new Error(`bun audit returned invalid findings for ${packageName}`);
    for (const rawAdvisory of rawAdvisories) {
      findings.push({ packageName, advisory: parseAdvisory(packageName, rawAdvisory) });
    }
  }
  return findings;
}

export function assertAllowedAuditReport(report: unknown): void {
  const rejected: string[] = [];
  for (const { packageName, advisory } of auditFindings(report)) {
    const allowed = ALLOWED_AUDIT_FINDINGS.get(`${packageName}:${advisory.id}`);
    const severity = advisory.severity.toLowerCase();
    if (allowed === undefined || severity !== allowed.severity || advisory.url !== allowed.url) {
      rejected.push(`${packageName}:${advisory.id} (${severity})`);
    }
  }
  if (rejected.length > 0) {
    throw new Error(`unapproved audit findings: ${rejected.join(", ")}`);
  }
}

export function assertAuditCommandResult(report: unknown, exitCode: number): void {
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`bun audit unexpectedly exited with status ${exitCode}`);
  }
  const findings = auditFindings(report);
  if (exitCode === 1 && findings.length === 0) {
    throw new Error("bun audit reported findings without advisory data");
  }
  if (exitCode === 0 && findings.length > 0) {
    throw new Error("bun audit returned advisory data with success status");
  }
  assertAllowedAuditReport(report);
}

function count(text: string, needle: string): number {
  let result = 0;
  let offset = 0;
  while (true) {
    const next = text.indexOf(needle, offset);
    if (next === -1) return result;
    result += 1;
    offset = next + needle.length;
  }
}

export function assertOffckbUsesExternalArchiveLibraries(bundle: string): void {
  const vulnerableAdmZipImport = "__nccwpck_require__(3858)";
  const patchedAdmZipImport = 'const adm_zip_1 = __importDefault(require("adm-zip"));';
  const vulnerableTarImport = "__nccwpck_require__(7222)";
  const patchedTarImport = 'const tar = __importStar(require("tar"));';

  const vulnerableAdmZipCount = count(bundle, vulnerableAdmZipImport);
  const patchedAdmZipCount = count(bundle, patchedAdmZipImport);
  const vulnerableTarCount = count(bundle, vulnerableTarImport);
  const patchedTarCount = count(bundle, patchedTarImport);

  if (vulnerableAdmZipCount !== 0) {
    throw new Error(`OffCKB bundle retains ${vulnerableAdmZipCount} bundled vulnerable adm-zip import(s)`);
  }
  if (patchedAdmZipCount !== 2) {
    throw new Error(`OffCKB bundle must contain exactly 2 patched adm-zip imports; observed ${patchedAdmZipCount}`);
  }
  if (vulnerableTarCount !== 0) {
    throw new Error(`OffCKB bundle retains ${vulnerableTarCount} bundled vulnerable tar import(s)`);
  }
  if (patchedTarCount !== 2) {
    throw new Error(`OffCKB bundle must contain exactly 2 patched tar imports; observed ${patchedTarCount}`);
  }
}
