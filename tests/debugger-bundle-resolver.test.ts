import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { OffckbDevnet } from "../src/offckb";
import { inertDebugger, lifecycleFixture } from "./debugger-integration-fixture";

const bundlePath = fileURLToPath(new URL("../node_modules/@offckb/cli/build/index.js", import.meta.url));
const requireFromBundle = createRequire(bundlePath);

// Evaluate ONLY these installed module factories, never the OffCKB entrypoint.
// All process APIs are intercepted; network/extractor modules are inert stubs.
function resolver(env: NodeJS.ProcessEnv) {
  const bundle = readFileSync(bundlePath, "utf8");
  const fakeProcess = { env: { ...env }, platform: "linux", arch: "x64" };
  const calls: Array<{ method: string; binary: string; args: string[] }> = [];
  const builtins: Record<number, string> = { 79896: "node:fs", 16928: "node:path", 70857: "node:os" };
  const cache = new Map<number, any>();
  function load(id: number): any {
    if (builtins[id]) return requireFromBundle(builtins[id]!);
    if (id === 932) return fakeProcess;
    if (id === 35317) return {
      spawnSync: (binary: string, args: string[]) => { calls.push({ method: "spawnSync", binary, args }); return { status: 1 }; },
      execFileSync: (binary: string, args: string[]) => { calls.push({ method: "execFileSync", binary, args }); },
    };
    if (id === 65370) return { logger: { info() {}, warn() {}, error(...args: unknown[]) { throw new Error(String(args)); } } };
    if ([76982, 65897, 37293, 39534].includes(id)) return Object.freeze({});
    if (![25546, 73565, 42129, 14815, 93004].includes(id)) throw new Error(`unapproved bundle module ${id}`);
    if (cache.has(id)) return cache.get(id);
    const sections = bundle.split(`/***/ ${id}:\n`);
    expect(sections).toHaveLength(2);
    const factory = sections[1]!.split("\n\n/***/ }),")[0]!;
    const body = factory.slice(factory.indexOf("\n\n") + 2);
    const module = { exports: {} }; cache.set(id, module.exports);
    new Function("module", "exports", "__nccwpck_require__", "process", "require", "__filename", body)(
      module, module.exports, load, fakeProcess,
      Object.assign((name: string) => {
        if (name === "tar") return Object.freeze({}); // Patched import; never extract here.
        throw new Error(`unapproved bundle require ${name}`);
      }, { main: { filename: bundlePath } }), bundlePath,
    );
    return module.exports;
  }
  return { debugger: load(14815).CKBDebugger, settings: load(25546), config: load(93004), calls, env: fakeProcess.env };
}

test("installed OffCKB settings and resolver select the adapter's private path without ambient probing", async () => {
  const root = await mkdtemp(join(tmpdir(), "debugger-bundle-"));
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  let selected = "";
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: native.prepare,
    run: async (argv, options) => {
      if (argv[2] === "debug") {
        expect(options.env?.OFFCKB_DEBUGGER_GUARD).toBe("1");
        const actual = resolver(options.env!);
        expect(actual.settings.configPath).toBe(join(f.paths.configHome, "offckb-nodejs/settings.json"));
        expect(actual.settings.readSettings().bins.defaultCKBVersion).toBe("0.209.0");
        expect(Object.values(actual.config.ConfigItem).sort()).toEqual(["ckb-version", "proxy"]);
        expect(actual.debugger.resolveBinaryPath()).toBe(selected);
        expect(actual.calls).toEqual([]);
        actual.debugger.execute(["--fixture-only"]);
        expect(actual.calls).toEqual([{ method: "execFileSync", binary: selected, args: ["--fixture-only"] }]);
        // Negative control: the real resolver probes PATH if guard is absent.
        delete actual.env.OFFCKB_DEBUGGER_GUARD;
        expect(actual.debugger.resolveBinaryPath()).toBe(selected);
        expect(actual.calls.at(-1)).toEqual({ method: "spawnSync", binary: "ckb-debugger", args: ["--version"] });
      } else if (argv[1] === "--version" && argv[0] !== f.paths.offckbBinary) selected = argv[0]!;
      return f.options.run(argv, options);
    },
  });
  try {
    await devnet.start(); await devnet.prepareDebugger("1.1.1");
    expect((await devnet.debugScript(`0x${"22".repeat(32)}`, { cell: "input", index: 0, role: "lock" })).exitCode).toBe(1);
    expect(f.calls.filter(({ argv }) => argv[2] === "config").map(({ argv }) => argv.slice(2))).toEqual([["config", "set", "ckb-version", "0.209.0"]]);
  } finally { await devnet.stop(); await rm(root, { recursive: true, force: true }); }
});
