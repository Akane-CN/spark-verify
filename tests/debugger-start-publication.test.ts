import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OffckbDevnet } from "../src/offckb";
import { acquireRuntimeOwnership } from "../src/runtime-ownership";
import { runManifest } from "../src/runner";
import { lifecycleFixture } from "./debugger-integration-fixture";

function abortAtPublication(contextPath: string, controller: AbortController) {
  const writeFile = fs.writeFile;
  return spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await writeFile(...args);
    if (args[0] === contextPath) {
      // Let the initializer's final guard pass, then cancel before start()
      // publishes readiness. The context write itself still completes normally.
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
    }
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function assertLeaseReleased() {
  const lease = await acquireRuntimeOwnership();
  await lease.release();
}

test("start cleans owned runtime before rejecting readiness-publication cancellation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "debugger-start-publication-"));
  const fixture = lifecycleFixture(root);
  const controller = new AbortController();
  const devnet = new OffckbDevnet(fixture.options);
  const hook = abortAtPublication(fixture.paths.contextPath, controller);
  try {
    const error = await devnet.start(controller.signal).catch(error => error);
    expect(String(error)).toContain("interrupted");
    expect(controller.signal.aborted).toBe(true);
    expect(await Bun.file(fixture.paths.contextPath).exists()).toBe(true);
    expect(await Bun.file(fixture.paths.accountsPath).exists()).toBe(false);
    const stops = fixture.calls.filter(({ argv }) => argv[3] === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.options.signal).toBeUndefined();
    await assertLeaseReleased();
  } finally {
    hook.mockRestore();
    await devnet.stop();
    await fs.rm(root, { recursive: true, force: true });
    await assertLeaseReleased();
  }
});

test("runManifest cleans unpublished startup without dispatching or publishing a verdict", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "debugger-runner-publication-"));
  const fixture = lifecycleFixture(root);
  const manifestPath = join(root, "verify.toml");
  const outputDir = join(root, "evidence");
  await fs.writeFile(manifestPath, `[meta]
name = "publication-cancellation"
spec = "0.1.0-draft.3"
[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
ckb-debugger = "1.1.1"
[replay]
dependencies = []
[setup]
accounts = 1
[[step]]
name = "not-dispatched"
run = "never-execute"
expect.tx = "rejected"
`);
  const controller = new AbortController();
  const unexpected: string[] = [];
  const devnet = new OffckbDevnet({ ...fixture.options,
    prepareDebuggerBinary: async () => { unexpected.push("native preparation"); throw new Error("not admitted"); },
  });
  const hook = abortAtPublication(fixture.paths.contextPath, controller);
  try {
    const error = await runManifest({ manifestPath, projectRoot: root, outputDir, devnet,
      signal: controller.signal,
      runStep: async () => { unexpected.push("producer"); throw new Error("not admitted"); },
      rpc: async () => { unexpected.push("runner RPC"); throw new Error("not admitted"); },
    }).catch(error => error);
    expect(String(error)).toContain("interrupted");
    expect(unexpected).toEqual([]);
    expect(await Bun.file(join(outputDir, "report.json")).exists()).toBe(false);
    expect(await Bun.file(join(outputDir, ".report.json.pending")).exists()).toBe(false);
    expect(await Bun.file(fixture.paths.accountsPath).exists()).toBe(false);
    expect(fixture.calls.filter(({ argv }) => argv[3] === "stop")).toHaveLength(1);
    await assertLeaseReleased();
  } finally {
    hook.mockRestore();
    await devnet.stop();
    await fs.rm(root, { recursive: true, force: true });
    await assertLeaseReleased();
  }
});

test.each(["publication", "cleanup"])("publication cancellation shares deferred cleanup with stop at %s", async when => {
  const root = await fs.mkdtemp(join(tmpdir(), "debugger-publication-drain-"));
  const fixture = lifecycleFixture(root);
  const controller = new AbortController();
  const nodeEntered = deferred(); const nodeGate = deferred();
  const accountsEntered = deferred(); const accountsGate = deferred();
  let nodeStops = 0; let accountRemovals = 0; let nativeCalls = 0;
  let startSettled = false; let stopSettled = false;
  const devnet = new OffckbDevnet({ ...fixture.options,
    prepareDebuggerBinary: async () => { nativeCalls++; throw new Error("not admitted"); },
    run: async (argv, options) => {
      if (argv[3] === "stop") {
        nodeStops++;
        expect(options.signal).toBeUndefined();
        nodeEntered.resolve();
        await nodeGate.promise;
      }
      return fixture.options.run(argv, options);
    },
  });
  const remove = fs.rm;
  const removeHook = spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (args[0] === fixture.paths.accountsPath) {
      accountRemovals++;
      accountsEntered.resolve();
      await accountsGate.promise;
    }
    return remove(...args);
  });
  const hook = abortAtPublication(fixture.paths.contextPath, controller);
  let stopping: Promise<void> | undefined;
  if (when === "publication") controller.signal.addEventListener("abort", () => { stopping = devnet.stop(); }, { once: true });
  const starting = devnet.start(controller.signal).catch(error => error).finally(() => { startSettled = true; });
  try {
    // On the unfixed adapter this races an early rejection, not a timeout.
    expect(await Promise.race([nodeEntered.promise.then(() => "cleanup"), starting.then(() => "settled")])).toBe("cleanup");
    stopping ??= devnet.stop();
    expect(devnet.stop()).toBe(stopping);
    const stopped = stopping.then(() => { stopSettled = true; });
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    expect(startSettled).toBe(false); expect(stopSettled).toBe(false);
    expect(await Bun.file(fixture.paths.accountsPath).exists()).toBe(true);
    await expect(devnet.start()).rejects.toThrow("already started");
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("interrupted");
    await expect(devnet.debugScript(`0x${"22".repeat(32)}`, { cell: "input", index: 0, role: "lock" })).rejects.toThrow("interrupted");
    expect(nativeCalls).toBe(0);
    nodeGate.resolve();
    await accountsEntered.promise;
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    expect(startSettled).toBe(false); expect(stopSettled).toBe(false);
    expect(await Bun.file(fixture.paths.accountsPath).exists()).toBe(true);
    accountsGate.resolve();
    expect(String(await starting)).toContain("interrupted");
    await stopped;
    expect(await Bun.file(fixture.paths.accountsPath).exists()).toBe(false);
    const successor = await acquireRuntimeOwnership();
    try {
      await devnet.stop();
      await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    } finally { await successor.release(); }
    expect(nodeStops).toBe(1); expect(accountRemovals).toBe(1);
  } finally {
    nodeGate.resolve(); accountsGate.resolve();
    await starting;
    await (stopping ?? devnet.stop());
    hook.mockRestore(); removeHook.mockRestore();
    await devnet.stop();
    await fs.rm(root, { recursive: true, force: true });
    await assertLeaseReleased();
  }
});

test("publication cancellation preserves primary and cleanup failures after one teardown", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "debugger-publication-errors-"));
  const fixture = lifecycleFixture(root);
  const controller = new AbortController();
  const nodeEntered = deferred(); const nodeGate = deferred();
  const nodeError = new Error("node stop failed");
  const accountError = new Error("account cleanup failed");
  let nodeStops = 0; let accountRemovals = 0;
  const devnet = new OffckbDevnet({ ...fixture.options,
    run: async (argv, options) => {
      if (argv[3] === "stop") {
        nodeStops++;
        expect(options.signal).toBeUndefined();
        nodeEntered.resolve();
        await nodeGate.promise;
        throw nodeError;
      }
      return fixture.options.run(argv, options);
    },
  });
  const remove = fs.rm;
  const removeHook = spyOn(fs, "rm").mockImplementation(async (...args) => {
    await remove(...args);
    if (args[0] === fixture.paths.accountsPath) { accountRemovals++; throw accountError; }
  });
  const hook = abortAtPublication(fixture.paths.contextPath, controller);
  const starting = devnet.start(controller.signal).catch(error => error);
  let stopOutcome: Promise<unknown> | undefined;
  try {
    expect(await Promise.race([nodeEntered.promise.then(() => "cleanup"), starting.then(() => "settled")])).toBe("cleanup");
    const stopping = devnet.stop();
    stopOutcome = stopping.catch(error => error);
    expect(devnet.stop()).toBe(stopping);
    nodeGate.resolve();
    const error = await starting;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect(String(error.errors[0])).toBe("OffckbProtocolError: OffCKB setup interrupted");
    expect(error.errors[1]).toBeInstanceOf(AggregateError);
    expect(error.errors[1].errors).toEqual([nodeError, accountError]);
    expect(await stopOutcome).toBe(error.errors[1]);
    expect(await Bun.file(fixture.paths.accountsPath).exists()).toBe(false);
    await assertLeaseReleased();
    await devnet.stop();
    expect(nodeStops).toBe(1); expect(accountRemovals).toBe(1);
  } finally {
    nodeGate.resolve();
    await starting;
    await (stopOutcome ?? devnet.stop().catch(error => error));
    hook.mockRestore(); removeHook.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
    await assertLeaseReleased();
  }
});
