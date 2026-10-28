import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OffckbDevnet } from "../src/offckb";
import { acquireRuntimeOwnership } from "../src/runtime-ownership";
import { inertDebugger, lifecycleFixture } from "./debugger-integration-fixture";
import { assertVerifiedDebuggerExecutable, type PreparedDebuggerBinary } from "../src/debugger-binary";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const HASH = `0x${"22".repeat(32)}`;
const SOURCE = { cell: "input", index: 0, role: "lock" } as const;

test("debugger admission does zero work until startup has fully succeeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "debugger-admission-")); roots.push(root);
  const entered = deferred<void>(); const setup = deferred<void>();
  let work = 0;
  const devnet = new OffckbDevnet({ repositoryRoot: root, ckbVersion: "0.209.0", accountCount: 1, verifyInstallation: async () => {},
    preflight: async () => { entered.resolve(); await setup.promise; },
    run: async () => { work++; throw new Error("unexpected process"); },
  });
  await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("runtime is not owned");
  const owner = await acquireRuntimeOwnership();
  try {
    await expect(devnet.start()).rejects.toThrow("runtime busy");
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("runtime is not owned");
  } finally { await owner.release(); }
  const starting = devnet.start().catch(error => error);
  await entered.promise;
  try {
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("not ready");
    await expect(devnet.debugScript(HASH, SOURCE)).rejects.toThrow("not ready");
    expect(work).toBe(0);
    expect(await Bun.file(devnet.paths.accountsPath).exists()).toBe(false);
  } finally { setup.reject(new Error("setup failed")); await starting; await devnet.stop(); }
  const next = await acquireRuntimeOwnership(); await next.release();
});

test("preparation coalesces one private verified snapshot and preserves owned settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "debugger-prepare-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  let preparations = 0; let verifications = 0; let capability: PreparedDebuggerBinary | undefined;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => { preparations++; capability = await native.prepare(options); return capability; },
    verifyDebuggerBinary: async (value, signal) => { verifications++; await assertVerifiedDebuggerExecutable(value, signal); },
  });
  await devnet.start();
  try {
    const [a, b] = await Promise.all([devnet.prepareDebugger("1.1.1"), devnet.prepareDebugger("1.1.1")]);
    expect(a).toEqual({ version: "ckb-debugger 1.1.1", binary: capability!.evidence });
    expect(b).toEqual(a);
    expect(await devnet.prepareDebugger("1.1.1")).toEqual(a);
    expect(preparations).toBe(1); expect(verifications).toBe(1);
    await expect(devnet.prepareDebugger("1.2.0")).rejects.toThrow();
    const settings = await Bun.file(join(f.paths.configHome, "offckb-nodejs/settings.json")).json();
    expect(settings).toEqual({ bins: { defaultCKBVersion: "0.209.0" }, tools: { ckbTui: { version: "v0.1.4" }, rootFolder: capability!.directory } });
    expect(capability!.directory.startsWith(join(f.paths.dataHome, "offckb-nodejs") + "/")).toBe(true);
    expect(f.calls.at(-1)!.argv).toEqual([capability!.path, "--version"]);
    expect(f.calls.at(-1)!.options.env?.OFFCKB_DEBUGGER_GUARD).toBe("1");
    expect(f.calls.some(({ argv }) => argv.includes("install"))).toBe(false);
  } finally { await devnet.stop(); }
  expect(await Bun.file(capability!.path).exists()).toBe(false);
});

test.each(["unprepared", "settings", "binary", "capability", "valid"])("debug validates %s before dispatch", async damage => {
  const root = await mkdtemp(join(tmpdir(), "debugger-check-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  let capability: PreparedDebuggerBinary | undefined;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => { capability = await native.prepare(options); return damage === "capability" ? { ...capability } : capability; },
  });
  await devnet.start();
  try {
    if (damage === "capability") {
      await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("capability");
      expect(f.calls.filter(({ argv }) => argv[0] === capability?.path)).toHaveLength(0);
    } else if (damage !== "unprepared") await devnet.prepareDebugger("1.1.1");
    if (damage === "settings") await writeFile(join(f.paths.configHome, "offckb-nodejs/settings.json"), '{"tools":{"rootFolder":"/ambient"}}');
    if (damage === "binary") { await chmod(capability!.path, 0o600); await writeFile(capability!.path, "tampered"); await chmod(capability!.path, 0o500); }
    const before = f.calls.length;
    if (damage === "valid") {
      const result = await devnet.debugScript(HASH, SOURCE);
      expect(result.exitCode).toBe(1);
      expect(f.calls.at(-1)!.options.env?.OFFCKB_DEBUGGER_GUARD).toBe("1");
      expect(f.calls.at(-1)!.argv.slice(2)).toEqual(["debug", "--tx-hash", HASH, "--single-script", "input[0].lock"]);
    } else {
      await expect(devnet.debugScript(HASH, SOURCE)).rejects.toThrow();
      expect(f.calls).toHaveLength(before);
    }
  } finally { await devnet.stop(); }
});

test.each(["native", "version", "debug validation", "debug process"])("stop cancels and drains whole %s operation", async phase => {
  const root = await mkdtemp(join(tmpdir(), "debugger-drain-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  const entered = deferred<void>(); const gate = deferred<void>();
  const cleaning = deferred<void>(); const cleanupGate = deferred<void>();
  let signal: AbortSignal | undefined; let cap: PreparedDebuggerBinary | undefined; let verifies = 0;
  let settled = false; let stopped = false;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => {
      cap = await native.prepare(options);
      const cleanup = cap.cleanup;
      cap = { ...cap, cleanup: async () => { cleaning.resolve(); await cleanupGate.promise; await cleanup(); } };
      if (phase === "native") { signal = options.signal; entered.resolve(); await gate.promise; }
      return cap;
    },
    verifyDebuggerBinary: async (_value, currentSignal) => {
      if (++verifies === 2 && phase === "debug validation") { signal = currentSignal; entered.resolve(); await gate.promise; }
    },
    run: async (argv, options) => {
      if ((phase === "version" && argv[0] === cap?.path) || (phase === "debug process" && argv[2] === "debug")) {
        signal = options.signal; entered.resolve(); await gate.promise;
      }
      return f.options.run(argv, options);
    },
  });
  await devnet.start();
  if (phase.startsWith("debug")) await devnet.prepareDebugger("1.1.1");
  const operation = (phase.startsWith("debug") ? devnet.debugScript(HASH, SOURCE) : devnet.prepareDebugger("1.1.1"))
    .catch(error => error).finally(() => { settled = true; });
  await entered.promise;
  const stopping = devnet.stop().then(() => { stopped = true; });
  expect(devnet.stop()).toBe(devnet.stop());
  try {
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false); expect(stopped).toBe(false);
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("interrupted");
    await expect(devnet.debugScript(HASH, SOURCE)).rejects.toThrow("interrupted");
    expect(await Bun.file(f.paths.accountsPath).exists()).toBe(true);
    expect(f.calls.some(({ argv }) => argv[3] === "stop")).toBe(false);
    gate.resolve(); await cleaning.promise;
    expect(stopped).toBe(false);
    if (!phase.startsWith("debug")) expect(settled).toBe(false);
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
  } finally { gate.resolve(); cleanupGate.resolve(); await operation; await stopping; }
  expect(String(await operation)).toContain("interrupted");
  expect(await Bun.file(cap!.path).exists()).toBe(false);
  const next = await acquireRuntimeOwnership(); await next.release();
  await devnet.stop();
});

test.each(['{"proxy":"bad"}', '{"tools":{"ckbTui":{"version":42}}}', '{"bins":null}', '[]', '{broken'])("malformed settings %s cannot silently select bundle defaults", async contents => {
  const root = await mkdtemp(join(tmpdir(), "debugger-malformed-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: native.prepare });
  await devnet.start();
  try {
    const settingsPath = join(f.paths.configHome, "offckb-nodejs/settings.json");
    await writeFile(settingsPath, contents);
    const before = f.calls.length;
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    expect(await Bun.file(settingsPath).text()).toBe(contents);
  } finally { await devnet.stop(); }
});

test("stop preserves all cleanup failures without skipping snapshot or lease cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "debugger-cleanup-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  const stopError = new Error("stop failed"); const snapshotError = new Error("snapshot cleanup failed");
  let cleanups = 0;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => {
      const cap = await native.prepare(options);
      return { ...cap, cleanup: async () => { cleanups++; await cap.cleanup(); throw snapshotError; } };
    },
    verifyDebuggerBinary: async () => {},
    run: async (argv, options) => {
      if (argv[3] === "stop") { expect(options.signal).toBeUndefined(); throw stopError; }
      return f.options.run(argv, options);
    },
  });
  await devnet.start(); await devnet.prepareDebugger("1.1.1");
  await rm(f.paths.accountsPath); await mkdir(f.paths.accountsPath);
  const error = await devnet.stop().catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toContain(stopError);
  expect(error.errors).toContain(snapshotError);
  expect(error.errors).toHaveLength(3);
  expect(cleanups).toBe(1);
  const next = await acquireRuntimeOwnership(); await next.release();
});

test.each(["readFile", "writeFile"] as const)("stop drains settings %s and prevents subsequent work", async phase => {
  const root = await mkdtemp(join(tmpdir(), "debugger-settings-drain-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: native.prepare });
  await devnet.start();
  const path = join(f.paths.configHome, "offckb-nodejs/settings.json");
  const originalSettings = await Bun.file(path).text();
  const entered = deferred<void>(); const gate = deferred<void>();
  const originalRead = fs.readFile; const originalWrite = fs.writeFile;
  const hold = async (target: unknown) => { if (target === path) { entered.resolve(); await gate.promise; } };
  const hook = phase === "readFile"
    ? spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => { await hold(args[0]); return originalRead(...args); }) as typeof fs.readFile)
    : spyOn(fs, "writeFile").mockImplementation(async (...args) => { await hold(args[0]); return originalWrite(...args); });
  let settled = false;
  const preparing = devnet.prepareDebugger("1.1.1").catch(error => error).finally(() => { settled = true; });
  await entered.promise;
  let stopped = false; const stopping = devnet.stop().then(() => { stopped = true; });
  try {
    expect(settled).toBe(false); expect(stopped).toBe(false);
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    expect(await Bun.file(f.paths.accountsPath).exists()).toBe(true);
  } finally { gate.resolve(); await preparing; await stopping; hook.mockRestore(); }
  expect(String(await preparing)).toContain("interrupted");
  if (phase === "readFile") expect(await Bun.file(path).text()).toBe(originalSettings);
  expect(f.calls.filter(({ argv }) => argv[1] === "--version")).toHaveLength(1);
});

test("preparation reads back owned settings before version dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "debugger-readback-")); roots.push(root);
  const f = lifecycleFixture(root); const native = await inertDebugger(root);
  let cap: PreparedDebuggerBinary | undefined;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => { cap = await native.prepare(options); return cap; },
    verifyDebuggerBinary: async (value, signal) => {
      await assertVerifiedDebuggerExecutable(value, signal);
      await writeFile(join(f.paths.configHome, "offckb-nodejs/settings.json"), '{"tools":{"rootFolder":"/wrong"}}');
    },
  });
  await devnet.start();
  try {
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("settings");
    expect(f.calls.some(({ argv }) => argv[0] === cap!.path)).toBe(false);
    expect(await Bun.file(cap!.path).exists()).toBe(false);
  } finally { await devnet.stop(); }
});
