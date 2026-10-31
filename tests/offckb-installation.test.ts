import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OffckbDevnet } from "../src/offckb";
import { OffckbInstallationError, assertInstalledOffckb, resolveOffckbPackage } from "../src/supply-chain";
import { lifecycleFixture } from "./debugger-integration-fixture";

const root = join(import.meta.dir, "..");

test("the development checkout resolves the patched OffCKB from ckb-verify's own tree", async () => {
  const installed = await assertInstalledOffckb();
  expect(installed.packageRoot).toBe(join(root, "node_modules", "@offckb", "cli"));
  expect(installed.binaryPath).toBe(join(installed.packageRoot, "build", "index.js"));
  expect(resolveOffckbPackage()).toBe(installed.packageRoot);
  expect((await readFile(installed.binaryPath, "utf8")).startsWith("#!/usr/bin/env node")).toBe(true);
});

async function fakeTree(options: { version?: string; bundle?: string; admZip?: string }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "offckb-install-"));
  const caller = join(directory, "caller");
  await mkdir(join(caller, "node_modules", "@offckb", "cli", "build"), { recursive: true });
  await writeFile(join(caller, "package.json"), '{"name":"caller"}');
  await writeFile(join(caller, "node_modules", "@offckb", "cli", "package.json"), JSON.stringify({ name: "@offckb/cli", version: options.version ?? "0.4.13" }));
  const patched = 'const adm_zip_1 = __importDefault(require("adm-zip"));\n'.repeat(2) + 'const tar = __importStar(require("tar"));\n'.repeat(2) +
    'followRedirects = require("follow-redirects");\n' + 'return server.listen(port, "127.0.0.1", () => {\n';
  await writeFile(join(caller, "node_modules", "@offckb", "cli", "build", "index.js"), options.bundle ?? patched);
  const libraries: Array<[string, string]> = [["adm-zip", options.admZip ?? "0.6.1"], ["tar", "7.5.22"], ["follow-redirects", "1.16.2"]];
  for (const [name, version] of libraries) {
    await mkdir(join(caller, "node_modules", name), { recursive: true });
    await writeFile(join(caller, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  }
  return caller;
}

test.each([
  ["an unpatched bundle", { bundle: "__nccwpck_require__(3858); __nccwpck_require__(7222);" }, "bundled vulnerable"],
  ["a wildcard-bound proxy", { bundle: 'const adm_zip_1 = __importDefault(require("adm-zip"));\n'.repeat(2) + 'const tar = __importStar(require("tar"));\n'.repeat(2) +
    'followRedirects = require("follow-redirects");\nreturn server.listen(port, () => {\n' }, "wildcard RPC proxy listen"],
  ["a different OffCKB version", { version: "0.4.14" }, "expected @offckb/cli@0.4.13"],
  ["a wrong resolved archive library", { admZip: "0.5.16" }, "expected adm-zip@0.6.1"],
])("an installation with %s is refused before any devnet work", async (_label, options, message) => {
  const caller = await fakeTree(options);
  try {
    const promise = assertInstalledOffckb(Bun.pathToFileURL(join(caller, "entry.js")).href);
    await expect(promise).rejects.toBeInstanceOf(OffckbInstallationError);
    await expect(promise).rejects.toThrow(message);
    await expect(promise).rejects.toThrow("docs/install.md");
  } finally { await rm(join(caller, ".."), { recursive: true, force: true }); }
});

test("a consistent fake installation passes and reports the entry the shim links to", async () => {
  const caller = await fakeTree({});
  try {
    const installed = await assertInstalledOffckb(Bun.pathToFileURL(join(caller, "entry.js")).href);
    expect(installed.binaryPath).toBe(join(caller, "node_modules", "@offckb", "cli", "build", "index.js"));
  } finally { await rm(join(caller, ".."), { recursive: true, force: true }); }
});

test("a missing OffCKB package is a clear installation error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offckb-missing-"));
  try {
    await writeFile(join(directory, "package.json"), '{"name":"empty"}');
    await expect(assertInstalledOffckb(Bun.pathToFileURL(join(directory, "entry.js")).href)).rejects.toThrow("not installed next to ckb-verify");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the adapter refuses to start, runs no command, and releases ownership when the installation check fails", async () => {
  const repository = await mkdtemp(join(tmpdir(), "offckb-adapter-install-"));
  try {
    const f = lifecycleFixture(repository);
    const devnet = new OffckbDevnet({ ...f.options, verifyInstallation: async () => { throw new OffckbInstallationError("OffCKB installation is not the verified patched build: fixture"); } });
    await expect(devnet.start()).rejects.toThrow("not the verified patched build");
    expect(f.calls).toEqual([]);
    expect(await Bun.file(devnet.paths.accountsPath).exists()).toBe(false);
    const again = new OffckbDevnet(f.options); // ownership must have been released
    const context = await again.start();
    expect(context.network).toBe("devnet");
    await again.stop();
  } finally { await rm(repository, { recursive: true, force: true }); }
});
