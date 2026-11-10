#!/usr/bin/env bun
// Prepare a project to use ckb-verify from its packed tarball, in one command:
//
//   bun src/setup-project.ts <ckb-verify-<version>.tgz> [project-dir] [--example] [--no-install]
//
// It does what docs/install.md describes by hand: vendors the tarball, extracts the shipped OffCKB patch
// (Bun refuses the install unless that file exists in the installing project), declares the dependency,
// the patch, the audited overrides, and the Bun pin in package.json, ignores the runner's output, and
// installs. `--example` also writes a manifest and a producer that pass on a fresh devnet as they are.
//
// The file imports only the standard library, so it also runs straight out of the tarball, before
// anything is installed:
//
//   tar -xzf ckb-verify-<version>.tgz package/src/setup-project.ts
//   bun package/src/setup-project.ts ckb-verify-<version>.tgz .
//
// It never overwrites a file it did not write and never replaces a conflicting package.json value.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface SetupProjectOptions {
  tarball: string;
  project: string;
  example?: boolean;
  install?: boolean;
  log?: (line: string) => void;
}

export interface SetupProjectResult { version: string; changed: string[]; unchanged: string[]; installed: boolean }

const EXAMPLE_PRODUCER_IN_TARBALL = "package/src/templates/secp-transfer-producer.ts";
const EXAMPLE_PRODUCER = "verify/transfer.ts";
const EXAMPLE_MANIFEST = "verify.toml";
const IGNORED = ["node_modules/", ".ckb-verify/"];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

function fromTarball(tarball: string, member: string): Buffer {
  const result = spawnSync("tar", ["-xzOf", tarball, member], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${basename(tarball)} does not contain ${member} (is it a ckb-verify package tarball?)`);
  return result.stdout;
}

function exampleManifest(packaged: Json): string {
  const dependencies = isObject(packaged.dependencies) ? packaged.dependencies : {};
  return `# Written by ckb-verify's setup-project. One step: your code builds and signs a transaction, ckb-verify
# submits it on a fresh devnet and checks what you declared. Replace the step with your own flow.
[meta]
name = "example-transfer"
spec = "0.1.0"
description = "A 100 CKB transfer commits and leaves one live output Cell."

[toolchain]
ckb = "0.209.0"
offckb = "${String(dependencies["@offckb/cli"] ?? "0.4.13")}"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "transfer"
run = "bun run ${EXAMPLE_PRODUCER} committed"
timeout = "60s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "transfer", index = 0 }
count = 1
`;
}

export function setupProject(options: SetupProjectOptions): SetupProjectResult {
  const log = options.log ?? (() => {});
  const changed: string[] = [], unchanged: string[] = [];
  const tarball = resolve(options.tarball);
  if (!existsSync(tarball) || !statSync(tarball).isFile()) throw new Error(`no such tarball: ${options.tarball}`);
  const packaged: unknown = JSON.parse(fromTarball(tarball, "package/package.json").toString("utf8"));
  if (!isObject(packaged) || packaged.name !== "ckb-verify" || typeof packaged.version !== "string") {
    throw new Error(`${basename(tarball)} is not a ckb-verify package`);
  }
  const version = packaged.version;
  const patches = isObject(packaged.patchedDependencies) ? packaged.patchedDependencies : {};
  const overrides = isObject(packaged.overrides) ? packaged.overrides : {};

  const project = resolve(options.project);
  mkdirSync(project, { recursive: true });
  const write = (relativePath: string, content: string | Buffer): void => {
    const path = join(project, relativePath);
    if (existsSync(path) && readFileSync(path).equals(Buffer.from(content))) { unchanged.push(relativePath); return; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    changed.push(relativePath);
  };
  /** Files this tool creates but never replaces: an existing one is the user's. */
  const create = (relativePath: string, content: string | Buffer): void => {
    if (existsSync(join(project, relativePath))) { unchanged.push(relativePath); log(`kept existing ${relativePath}`); return; }
    write(relativePath, content);
  };

  // 1. Vendor the tarball, so the dependency resolves inside the repository (and in CI).
  const vendored = `vendor/ckb-verify-${version}.tgz`;
  const vendoredPath = join(project, vendored);
  mkdirSync(dirname(vendoredPath), { recursive: true });
  if (!existsSync(vendoredPath) || realpathSync(vendoredPath) !== realpathSync(tarball)) {
    if (existsSync(vendoredPath) && readFileSync(vendoredPath).equals(readFileSync(tarball))) unchanged.push(vendored);
    else { copyFileSync(tarball, vendoredPath); changed.push(vendored); }
  } else unchanged.push(vendored);

  // 2. The shipped patch files, at the paths the package itself declares.
  for (const [dependency, path] of Object.entries(patches)) {
    if (typeof path !== "string" || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`unsafe patch path for ${dependency}`);
    write(path, fromTarball(tarball, `package/${path}`));
  }

  // 3. package.json: add what is missing, refuse to replace what conflicts.
  const manifestPath = join(project, "package.json");
  const manifest: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { name: basename(project).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "") || "ckb-project", private: true, type: "module" };
  if (!isObject(manifest)) throw new Error("package.json must contain a JSON object");
  const section = (key: string): Json => {
    if (manifest[key] === undefined) manifest[key] = {};
    if (!isObject(manifest[key])) throw new Error(`package.json ${key} must be an object`);
    return manifest[key] as Json;
  };
  const pin = (key: string, name: string, value: unknown): void => {
    const target = section(key);
    if (target[name] !== undefined && target[name] !== value) {
      throw new Error(`package.json ${key}["${name}"] is ${JSON.stringify(target[name])}, but ckb-verify ${version} needs ${JSON.stringify(value)}; change it yourself and run this again`);
    }
    target[name] = value;
  };
  section("dependencies")["ckb-verify"] = `file:${vendored}`;
  for (const [dependency, path] of Object.entries(patches)) pin("patchedDependencies", dependency, path);
  for (const [name, exact] of Object.entries(overrides)) pin("overrides", name, exact);
  if (manifest.packageManager === undefined) manifest.packageManager = packaged.packageManager ?? "bun@1.2.19";
  else if (manifest.packageManager !== packaged.packageManager) {
    log(`note: packageManager is ${String(manifest.packageManager)}; ckb-verify ${version} is exercised with ${String(packaged.packageManager)} only`);
  }
  if (options.example === true) {
    const core = isObject(packaged.dependencies) ? packaged.dependencies["@ckb-ccc/core"] : undefined;
    const dependencies = section("dependencies");
    if (dependencies["@ckb-ccc/core"] === undefined && typeof core === "string") dependencies["@ckb-ccc/core"] = core;
  }
  write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);

  // 4. Dependencies and the runner's output are not source.
  const ignorePath = join(project, ".gitignore");
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const lines = ignore.split("\n").map((line) => line.trim());
  const missing = IGNORED.filter((entry) => !lines.includes(entry) && !lines.includes(entry.replace(/\/$/, "")));
  if (missing.length === 0) unchanged.push(".gitignore");
  else write(".gitignore", `${ignore}${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);

  // 5. A manifest and a producer that pass as they are.
  if (options.example === true) {
    create(EXAMPLE_PRODUCER, fromTarball(tarball, EXAMPLE_PRODUCER_IN_TARBALL));
    create(EXAMPLE_MANIFEST, exampleManifest(packaged));
  }

  // 6. The source guard compares Git snapshots; outside a repository every report is marked tainted.
  if (!existsSync(join(project, ".git"))) {
    if (spawnSync("git", ["init", "-q"], { cwd: project }).status === 0) changed.push(".git");
    else log("note: git is not available; run `git init` and commit before `ckb-verify run`");
  }

  let installed = false;
  if (options.install !== false) {
    const install = spawnSync("bun", ["install"], { cwd: project, stdio: ["ignore", "inherit", "inherit"] });
    if (install.status !== 0) throw new Error("bun install failed (see its output above)");
    const reported = spawnSync(join(project, "node_modules", ".bin", "ckb-verify"), ["--version"], { cwd: project, encoding: "utf8" });
    if (reported.status !== 0 || reported.stdout.trim() !== version) {
      throw new Error(`the installed ckb-verify reports ${JSON.stringify(reported.stdout.trim())}, expected ${version}`);
    }
    installed = true;
  }
  return { version, changed, unchanged, installed };
}

function usage(): never {
  process.stderr.write("usage: bun setup-project.ts <ckb-verify-<version>.tgz> [project-dir] [--example] [--no-install]\n");
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  for (const flag of flags) if (flag !== "--example" && flag !== "--no-install") usage();
  if (positional.length < 1 || positional.length > 2) usage();
  try {
    const example = flags.has("--example");
    const result = setupProject({
      tarball: positional[0]!, project: positional[1] ?? ".", example, install: !flags.has("--no-install"),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`ckb-verify ${result.version} is set up in ${resolve(positional[1] ?? ".")}`);
    out(`  written:   ${result.changed.length === 0 ? "nothing (already set up)" : result.changed.join(", ")}`);
    if (!result.installed) out("  next:      bun install");
    out("  commit:    git add -A && git commit -m \"Add ckb-verify\"   # a clean commit keeps reports untainted");
    out(example ? "  then run:  bunx ckb-verify run                  # the example manifest, on a fresh devnet"
      : "  then:      write verify.toml (docs/install.md, section 4), and run: bunx ckb-verify run");
    out("  console:   bunx ckb-verify ui");
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
