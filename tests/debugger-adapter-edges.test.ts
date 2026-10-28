import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OffckbDevnet } from "../src/offckb";
import { acquireRuntimeOwnership } from "../src/runtime-ownership";
import { assertVerifiedDebuggerExecutable, type PreparedDebuggerBinary } from "../src/debugger-binary";
import { inertDebugger, lifecycleFixture, success } from "./debugger-integration-fixture";
import type { CommandResult } from "../src/process";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "debugger-edges-")); roots.push(path); return path; }
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const HASH = `0x${"22".repeat(32)}`;
const SOURCE = { cell: "input", index: 0, role: "lock" } as const;

test("production preparation defaults reject an incomplete cache without any native dispatch", async () => {
  const f = lifecycleFixture(await root());
  const devnet = new OffckbDevnet(f.options);
  await devnet.start();
  const cache = join(f.paths.cacheHome, "verified-debugger", "1.1.1-linux-x64");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const calls = f.calls.length;
  try {
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow();
    expect(f.calls).toHaveLength(calls);
    expect(await readdir(cache)).toEqual([]);
  } finally { await devnet.stop(); }
});

test("stop before deferred preparation dispatch admits no native work", async () => {
  const f = lifecycleFixture(await root()); let nativeCalls = 0;
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: async () => { nativeCalls++; throw new Error("must not dispatch"); } });
  await devnet.start();
  const operation = devnet.prepareDebugger("1.1.1").catch(error => error);
  const stopping = devnet.stop();
  await stopping;
  expect(String(await operation)).toContain("interrupted");
  expect(nativeCalls).toBe(0);
});

test("mixed concurrent debug settlement drains every operation before lease release", async () => {
  const f = lifecycleFixture(await root()); const native = await inertDebugger(f.options.repositoryRoot);
  const entered = deferred<void>(); const first = deferred<CommandResult>(); const second = deferred<CommandResult>();
  let debugs = 0; let stopped = false;
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: native.prepare,
    run: async (argv, options) => {
      if (argv[2] === "debug") {
        if (++debugs === 2) entered.resolve();
        // Validation includes concurrent filesystem reads: dispatch order need
        // not match admission order. Tie each gate to its request, not timing.
        return argv[4] === HASH ? first.promise : second.promise;
      }
      return f.options.run(argv, options);
    },
  });
  await devnet.start(); await devnet.prepareDebugger("1.1.1");
  const a = devnet.debugScript(HASH, SOURCE).catch(error => error);
  const b = devnet.debugScript(`0x${"33".repeat(32)}`, SOURCE).catch(error => error);
  await entered.promise;
  const stopping = devnet.stop().then(() => { stopped = true; });
  const failure = new Error("debug failure");
  try {
    first.resolve({ ...success("debug"), exitCode: 1 });
    expect(String(await a)).toContain("interrupted");
    expect(stopped).toBe(false);
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    expect(await Bun.file(f.paths.accountsPath).exists()).toBe(true);
    await expect(devnet.debugScript(HASH, SOURCE)).rejects.toThrow("interrupted");
    expect(debugs).toBe(2);
    second.reject(failure); expect(await b).toBe(failure);
  } finally { first.resolve(success("debug")); second.reject(failure); await Promise.all([a, b]); await stopping; }
  const owner = await acquireRuntimeOwnership();
  try { await devnet.stop(); await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy"); }
  finally { await owner.release(); }
});

test.each(["version", "debug"])("run cancellation during verification prevents %s dispatch", async stage => {
  const f = lifecycleFixture(await root()); const native = await inertDebugger(f.options.repositoryRoot);
  const controller = new AbortController(); let verifies = 0;
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: native.prepare,
    verifyDebuggerBinary: async (cap, signal) => {
      await assertVerifiedDebuggerExecutable(cap, signal);
      if (++verifies === (stage === "version" ? 1 : 2)) controller.abort();
    },
  });
  await devnet.start(controller.signal);
  try {
    if (stage === "debug") await devnet.prepareDebugger("1.1.1");
    const calls = f.calls.length;
    await expect(stage === "version" ? devnet.prepareDebugger("1.1.1") : devnet.debugScript(HASH, SOURCE)).rejects.toThrow("interrupted");
    expect(f.calls).toHaveLength(calls);
  } finally { await devnet.stop(); }
});

test.each(["ckb-debugger 1.1.10", "ckb-debugger 1.1.1 extra", "ckb-debugger 1.1.1\nextra", "exit", "timeout"])("refuses non-exact version observation %s", async observation => {
  const f = lifecycleFixture(await root()); const native = await inertDebugger(f.options.repositoryRoot);
  let cap: PreparedDebuggerBinary | undefined;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => { cap = await native.prepare(options); return cap; },
    run: async (argv, options) => argv[0] === cap?.path ? { ...success("version"), stdout: observation,
      exitCode: observation === "exit" ? 1 : 0, timedOut: observation === "timeout" } : f.options.run(argv, options),
  });
  await devnet.start();
  try {
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("does not match required");
    await expect(devnet.debugScript(HASH, SOURCE)).rejects.toThrow("not prepared");
    expect(await Bun.file(cap!.path).exists()).toBe(false);
  } finally { await devnet.stop(); }
});

test("preparation failure preserves primary and awaited cleanup failure", async () => {
  const f = lifecycleFixture(await root()); const native = await inertDebugger(f.options.repositoryRoot);
  const entered = deferred<void>(); const cleanupGate = deferred<void>(); const failure = new Error("cleanup failure");
  let settled = false;
  const devnet = new OffckbDevnet({ ...f.options,
    prepareDebuggerBinary: async options => {
      const cap = await native.prepare(options);
      return { ...cap, cleanup: async () => { entered.resolve(); await cleanupGate.promise; await cap.cleanup(); throw failure; } };
    },
    // A cloned capability is invalid to the real verifier, deliberately.
  });
  await devnet.start();
  const operation = devnet.prepareDebugger("1.1.1").catch(error => error).finally(() => { settled = true; });
  await entered.promise;
  try {
    expect(settled).toBe(false);
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
  } finally { cleanupGate.resolve(); await operation; await devnet.stop(); }
  const error = await operation;
  expect(error).toBeInstanceOf(AggregateError);
  expect(String(error.errors[0])).toContain("capability");
  expect(error.errors[1]).toBe(failure);
});

test("stop removes only the snapshot and retains the verified inert cache", async () => {
  const f = lifecycleFixture(await root()); const native = await inertDebugger(f.options.repositoryRoot);
  const devnet = new OffckbDevnet({ ...f.options, prepareDebuggerBinary: native.prepare });
  await devnet.start(); await devnet.prepareDebugger("1.1.1");
  const cache = join(f.paths.cacheHome, "verified-debugger", "1.1.1-linux-x64");
  const entries = (await readdir(cache)).sort();
  const bytes = await Promise.all(entries.map(name => Bun.file(join(cache, name)).bytes()));
  await devnet.stop();
  expect((await readdir(cache)).sort()).toEqual(entries);
  expect(await Promise.all(entries.map(name => Bun.file(join(cache, name)).bytes()))).toEqual(bytes);
  expect(await readdir(join(f.paths.dataHome, "offckb-nodejs/debugger-runs"))).toEqual([]);
});
