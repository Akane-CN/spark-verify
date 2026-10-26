import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAuditCommandResult, assertOffckbUsesExternalLibraries, assertPackageVersion } from "../src/supply-chain";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function assertInstalledPackageVersion(path: string, expectedName: string, expectedVersion: string): Promise<void> {
  const metadata: unknown = JSON.parse(await readFile(path, "utf8"));
  assertPackageVersion(metadata, expectedName, expectedVersion);
}

const offckbPackagePath = join(repositoryRoot, "node_modules", "@offckb", "cli", "package.json");
const offckbRoot = dirname(offckbPackagePath);
const requireFromOffckb = createRequire(join(offckbRoot, "build", "index.js"));
const resolvedAdmZipPackagePath = requireFromOffckb.resolve("adm-zip/package.json");
const resolvedTarPackagePath = requireFromOffckb.resolve("tar/package.json");
const resolvedRedirectPackagePath = requireFromOffckb.resolve("follow-redirects/package.json");
const requireFromRepository = createRequire(join(repositoryRoot, "package.json"));
const requireFromAjv = createRequire(requireFromRepository.resolve("ajv"));
const resolvedUriPackagePath = requireFromAjv.resolve("fast-uri/package.json");

await Promise.all([
  assertInstalledPackageVersion(offckbPackagePath, "@offckb/cli", "0.4.13"),
  assertInstalledPackageVersion(resolvedAdmZipPackagePath, "adm-zip", "0.6.1"),
  assertInstalledPackageVersion(resolvedTarPackagePath, "tar", "7.5.22"),
  assertInstalledPackageVersion(resolvedRedirectPackagePath, "follow-redirects", "1.16.1"),
  assertInstalledPackageVersion(resolvedUriPackagePath, "fast-uri", "3.1.9"),
]);

const offckbBundle = await readFile(join(offckbRoot, "build", "index.js"), "utf8");
assertOffckbUsesExternalLibraries(offckbBundle);

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
  "supply-chain gate passed: verified OffCKB patch, adm-zip@0.6.1, tar@7.5.22, follow-redirects@1.16.1, fast-uri@3.1.9, and audit allowlist",
);
