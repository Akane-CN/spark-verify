import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import * as tar from "tar";
import { SCHEMA_FILES } from "../src/schemas";
import { VERSION } from "../src/version";

// The distributable must carry every file the runtime reads and nothing from the development checkout.
const root = join(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string; version: string; bin: Record<string, string>; files: string[];
  dependencies: Record<string, string>; devDependencies: Record<string, string>; patchedDependencies: Record<string, string>;
};

async function packed(): Promise<Map<string, number>> {
  const destination = await mkdtemp(join(tmpdir(), "ckb-verify-pack-"));
  try {
    const result = Bun.spawnSync(["bun", "pm", "pack", "--destination", destination], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const [tarball] = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
    expect(tarball).toBe(`${manifest.name}-${manifest.version}.tgz`);
    const entries = new Map<string, number>();
    await tar.t({ file: join(destination, tarball!), onReadEntry: (entry) => { entries.set(entry.path.replace(/^package\//, ""), entry.mode ?? 0); } });
    return entries;
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

describe("package layout", () => {
  test("version is pinned identically in package.json, src/version.ts, and the changelog", async () => {
    expect(manifest.version).toBe(VERSION);
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(new RegExp(`^## ${VERSION.replaceAll(".", "\\.")} — \\d{4}-\\d{2}-\\d{2}$`, "m"));
  });

  test("the tarball carries the bin, every runtime import, schema, and patch, and nothing from the checkout", async () => {
    const entries = await packed();
    const paths = [...entries.keys()];

    const bin = manifest.bin["ckb-verify"]!;
    expect(bin).toBe("./src/cli.ts");
    expect(entries.has("src/cli.ts")).toBe(true);
    expect((entries.get("src/cli.ts")! & 0o111) !== 0).toBe(true);
    expect((await readFile(join(root, "src/cli.ts"), "utf8")).startsWith("#!/usr/bin/env bun\n")).toBe(true);

    const sources = (await readdir(join(root, "src"))).filter((name) => name.endsWith(".ts")).sort();
    expect(paths.filter((path) => path.startsWith("src/")).sort()).toEqual(sources.map((name) => `src/${name}`));
    const bare = new Set<string>();
    for (const name of sources) {
      const text = await readFile(join(root, "src", name), "utf8");
      for (const match of text.matchAll(/^(?:import|export)[^"']*from\s+"([^"]+)"/gm)) {
        const specifier = match[1]!;
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const resolved = posix.normalize(posix.join("src", specifier)) + ".ts";
          expect(entries.has(resolved)).toBe(true);
        } else {
          bare.add(packageName(specifier));
        }
      }
    }
    expect([...bare].sort()).toEqual([...bare].filter((name) => name in manifest.dependencies).sort());
    expect([...bare].filter((name) => name in manifest.devDependencies)).toEqual([]);
    // Every runtime dependency is imported by src or is a redirect target of the shipped OffCKB patch.
    const patchTargets = ["@offckb/cli", "follow-redirects"];
    expect(Object.keys(manifest.dependencies).filter((name) => !bare.has(name) && !patchTargets.includes(name))).toEqual([]);

    for (const file of Object.values(SCHEMA_FILES)) expect(entries.has(`schemas/${file}`)).toBe(true);
    for (const patch of Object.values(manifest.patchedDependencies)) expect(entries.has(patch)).toBe(true);
    for (const required of ["package.json", "LICENSE", "README.md", "SECURITY.md", "docs/install.md", "docs/offline-verification.md"]) {
      expect(entries.has(required)).toBe(true);
    }
    for (const forbidden of ["tests/", "showcases/", "scripts/", ".github/", "docs/media/", "docs/acceptance/", "docs/plans/", "node_modules/", ".ckb-verify/"]) {
      expect(paths.filter((path) => path.startsWith(forbidden))).toEqual([]);
    }
    for (const name of ["bun.lock", "tsconfig.json", ".env", ".markdownlint-cli2.jsonc"]) expect(entries.has(name)).toBe(false);
    expect(paths.every((path) => manifest.files.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)) ||
      ["package.json", "LICENSE", "README.md"].includes(path))).toBe(true);
  }, 60_000);
});
