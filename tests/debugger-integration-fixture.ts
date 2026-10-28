import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { c } from "tar";
import { sha256Bytes } from "../src/canonical";
import { debuggerBinaryTestOnly, resolvePinnedDebuggerAsset, type DebuggerBinaryEvidence } from "../src/debugger-binary";
import { createOffckbPaths, type OffckbCommandRunner } from "../src/offckb";
import type { CommandResult } from "../src/process";

// Synthetic report observation only. No native execution is claimed by unit tests.
export function debuggerEvidence(): DebuggerBinaryEvidence {
  const pin = resolvePinnedDebuggerAsset("1.1.1", "linux", "x64");
  return { requestedVersion: pin.version, version: pin.version, platform: pin.platform, architecture: pin.architecture,
    assetName: pin.assetName, sourceUrl: pin.sourceUrl,
    archive: { expected: { ...pin.archive }, observed: { ...pin.archive } },
    executable: { expected: { ...pin.executable }, observed: { ...pin.executable } } };
}
export function success(command: string, fields: Record<string, unknown> = {}): CommandResult {
  return { stdout: JSON.stringify({ ok: true, command, ...fields }), stderr: "", exitCode: 0,
    signal: null, timedOut: false, durationMs: 1 };
}
export async function inertDebugger(root: string) {
  const source = join(root, "fixture-source"); await mkdir(source);
  const binary = Buffer.from("inert native integration fixture; never executed\n");
  await writeFile(join(source, "ckb-debugger"), binary);
  await writeFile(join(source, "LICENSE"), "fixture license\n");
  const archivePath = join(root, "fixture.tar.gz");
  await c({ cwd: source, file: archivePath, gzip: true, portable: true }, ["ckb-debugger", "LICENSE"]);
  const archive = await readFile(archivePath);
  const identity = (bytes: Uint8Array) => ({ bytes: bytes.byteLength, sha256: sha256Bytes(bytes) as `sha256:${string}` });
  const native = debuggerBinaryTestOnly({ archive: identity(archive), executable: identity(binary) }, {
    transport: async () => new Response(archive),
  });
  return native;
}
export function lifecycleFixture(root: string) {
  const paths = createOffckbPaths(root, join(root, "node_modules/.bin/offckb"));
  const calls: Array<{ argv: readonly string[]; options: Parameters<OffckbCommandRunner>[1] }> = [];
  const run: OffckbCommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    if (argv[1] === "--version") return { ...success("version"), stdout: argv[0] === paths.offckbBinary ? "0.4.13\n" : "ckb-debugger 1.1.1\n" };
    const command = argv[2]!;
    if (command === "config") {
      const dir = join(paths.configHome, "offckb-nodejs"); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "settings.json"), JSON.stringify({ bins: { defaultCKBVersion: "0.209.0" }, tools: { ckbTui: { version: "v0.1.4" } } }));
    }
    if (command === "devnet") return success("devnet.info", { ready: true, rpcUrl: "http://127.0.0.1:8114", proxyUrl: "http://127.0.0.1:28114" });
    if (command === "accounts") return success("accounts", { accounts: [{ index: 0, address: "test", privkey: `0x${"11".repeat(32)}`, lockScript: { codeHash: `0x${"22".repeat(32)}`, hashType: "type", args: "0x" } }] });
    if (command === "system-scripts") await writeFile(paths.systemScriptsPath, JSON.stringify({ devnet: {} }));
    if (command === "debug") return { ...success("debug"), stdout: "Run result: -11\nAll cycles: 123\n", exitCode: 1 };
    return success(command);
  };
  return { calls, paths, options: { repositoryRoot: root, ckbVersion: "0.209.0", accountCount: 1, run,
    preflight: async () => {},
    rpc: async (_url: string, method: string) => method === "local_node_info" ? { version: "0.209.0" } : { header: { hash: `0x${"22".repeat(32)}` } },
    installCkbBinary: async () => ({ path: join(root, "never-executed-ckb"), version: "0.209.0", platform: "linux" as const,
      architecture: "x64", asset: "fixture", sourceUrl: "https://example.invalid/fixture",
      expectedArchiveSha256: `sha256:${"1".repeat(64)}` as const, archiveSha256: `sha256:${"1".repeat(64)}` as const, binarySha256: `sha256:${"2".repeat(64)}` as const }),
  } };
}
