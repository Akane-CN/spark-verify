// Package the canonical reports of a finished run into a sanitized, checksummed evidence bundle.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageEvidence, EvidenceBundleError } from "../src/evidence-bundle";

function usage(message?: string): never {
  if (message !== undefined) console.error(`package-evidence: ${message}`);
  console.error("usage: bun run scripts/package-evidence.ts --out <dir> [--project-root <dir>] [--repository owner/repo] " +
    "[--source-sha <40 hex>] [--workflow <name>] [--job <name>] [--run-id <id>] [--run-attempt <n>] [--allow-dirty]");
  process.exit(2);
}

const options = new Map<string, string | true>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (!arg.startsWith("--")) usage(`unexpected argument: ${arg}`);
  const name = arg.slice(2);
  if (name === "allow-dirty") { options.set(name, true); continue; }
  const value = args[++index];
  if (value === undefined || value.startsWith("--")) usage(`--${name} requires a value`);
  options.set(name, value);
}
const text = (name: string): string | undefined => {
  const value = options.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
};
const out = text("out");
if (out === undefined) usage("--out is required");

// The exact development keys OffCKB exports are the known secrets a report must never retain.
let knownSecrets: string[] = [];
try {
  const require = createRequire(import.meta.url);
  const accountFile = join(dirname(require.resolve("@offckb/cli/package.json")), "account", "account.json");
  const parsed: unknown = JSON.parse(await readFile(accountFile, "utf8"));
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (/priv/i.test(key) && typeof entry === "string" && /^0x[0-9a-f]{64}$/i.test(entry)) knownSecrets.push(entry);
        else collect(entry);
      }
    }
  };
  collect(parsed);
} catch (error) {
  usage(`cannot load the OffCKB development key list for the secret scan: ${error instanceof Error ? error.message : String(error)}`);
}
if (knownSecrets.length === 0) usage("the OffCKB development key list is empty; refusing to package without a known-secret scan");

try {
  const manifest = await packageEvidence({
    projectRoot: text("project-root") ?? process.cwd(),
    outDir: out,
    ...(text("repository") === undefined ? {} : { repository: text("repository")! }),
    ...(text("source-sha") === undefined ? {} : { sourceSha: text("source-sha")! }),
    workflow: { name: text("workflow") ?? null, job: text("job") ?? null, runId: text("run-id") ?? null, runAttempt: text("run-attempt") ?? null },
    knownSecrets,
    allowDirty: options.get("allow-dirty") === true,
  });
  console.log(JSON.stringify({
    bundle: out, sourceSha: manifest.sourceSha, runner: manifest.runner,
    reports: manifest.reports.map((report) => ({ path: report.path, name: report.name, verdict: report.verdict, outcome: report.digests.outcome })),
  }, null, 2));
} catch (error) {
  if (error instanceof EvidenceBundleError) {
    console.error(`package-evidence: refused: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
