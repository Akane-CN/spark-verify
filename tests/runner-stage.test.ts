// A no-verdict run names the stage it stopped in, so a failure points at the manifest, the toolchain, or a
// step's own command rather than leaving the author to guess (the "why did it fail" question).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OffckbRunContext } from "../src/offckb";
import { runFailureStage, runManifest, type DevnetAdapter } from "../src/runner";
import { accounts3, bindings3, manifest5, mintTransaction } from "./fixtures/claims-v3/synthetic";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function devnet(project: string, failStart = false): DevnetAdapter {
  const root = join(project, ".runtime");
  const context: OffckbRunContext = {
    network: "devnet", offckbVersion: "0.4.13", ckbRequestedVersion: "0.209.0", ckbVersion: "0.209.0 (test)",
    ckbBinary: { version: "0.209.0", platform: "linux", architecture: "x64", asset: "fixture.tar.gz", sourceUrl: "https://example.invalid/fixture.tar.gz",
      expectedArchiveSha256: `sha256:${"1".repeat(64)}`, archiveSha256: `sha256:${"1".repeat(64)}`, binarySha256: `sha256:${"2".repeat(64)}` },
    genesisHash: `0x${"11".repeat(32)}`, rpcUrl: "http://127.0.0.1:8114", proxyUrl: "http://127.0.0.1:28114",
    accountsPath: join(root, "accounts.json"), systemScriptsPath: join(root, "system-scripts.json"), contextPath: join(root, "context.json"),
    systemScripts: structuredClone(bindings3), accounts: structuredClone(accounts3),
  };
  return {
    paths: { transactionsPath: join(root, "transactions"), fullTransactionsPath: join(root, "full-transactions") },
    async start() {
      if (failStart) throw new Error("OffCKB devnet is not ready");
      await mkdir(root, { recursive: true });
      await writeFile(context.accountsPath, JSON.stringify({ accounts: [] }), { mode: 0o600 });
      return context;
    },
    async prepareDebugger() { throw new Error("not needed"); },
    async debugScript() { throw new Error("not needed"); },
    async stop() {},
  };
}

async function project(manifest: string): Promise<{ root: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "ckb-verify-stage-"));
  directories.push(root);
  const manifestPath = join(root, "verify.toml");
  await writeFile(manifestPath, manifest);
  return { root, manifestPath };
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  try { await run; } catch (error) { return error; }
  throw new Error("expected the run to fail");
}

describe("run failure stages", () => {
  test("a manifest error stops in the manifest stage", async () => {
    const { root, manifestPath } = await project("[meta]\nname = 1\n");
    const error = await failure(runManifest({ manifestPath, projectRoot: root, devnet: devnet(root) }));
    expect(runFailureStage(error)).toBe("manifest");
  });

  test("a devnet that does not start stops in the devnet stage", async () => {
    const { root, manifestPath } = await project(manifest5("", "0.1.0"));
    const error = await failure(runManifest({ manifestPath, projectRoot: root, outputDir: join(root, "out"), devnet: devnet(root, true) }));
    expect(runFailureStage(error)).toBe("devnet");
    expect((error as Error).message).toContain("not ready");
  });

  test("a failing producer is attributed to that step's command, and the stages are reported in order", async () => {
    const { root, manifestPath } = await project(manifest5("", "0.1.0"));
    const stages: string[] = [];
    const error = await failure(runManifest({
      manifestPath, projectRoot: root, outputDir: join(root, "out"), devnet: devnet(root), onStage: (stage) => stages.push(stage),
      runStep: async () => ({ stdout: "", stderr: "boom", exitCode: 1, signal: null, timedOut: false, durationMs: 1 }),
    }));
    expect(runFailureStage(error)).toBe('step "mint": command');
    expect(stages).toEqual(["preflight", "devnet", 'step "mint": command']);
  });

  test("a malformed result envelope is attributed to the step's result", async () => {
    const { root, manifestPath } = await project(manifest5("", "0.1.0"));
    const error = await failure(runManifest({
      manifestPath, projectRoot: root, outputDir: join(root, "out"), devnet: devnet(root),
      runStep: async (_command, options) => {
        await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: { ...mintTransaction(), version: "bad" } }).slice(0, 20));
        return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
      },
    }));
    expect(runFailureStage(error)).toBe('step "mint": result');
  });

  test("errors without a recorded stage stay unlabelled", () => {
    expect(runFailureStage(new Error("x"))).toBeUndefined();
    expect(runFailureStage("x")).toBeUndefined();
  });
});
