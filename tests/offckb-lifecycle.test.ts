import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OffckbDevnet,
  createOffckbPaths,
  waitForLocalEndpointsClosed,
  type OffckbCommandRunner,
} from "../src/offckb";
import type { CommandResult } from "../src/process";
import { acquireRuntimeOwnership } from "../src/runtime-ownership";
import { inertDebugger, lifecycleFixture } from "./debugger-integration-fixture";

const directories: string[] = [];
const HASH = `0x${"22".repeat(32)}`;
const KEY = `0x${"11".repeat(32)}`;

function fixtureCkbBinary(repository: string) {
  return {
    path: join(repository, "verified-ckb"),
    version: "0.209.0",
    platform: "linux" as const,
    architecture: "x64",
    asset: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
    sourceUrl: "https://github.com/nervosnetwork/ckb/releases/download/v0.209.0/fixture.tar.gz",
    expectedArchiveSha256: `sha256:${"1".repeat(64)}` as const,
    archiveSha256: `sha256:${"1".repeat(64)}` as const,
    binarySha256: `sha256:${"2".repeat(64)}` as const,
  };
}

function success(command: string, fields: Record<string, unknown> = {}): CommandResult {
  return {
    stdout: `${JSON.stringify({ ok: true, command, ...fields })}\n`,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("OffCKB endpoint shutdown", () => {
  test("waits until every local endpoint stops accepting connections", async () => {
    let probes = 0;
    await waitForLocalEndpointsClosed(["http://127.0.0.1:8114"], {
      timeoutMs: 100,
      intervalMs: 1,
      probe: async () => ++probes < 3,
    });

    expect(probes).toBe(3);
  });

  test("fails instead of silently leaving a listener behind", async () => {
    await expect(
      waitForLocalEndpointsClosed(["http://127.0.0.1:28114"], {
        timeoutMs: 5,
        intervalMs: 1,
        probe: async () => true,
      }),
    ).rejects.toThrow("OffCKB endpoints did not close");
  });
});

describe("OffckbDevnet", () => {
  test("install commands require runtime ownership", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-unowned-install-"));
    directories.push(repository);
    let calls = 0;
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
      run: async () => { calls++; return success("install"); },
    });
    await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("runtime is not owned");
    expect(calls).toBe(0);
  });

  test.each(["unstarted", "losing"])("debug refuses the %s runner without executing a command", async (state) => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-unowned-debug-"));
    directories.push(repository);
    let calls = 0;
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
      run: async () => { calls++; return success("debug"); },
    });
    const owner = state === "losing" ? await acquireRuntimeOwnership() : undefined;
    try {
      if (owner !== undefined) await expect(devnet.start()).rejects.toThrow("runtime busy");
      await expect(devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" }))
        .rejects.toThrow("runtime is not owned");
      expect(calls).toBe(0);
    } finally {
      await devnet.stop();
      await owner?.release();
    }
  });

  test("an aborted setup drains installation without launching or retaining ownership", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-aborted-setup-"));
    directories.push(repository);
    const controller = new AbortController();
    const calls: string[] = [];
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
      installCkbBinary: async () => { controller.abort(); return fixtureCkbBinary(repository); },
      run: async (argv) => {
        calls.push(argv.slice(1).join(" "));
        if (argv[1] === "--version") return { ...success("version"), stdout: "0.4.13\n" };
        throw new Error("must not launch after abort");
      },
    });
    await expect(devnet.start(controller.signal)).rejects.toThrow("interrupted");
    expect(calls).toEqual(["--version"]);
    const next = await acquireRuntimeOwnership();
    await next.release();
  });

  test("stop during installation keeps ownership until in-flight setup settles", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-stop-setup-"));
    directories.push(repository);
    let entered!: () => void;
    const installing = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const calls: string[] = [];
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
      installCkbBinary: async () => { entered(); await pending; return fixtureCkbBinary(repository); },
      run: async (argv) => {
        calls.push(argv.slice(1).join(" "));
        if (argv[1] === "--version") return { ...success("version"), stdout: "0.4.13\n" };
        throw new Error("must not launch after stop");
      },
    });
    const starting = devnet.start();
    const outcome = starting.catch((error: unknown) => error);
    await installing;
    let stopped = false;
    const stopping = devnet.stop().then(() => { stopped = true; });
    try {
      await Bun.sleep(10);
      expect(stopped).toBe(false);
      finish();
      expect(String(await outcome)).toContain("interrupted");
      await stopping;
      expect(calls).toEqual(["--version"]);
      const next = await acquireRuntimeOwnership();
      await next.release();
    } finally {
      finish();
      await outcome;
      await stopping;
      await devnet.stop();
    }
  });

  test.each(["preflight", "--version", "config", "clean", "node", "devnet"])(
    "stop at the %s await boundary prevents further setup mutations", async (boundary) => {
      const repository = await mkdtemp(join(tmpdir(), "ckb-verify-await-stop-"));
      directories.push(repository);
      const calls: string[] = [];
      let stopping: Promise<void> | undefined;
      const devnet = new OffckbDevnet({
        repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
        preflight: async () => { if (boundary === "preflight") stopping = devnet.stop(); },
        installCkbBinary: async () => { calls.push("install"); return fixtureCkbBinary(repository); },
        run: async (argv) => {
          const operation = argv[3] === "stop" ? "stop" : argv[2] ?? argv[1] ?? "unknown";
          calls.push(operation);
          if (operation === boundary) stopping = devnet.stop();
          if (operation === "--version") return { ...success("version"), stdout: "0.4.13\n" };
          return success(operation);
        },
      });
      await expect(devnet.start()).rejects.toThrow("interrupted");
      await stopping;
      if (boundary === "preflight") expect(calls).toEqual([]);
      else {
        expect(calls.slice(calls.indexOf(boundary) + 1)).toEqual(
          ["node", "devnet"].includes(boundary) ? ["stop"] : [],
        );
      }
      const next = await acquireRuntimeOwnership();
      await next.release();
    },
  );

  // #16 forbids install/debug overlap with startup. Native drains after readiness
  // are covered in debugger-integration.test.ts, without weakening lease checks.
  test.each(["preflight", "system-scripts", "system-scripts with stop failure"])(
    "startup failure at %s refuses native work and retains ownership through cleanup", async boundary => {
      const repository = await mkdtemp(join(tmpdir(), "ckb-verify-startup-drain-"));
      directories.push(repository);
      const setupEntered = deferred<void>(); const setup = deferred<void>();
      const cleanupEntered = deferred<void>(); const cleanup = deferred<void>();
      const startupError = new Error("setup failed"); const cleanupError = new Error("stop failed");
      let nativeCalls = 0; let startupSettled = false;
      const f = lifecycleFixture(repository);
      const devnet = new OffckbDevnet({ ...f.options,
        prepareDebuggerBinary: async () => { nativeCalls++; throw new Error("not admitted"); },
        preflight: async () => { if (boundary === "preflight") { setupEntered.resolve(); await setup.promise; } },
        run: async (argv, options) => {
          if (argv[2] === "system-scripts") { setupEntered.resolve(); await setup.promise; }
          if (argv[3] === "stop") {
            cleanupEntered.resolve(); await cleanup.promise;
            if (boundary.endsWith("stop failure")) throw cleanupError;
          }
          return f.options.run(argv, options);
        },
      });
      await Bun.write(devnet.paths.accountsPath, "existing accounts");
      const starting = devnet.start().catch(error => error).finally(() => { startupSettled = true; });
      await setupEntered.promise;
      let stopping: Promise<void> | undefined;
      try {
        await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("not ready");
        await expect(devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" })).rejects.toThrow("not ready");
        await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
        setup.reject(startupError);
        if (boundary !== "preflight") {
          await cleanupEntered.promise;
          expect(startupSettled).toBe(false);
          expect(await Bun.file(devnet.paths.accountsPath).exists()).toBe(true);
          await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
          await expect(devnet.prepareDebugger("1.1.1")).rejects.toThrow("interrupted");
          await expect(devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" })).rejects.toThrow("interrupted");
        }
        stopping = devnet.stop(); expect(devnet.stop()).toBe(stopping);
      } finally { setup.reject(startupError); cleanup.resolve(); await starting; await (stopping ?? devnet.stop()); }
      const error = await starting;
      if (boundary.endsWith("stop failure")) expect(error.errors).toEqual([startupError, cleanupError]);
      else expect(error).toBe(startupError);
      expect(nativeCalls).toBe(0);
      expect(await Bun.file(devnet.paths.accountsPath).exists()).toBe(boundary === "preflight");
      const next = await acquireRuntimeOwnership();
      try { await devnet.stop(); await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy"); }
      finally { await next.release(); }
    },
  );

  test.each(["throw", "exit", "timeout"])("cleans up a node launch that fails by %s", async (failure) => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-launch-failure-"));
    directories.push(repository);
    let stopCalls = 0;
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
      installCkbBinary: async () => fixtureCkbBinary(repository),
      run: async (argv) => {
        if (argv[1] === "--version") return { ...success("version"), stdout: "0.4.13\n" };
        if (argv[2] === "node" && argv[3] === "stop") { stopCalls++; return success("node.stop"); }
        if (argv[2] === "node") {
          if (failure === "throw") throw new Error("launch failure");
          return { ...success("node"), exitCode: 1, timedOut: failure === "timeout" };
        }
        return success(argv[2] ?? "unknown");
      },
    });
    await expect(devnet.start()).rejects.toThrow();
    expect(stopCalls).toBe(1);
    await devnet.stop();
    expect(stopCalls).toBe(1);
    const next = await acquireRuntimeOwnership();
    await next.release();
  });

  test("stop on a runner that never owned the runtime preserves another runner's accounts", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-losing-stop-"));
    directories.push(repository);
    const calls: string[][] = [];
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2,
      run: async (argv) => { calls.push([...argv]); return success("unexpected"); },
    });
    await Bun.write(devnet.paths.accountsPath, "owner's accounts");
    await devnet.stop();
    expect(await Bun.file(devnet.paths.accountsPath).text()).toBe("owner's accounts");
    expect(calls).toEqual([]);
  });

  test.each([
    "normal", "during debug", "during debug timeout", "during debug throw", "during debug abort",
    "local_node_info", "get_block_by_number",
  ])("owns the fresh context through %s stop", async (shutdown) => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-lifecycle-"));
    directories.push(repository);
    const paths = createOffckbPaths(repository, join(repository, "node_modules/.bin/offckb"));
    const calls: string[][] = [];
    let pendingCommand: Promise<void> | undefined;
    let commandEntered: (() => void) | undefined;
    const controller = new AbortController();
    let rpcStop: Promise<void> | undefined;

    const run: OffckbCommandRunner = async (argv, options) => {
      calls.push([...argv]);
      if (argv[0]?.endsWith("/offckb") && argv[1] === "--version") {
        return { ...success("version"), stdout: "0.4.13\n" };
      }
      if (argv[0]?.endsWith("/ckb-debugger") && argv[1] === "--version") {
        return {
          stdout: "ckb-debugger 1.1.1\n",
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 1,
        };
      }
      const command = argv[2];
      if (command === "node" && argv[3] === "stop") return success("node", { stopped: true });
      if (command === "node") {
        return success("node", {
          rpcUrl: "http://127.0.0.1:8114",
          proxyUrl: "http://127.0.0.1:28114",
          network: "devnet",
          daemon: true,
        });
      }
      if (command === "devnet") {
        return success("devnet.info", {
          ready: true,
          rpcUrl: "http://127.0.0.1:8114",
          proxyUrl: "http://127.0.0.1:28114",
        });
      }
      if (command === "accounts") {
        return success("accounts", {
          accounts: [0, 1].map((index) => ({
            index,
            address: `ckt1-account-${index}`,
            privkey: KEY,
            lockScript: { codeHash: HASH, hashType: "type", args: `0x${String(index).padStart(40, "0")}` },
          })),
        });
      }
      if (command === "system-scripts") {
        const output = argv[4];
        if (output === undefined) throw new Error("missing output path");
        await Bun.write(
          output,
          JSON.stringify({
            devnet: {
              secp256k1_blake160_sighash_all: {
                script: { codeHash: HASH, hashType: "type", cellDeps: [] },
              },
            },
          }),
        );
        return success("system-scripts", { completed: true });
      }
      if (command === "debug") {
        expect(options.timeoutMs).toBe(60_000);
        commandEntered?.();
        await pendingCommand;
        if (shutdown === "during debug throw" && pendingCommand !== undefined) throw new Error("debug failed");
        return {
          ...success("debug"),
          stdout: "Run result: -11\nAll cycles: 393345(384.1K)\n",
          stderr: "Command failed",
          exitCode: 1,
          timedOut: shutdown === "during debug timeout" && pendingCommand !== undefined,
        };
      }
      if (command === "install") { commandEntered?.(); await pendingCommand; }
      return success(command ?? "unknown", { completed: true });
    };

    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === shutdown) rpcStop = devnet.stop();
      if (method === "local_node_info") return { version: "0.209.0 (test)" };
      if (method === "get_block_by_number") return { header: { hash: HASH } };
      throw new Error(`unexpected RPC ${method}`);
    };

    const ckbBinary = fixtureCkbBinary(repository);
    const native = await inertDebugger(repository);
    const devnet = new OffckbDevnet({
      repositoryRoot: repository,
      ckbVersion: "0.209.0",
      accountCount: 2,
      run,
      rpc,
      installCkbBinary: async () => ckbBinary,
      prepareDebuggerBinary: native.prepare,
    });
    if (["local_node_info", "get_block_by_number"].includes(shutdown)) {
      try {
        await expect(devnet.start()).rejects.toThrow("interrupted");
      } finally {
        await rpcStop;
        await devnet.stop();
      }
      expect(await Bun.file(paths.accountsPath).exists()).toBe(false);
      expect(await Bun.file(paths.contextPath).exists()).toBe(false);
      return;
    }
    const context = await devnet.start(controller.signal);
    const { path: _ckbBinaryPath, ...ckbBinaryEvidence } = ckbBinary;

    expect(context).toMatchObject({
      ckbVersion: "0.209.0 (test)",
      ckbBinary: ckbBinaryEvidence,
      offckbVersion: "0.4.13",
      genesisHash: HASH,
      rpcUrl: "http://127.0.0.1:8114",
      proxyUrl: "http://127.0.0.1:28114",
      accountsPath: paths.accountsPath,
      systemScriptsPath: paths.systemScriptsPath,
    });
    expect((await stat(paths.accountsPath)).mode & 0o777).toBe(0o600);
    expect(calls[0]?.slice(1)).toEqual(["--version"]);
    expect(calls.filter((argv) => argv[1] === "--json").map((argv) => argv.slice(2, 5))).toEqual([
      ["config", "set", "ckb-version"],
      ["clean"],
      ["node", "--binary-path", ckbBinary.path],
      ["devnet", "info"],
      ["accounts", "--show-private-keys"],
      ["system-scripts", "--output", paths.systemScriptsPath],
    ]);

    await Bun.write(join(paths.configHome, "offckb-nodejs/settings.json"), JSON.stringify({ bins: { defaultCKBVersion: "0.209.0" } }));
    expect((await devnet.prepareDebugger("1.1.1")).version).toBe("ckb-debugger 1.1.1");
    const debug = await devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" });
    expect(debug).toEqual({
      ...success("debug"),
      stdout: "Run result: -11\nAll cycles: 393345(384.1K)\n",
      stderr: "Command failed",
      exitCode: 1,
    });
    expect(calls.at(-1)?.slice(2)).toEqual([
      "debug",
      "--tx-hash",
      HASH,
      "--single-script",
      "input[0].lock",
    ]);

    let finishCommand: (() => void) | undefined;
    let commandInFlight: Promise<unknown> | undefined;
    if (shutdown.startsWith("during debug")) {
      pendingCommand = new Promise<void>((resolve) => { finishCommand = resolve; });
      const entered = new Promise<void>((resolve) => { commandEntered = resolve; });
      commandInFlight = devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" })
        .catch((error: unknown) => error);
      await entered;
    }
    let stopping: Promise<void[]> | undefined;
    try {
      if (shutdown === "during debug abort") {
        controller.abort();
        const debugCalls = calls.filter((argv) => argv[2] === "debug").length;
        await expect(devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" }))
          .rejects.toThrow("interrupted");
        expect(calls.filter((argv) => argv[2] === "debug")).toHaveLength(debugCalls);
      }
      stopping = Promise.all([devnet.stop(), devnet.stop()]);
      if (commandInFlight !== undefined) {
        await Bun.sleep(10);
        expect(calls.filter((argv) => argv[2] === "node" && argv[3] === "stop")).toHaveLength(0);
        const debugCalls = calls.filter((argv) => argv[2] === "debug").length;
        await expect(devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" }))
          .rejects.toThrow("interrupted");
        expect(calls.filter((argv) => argv[2] === "debug")).toHaveLength(debugCalls);
        expect(await Bun.file(paths.accountsPath).exists()).toBe(true);
        await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
      }
    } finally {
      finishCommand?.();
      await commandInFlight;
      await (stopping ?? devnet.stop());
    }
    if (commandInFlight !== undefined) {
      expect(String(await commandInFlight)).toContain(shutdown === "during debug throw" ? "debug failed" : "interrupted");
    }
    expect(calls.filter((argv) => argv[2] === "node" && argv[3] === "stop")).toHaveLength(1);
    expect(await Bun.file(paths.accountsPath).exists()).toBe(false);
    expect(calls.at(-1)?.slice(2)).toEqual(["node", "stop"]);
    const next = await acquireRuntimeOwnership();
    await devnet.stop();
    await next.release();
  });

  test("refuses an OffCKB binary whose observed version differs from the pinned adapter", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-version-"));
    directories.push(repository);
    const calls: string[][] = [];
    const run: OffckbCommandRunner = async (argv) => {
      calls.push([...argv]);
      return { ...success("version"), stdout: "0.4.12\n" };
    };
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run,
      installCkbBinary: async () => fixtureCkbBinary(repository),
    });

    await expect(devnet.start()).rejects.toThrow("does not match required 0.4.13");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(1)).toEqual(["--version"]);
  });

  test("stops a partially started node when context creation fails", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-failure-"));
    directories.push(repository);
    let stopped = false;
    const run: OffckbCommandRunner = async (argv) => {
      if (argv[0]?.endsWith("/offckb") && argv[1] === "--version") {
        return { ...success("version"), stdout: "0.4.13\n" };
      }
      if (argv[2] === "node" && argv[3] === "stop") {
        stopped = true;
        return success("node", { stopped: true });
      }
      if (argv[2] === "node") {
        return success("node", { rpcUrl: "http://127.0.0.1:8114", proxyUrl: "http://127.0.0.1:28114" });
      }
      if (argv[2] === "devnet") return success("devnet.info", { ready: false });
      return success(argv[2] ?? "unknown");
    };
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run,
      installCkbBinary: async () => fixtureCkbBinary(repository),
    });

    await expect(devnet.start()).rejects.toThrow("not ready");
    expect(stopped).toBe(true);
  });

  test("stops a daemon whose successful node command returns malformed output", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-node-output-"));
    directories.push(repository);
    let stopCalls = 0;
    const run: OffckbCommandRunner = async (argv) => {
      if (argv[0]?.endsWith("/offckb") && argv[1] === "--version") {
        return { ...success("version"), stdout: "0.4.13\n" };
      }
      if (argv[2] === "node" && argv[3] === "stop") {
        stopCalls += 1;
        return success("node", { stopped: true });
      }
      if (argv[2] === "node") {
        return { ...success("node"), stdout: '{"ok":true,"command":"accounts"}\n' };
      }
      return success(argv[2] ?? "unknown");
    };
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run,
      installCkbBinary: async () => fixtureCkbBinary(repository),
    });

    await expect(devnet.start()).rejects.toThrow("did not emit a successful node result");
    expect(stopCalls).toBe(1);
  });

  test("preserves a partial-start cleanup failure alongside the startup error", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-cleanup-failure-"));
    directories.push(repository);
    const run: OffckbCommandRunner = async (argv) => {
      if (argv[0]?.endsWith("/offckb") && argv[1] === "--version") {
        return { ...success("version"), stdout: "0.4.13\n" };
      }
      if (argv[2] === "node" && argv[3] === "stop") {
        return { ...success("node"), exitCode: 1, stderr: "stop failed" };
      }
      if (argv[2] === "node") {
        return success("node", { rpcUrl: "http://127.0.0.1:8114", proxyUrl: "http://127.0.0.1:28114" });
      }
      if (argv[2] === "devnet") return success("devnet.info", { ready: false });
      return success(argv[2] ?? "unknown");
    };
    const devnet = new OffckbDevnet({
      repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run,
      installCkbBinary: async () => fixtureCkbBinary(repository),
    });

    await expect(devnet.start()).rejects.toThrow("OffCKB startup failed: OffCKB devnet is not ready; cleanup failed");
  });
});
