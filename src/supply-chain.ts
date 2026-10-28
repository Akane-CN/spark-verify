interface AuditAdvisory {
  id: number;
  url: string;
  severity: string;
  title?: string;
  vulnerable_versions?: string;
}

// Keep this bounded exception and its renewal/removal policy aligned with SECURITY.md.
const ALLOWED_AUDIT_FINDINGS = new Map<string, {
  severity: "low"; url: string; owner: string; reviewedOn: string; expiresAt: string;
}>([
  [
    "elliptic:1112030",
    {
      severity: "low",
      url: "https://github.com/advisories/GHSA-848j-6mx2-7j84",
      owner: "Akane-CN",
      reviewedOn: "2026-10-26",
      expiresAt: "2026-11-25T00:00:00Z",
    },
  ],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertPackageVersion(metadata: unknown, expectedName: string, expectedVersion: string): void {
  if (!isObject(metadata) || metadata.name !== expectedName || metadata.version !== expectedVersion) {
    throw new Error(`expected ${expectedName}@${expectedVersion} in installed package metadata`);
  }
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

export function assertAllowedAuditReport(report: unknown, now: Date = new Date()): void {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid audit review clock");
  const rejected: string[] = [];
  for (const { packageName, advisory } of auditFindings(report)) {
    const allowed = ALLOWED_AUDIT_FINDINGS.get(`${packageName}:${advisory.id}`);
    const severity = advisory.severity.toLowerCase();
    if (allowed === undefined || severity !== allowed.severity || advisory.url !== allowed.url) {
      rejected.push(`${packageName}:${advisory.id} (${severity})`);
    } else if (now.getTime() >= Date.parse(allowed.expiresAt)) {
      rejected.push(`${packageName}:${advisory.id} (waiver expired ${allowed.expiresAt}; ${allowed.owner} review required)`);
    }
  }
  if (rejected.length > 0) {
    throw new Error(`unapproved audit findings: ${rejected.join(", ")}`);
  }
}

export function assertAuditCommandResult(report: unknown, exitCode: number, now: Date = new Date()): void {
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
  assertAllowedAuditReport(report, now);
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

export function assertOffckbUsesExternalLibraries(bundle: string): void {
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

  const vulnerableRedirectCount = count(bundle, "__nccwpck_require__(230)");
  const patchedRedirectCount = count(bundle, 'followRedirects = require("follow-redirects");');
  if (vulnerableRedirectCount !== 0) {
    throw new Error(`OffCKB bundle retains ${vulnerableRedirectCount} bundled vulnerable follow-redirects import(s)`);
  }
  if (patchedRedirectCount !== 1) {
    throw new Error(`OffCKB bundle must contain exactly 1 patched follow-redirects import; observed ${patchedRedirectCount}`);
  }

  // The RPC proxy must bind loopback only; the unpatched bundle listens on every interface.
  const wildcardProxyListen = 'return server.listen(port, () => {';
  const loopbackProxyListen = 'return server.listen(port, "127.0.0.1", () => {';
  const wildcardProxyCount = count(bundle, wildcardProxyListen);
  const loopbackProxyCount = count(bundle, loopbackProxyListen);
  if (wildcardProxyCount !== 0) {
    throw new Error(`OffCKB bundle retains ${wildcardProxyCount} wildcard RPC proxy listen call(s)`);
  }
  if (loopbackProxyCount !== 1) {
    throw new Error(`OffCKB bundle must contain exactly 1 loopback-bound RPC proxy listen; observed ${loopbackProxyCount}`);
  }
}

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const OFFCKB_PACKAGE_VERSION = "0.4.13";
const OFFCKB_EXTERNAL_LIBRARIES: ReadonlyArray<readonly [name: string, version: string]> = [
  ["adm-zip", "0.6.1"],
  ["tar", "7.5.22"],
  ["follow-redirects", "1.16.1"],
];

/** Locates the OffCKB CLI from ckb-verify's own dependency tree, never from the project being verified. */
export function resolveOffckbPackage(fromUrl: string = import.meta.url): string {
  return dirname(createRequire(fromUrl).resolve("@offckb/cli/package.json"));
}

export interface InstalledOffckb {
  packageRoot: string;
  /** The executable OffCKB entry (`build/index.js`, shebang `node`), the same file the `.bin` shim links to. */
  binaryPath: string;
}

export class OffckbInstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffckbInstallationError";
  }
}

/**
 * Fail-closed installation check run before any devnet mutation. A package manager applies
 * `patchedDependencies` only from the installing project's own package.json, so an installed copy of
 * ckb-verify may sit next to an unpatched OffCKB bundle that still embeds vulnerable archive code.
 */
export async function assertInstalledOffckb(fromUrl: string = import.meta.url): Promise<InstalledOffckb> {
  const remedy = "The shipped patch must be active in the installing project (see docs/install.md); refusing to start a devnet.";
  let packageRoot: string;
  try {
    packageRoot = resolveOffckbPackage(fromUrl);
  } catch (error) {
    throw new OffckbInstallationError(`OffCKB CLI is not installed next to ckb-verify: ${error instanceof Error ? error.message : String(error)}`);
  }
  const binaryPath = join(packageRoot, "build", "index.js");
  try {
    assertPackageVersion(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")), "@offckb/cli", OFFCKB_PACKAGE_VERSION);
    assertOffckbUsesExternalLibraries(await readFile(binaryPath, "utf8"));
    const requireFromOffckb = createRequire(binaryPath);
    for (const [name, version] of OFFCKB_EXTERNAL_LIBRARIES) {
      assertPackageVersion(JSON.parse(await readFile(requireFromOffckb.resolve(`${name}/package.json`), "utf8")), name, version);
    }
  } catch (error) {
    throw new OffckbInstallationError(
      `OffCKB installation is not the verified patched build: ${error instanceof Error ? error.message : String(error)}. ${remedy}`,
    );
  }
  return { packageRoot, binaryPath };
}
