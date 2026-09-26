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
  test("creates a fresh isolated devnet context and removes the account secret on stop", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-lifecycle-"));
    directories.push(repository);
    const paths = createOffckbPaths(repository, join(repository, "node_modules/.bin/offckb"));
    const calls: string[][] = [];

    const run: OffckbCommandRunner = async (argv) => {
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
        return {
          ...success("debug"),
          stdout: "Run result: -11\nAll cycles: 393345(384.1K)\n",
          stderr: "Command failed",
          exitCode: 1,
        };
      }
      return success(command ?? "unknown", { completed: true });
    };

    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "local_node_info") return { version: "0.209.0 (test)" };
      if (method === "get_block_by_number") return { header: { hash: HASH } };
      throw new Error(`unexpected RPC ${method}`);
    };

    const ckbBinary = fixtureCkbBinary(repository);
    const devnet = new OffckbDevnet({
      repositoryRoot: repository,
      ckbVersion: "0.209.0",
      accountCount: 2,
      run,
      rpc,
      installCkbBinary: async () => ckbBinary,
    });
    const context = await devnet.start();
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

    await devnet.installDebugger();
    expect(await devnet.debuggerVersion()).toBe("ckb-debugger 1.1.1");
    const debug = await devnet.debugScript(HASH, { cell: "input", index: 0, role: "lock" });
    expect(debug.exitCode).toBe(1);
    expect(`${debug.stdout}\n${debug.stderr}`).toContain("All cycles: 393345");
    expect(calls.at(-1)?.slice(2)).toEqual([
      "debug",
      "--tx-hash",
      HASH,
      "--single-script",
      "input[0].lock",
    ]);

    await devnet.stop();
    expect(await Bun.file(paths.accountsPath).exists()).toBe(false);
    expect(calls.at(-1)?.slice(2)).toEqual(["node", "stop"]);
  });

  test("refuses an OffCKB binary whose observed version differs from the pinned adapter", async () => {
    const repository = await mkdtemp(join(tmpdir(), "ckb-verify-offckb-version-"));
    directories.push(repository);
    const calls: string[][] = [];
    const run: OffckbCommandRunner = async (argv) => {
      calls.push([...argv]);
      return { ...success("version"), stdout: "0.4.12\n" };
    };
    const devnet = new OffckbDevnet({ repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run });

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
    const devnet = new OffckbDevnet({ repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run });

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
    const devnet = new OffckbDevnet({ repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run });

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
    const devnet = new OffckbDevnet({ repositoryRoot: repository, ckbVersion: "0.209.0", accountCount: 2, run });

    await expect(devnet.start()).rejects.toThrow("OffCKB startup failed: OffCKB devnet is not ready; cleanup failed");
  });
});
