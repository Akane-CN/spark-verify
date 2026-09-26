import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAuditCommandResult, assertOffckbUsesExternalArchiveLibraries } from "../src/supply-chain";

interface PackageJson {
  name?: string;
  version?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readPackageJson(path: string): Promise<PackageJson> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid package metadata at ${path}`);
  }
  return value as PackageJson;
}

async function assertPackageVersion(path: string, expectedName: string, expectedVersion: string): Promise<void> {
  const metadata = await readPackageJson(path);
  if (metadata.name !== expectedName || metadata.version !== expectedVersion) {
    throw new Error(
      `expected ${expectedName}@${expectedVersion} at ${path}; observed ${metadata.name ?? "<missing>"}@${metadata.version ?? "<missing>"}`,
    );
  }
}

const offckbPackagePath = join(repositoryRoot, "node_modules", "@offckb", "cli", "package.json");
const offckbRoot = dirname(offckbPackagePath);
const requireFromOffckb = createRequire(join(offckbRoot, "build", "index.js"));
const resolvedAdmZipPackagePath = requireFromOffckb.resolve("adm-zip/package.json");
const resolvedTarPackagePath = requireFromOffckb.resolve("tar/package.json");

await Promise.all([
  assertPackageVersion(offckbPackagePath, "@offckb/cli", "0.4.13"),
  assertPackageVersion(resolvedAdmZipPackagePath, "adm-zip", "0.6.1"),
  assertPackageVersion(resolvedTarPackagePath, "tar", "7.5.22"),
]);

const offckbBundle = await readFile(join(offckbRoot, "build", "index.js"), "utf8");
assertOffckbUsesExternalArchiveLibraries(offckbBundle);

const audit = Bun.spawn(["bun", "audit", "--json"], {
  cwd: repositoryRoot,
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const [auditOutput, auditError, auditExitCode] = await Promise.all([
  new Response(audit.stdout).text(),
  new Response(audit.stderr).text(),
  audit.exited,
]);
let auditReport: unknown;
try {
  auditReport = JSON.parse(auditOutput);
} catch (error) {
  throw new Error(
    `bun audit returned invalid JSON (exit ${auditExitCode}): ${auditError.trim()}`,
    error instanceof Error ? { cause: error } : undefined,
  );
}
assertAuditCommandResult(auditReport, auditExitCode);

console.log(
  "supply-chain gate passed: verified OffCKB patch, adm-zip@0.6.1, tar@7.5.22, and audit allowlist",
);
