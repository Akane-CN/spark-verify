// setup-project: preparing a consumer project from the packed tarball. The install itself and a real run of
// the generated example are exercised by scripts/acceptance-matrix.sh --consumer; these tests cover what it
// writes, what it refuses to replace, and that it runs from the tarball alone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { validateManifestFile } from "../src/offline";
import { setupProject } from "../src/setup-project";
import { VERSION } from "../src/version";

const root = join(import.meta.dir, "..");
let work: string, tarball: string;
let counter = 0;
const fresh = async (): Promise<string> => { const dir = join(work, `project-${counter += 1}`); await mkdir(dir); return dir; };
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "ckb-verify-setup-"));
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", work], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(packed.exitCode).toBe(0);
  tarball = join(work, `ckb-verify-${VERSION}.tgz`);
  expect(existsSync(tarball)).toBe(true);
});
afterAll(async () => { await rm(work, { recursive: true, force: true }); });

describe("setup-project", () => {
  test("prepares an empty directory, with an example that validates", async () => {
    const project = await fresh();
    const result = setupProject({ tarball, project, example: true, install: false });
    expect(result).toMatchObject({ version: VERSION, installed: false });
    const manifest = await json(join(project, "package.json"));
    const packaged = await json(join(root, "package.json"));
    expect(manifest.dependencies["ckb-verify"]).toBe(`file:vendor/ckb-verify-${VERSION}.tgz`);
    expect(manifest.dependencies["@ckb-ccc/core"]).toBe(packaged.dependencies["@ckb-ccc/core"]);
    expect(manifest.patchedDependencies).toEqual(packaged.patchedDependencies);
    expect(manifest.overrides).toEqual(packaged.overrides);
    expect(manifest.packageManager).toBe(packaged.packageManager);
    expect(manifest.private).toBe(true);
    expect((await readFile(join(project, "vendor", `ckb-verify-${VERSION}.tgz`))).equals(await readFile(tarball))).toBe(true);
    for (const path of Object.values(packaged.patchedDependencies as Record<string, string>)) {
      expect((await readFile(join(project, path))).equals(await readFile(join(root, path)))).toBe(true);
    }
    expect((await readFile(join(project, ".gitignore"), "utf8")).split("\n")).toEqual(expect.arrayContaining(["node_modules/", ".ckb-verify/"]));
    expect(existsSync(join(project, ".git"))).toBe(true);
    expect((await readFile(join(project, "verify", "transfer.ts"))).equals(await readFile(join(root, "showcases", "secp-transfer", "produce.ts")))).toBe(true);
    const validation = await validateManifestFile(join(project, "verify.toml"));
    expect(validation.ok).toBe(true);
  });

  test("a second run changes nothing", async () => {
    const project = await fresh();
    setupProject({ tarball, project, example: true, install: false });
    const again = setupProject({ tarball, project, example: true, install: false });
    expect(again.changed).toEqual([]);
    // Also when pointed at the vendored copy itself.
    expect(setupProject({ tarball: join(project, "vendor", `ckb-verify-${VERSION}.tgz`), project, install: false }).changed).toEqual([]);
  });

  test("merges into an existing package.json and .gitignore without dropping anything", async () => {
    const project = await fresh();
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "my-dapp", version: "1.2.3", scripts: { build: "make" },
      dependencies: { "left-pad": "1.3.0", "@ckb-ccc/core": "1.12.5" }, overrides: { tar: "7.5.22", other: "1.0.0" }, packageManager: "bun@1.2.20" }));
    await writeFile(join(project, ".gitignore"), "dist\nnode_modules");
    const notes: string[] = [];
    setupProject({ tarball, project, example: true, install: false, log: (line) => notes.push(line) });
    const manifest = await json(join(project, "package.json"));
    expect(manifest).toMatchObject({ name: "my-dapp", version: "1.2.3", scripts: { build: "make" }, packageManager: "bun@1.2.20" });
    expect(manifest.dependencies).toMatchObject({ "left-pad": "1.3.0", "@ckb-ccc/core": "1.12.5", "ckb-verify": `file:vendor/ckb-verify-${VERSION}.tgz` });
    expect(manifest.overrides).toMatchObject({ other: "1.0.0", "adm-zip": "0.6.1", tar: "7.5.22" });
    expect(notes.some((line) => line.includes("packageManager is bun@1.2.20"))).toBe(true);
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe("dist\nnode_modules\n.ckb-verify/\n");
  });

  test("refuses to replace a conflicting pin and leaves package.json as it was", async () => {
    const project = await fresh();
    const original = JSON.stringify({ name: "my-dapp", overrides: { tar: "6.2.1" } });
    await writeFile(join(project, "package.json"), original);
    expect(() => setupProject({ tarball, project, install: false })).toThrow('package.json overrides["tar"] is "6.2.1"');
    expect(await readFile(join(project, "package.json"), "utf8")).toBe(original);
  });

  test("keeps an existing manifest and producer", async () => {
    const project = await fresh();
    await mkdir(join(project, "verify"));
    await writeFile(join(project, "verify.toml"), "# mine\n");
    await writeFile(join(project, "verify", "transfer.ts"), "// mine\n");
    setupProject({ tarball, project, example: true, install: false });
    expect(await readFile(join(project, "verify.toml"), "utf8")).toBe("# mine\n");
    expect(await readFile(join(project, "verify", "transfer.ts"), "utf8")).toBe("// mine\n");
  });

  test("without --example it writes no manifest, producer, or CCC dependency", async () => {
    const project = await fresh();
    setupProject({ tarball, project, install: false });
    expect((await readdir(project)).sort()).toEqual([".git", ".gitignore", "package.json", "patches", "vendor"]);
    expect((await json(join(project, "package.json"))).dependencies).toEqual({ "ckb-verify": `file:vendor/ckb-verify-${VERSION}.tgz` });
  });

  test("rejects a tarball that is not the ckb-verify package", async () => {
    const other = join(work, "other");
    await mkdir(join(other, "package"), { recursive: true });
    await writeFile(join(other, "package", "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
    await tar.c({ cwd: other, file: join(work, "other.tgz"), gzip: true }, ["package"]);
    expect(() => setupProject({ tarball: join(work, "other.tgz"), project: join(work, "nowhere"), install: false })).toThrow("is not a ckb-verify package");
    expect(() => setupProject({ tarball: join(work, "missing.tgz"), project: join(work, "nowhere"), install: false })).toThrow("no such tarball");
  });

  test("runs from the tarball alone: it imports only the standard library, and the tarball carries the example", async () => {
    const source = await readFile(join(root, "src", "setup-project.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
    const entries: string[] = [];
    await tar.t({ file: tarball, onReadEntry: (entry) => { entries.push(entry.path); } });
    expect(entries).toEqual(expect.arrayContaining(["package/src/setup-project.ts", "package/src/templates/secp-transfer-producer.ts"]));
    expect((await readFile(join(root, "src", "templates", "secp-transfer-producer.ts"))).equals(await readFile(join(root, "showcases", "secp-transfer", "produce.ts")))).toBe(true);
  });
});
