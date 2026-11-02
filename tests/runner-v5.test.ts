import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManifest, type DevnetAdapter } from "../src/runner";
import type { OffckbRunContext } from "../src/offckb";
import { verifyReport } from "../src/report";
import { REPORT_SCHEMA_ID, schemaProblems } from "../src/schemas";
import { transactionHash } from "../src/transaction";
import { liveResponse } from "./fixtures/claims-v2/synthetic";
import { accounts3, bindings3, indexerCell, manifest5, mintTransaction } from "./fixtures/claims-v3/synthetic";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function devnet(project: string): DevnetAdapter {
  const root = join(project, ".runtime");
  const context: OffckbRunContext = {
    network: "devnet", offckbVersion: "0.4.13", ckbRequestedVersion: "0.209.0", ckbVersion: "0.209.0 (test)",
    ckbBinary: { version: "0.209.0", platform: "linux", architecture: "x64", asset: "fixture.tar.gz", sourceUrl: "https://github.com/nervosnetwork/ckb/releases/download/v0.209.0/fixture.tar.gz",
      expectedArchiveSha256: `sha256:${"1".repeat(64)}`, archiveSha256: `sha256:${"1".repeat(64)}`, binarySha256: `sha256:${"2".repeat(64)}` },
    genesisHash: `0x${"11".repeat(32)}`, rpcUrl: "http://127.0.0.1:8114", proxyUrl: "http://127.0.0.1:28114",
    accountsPath: join(root, "accounts.json"), systemScriptsPath: join(root, "system-scripts.json"), contextPath: join(root, "context.json"),
    systemScripts: structuredClone(bindings3), accounts: structuredClone(accounts3),
  };
  return {
    paths: { transactionsPath: join(root, "transactions"), fullTransactionsPath: join(root, "full-transactions") },
    async start() {
      await mkdir(root, { recursive: true });
      await writeFile(context.accountsPath, JSON.stringify({ accounts: [{ privkey: `0x${"77".repeat(32)}` }, { privkey: `0x${"77".repeat(32)}` }] }), { mode: 0o600 });
      await writeFile(context.systemScriptsPath, JSON.stringify({ devnet: {} }));
      return context;
    },
    async prepareDebugger() { throw new Error("not needed"); },
    async debugScript() { throw new Error("not needed"); },
    async stop() {},
  };
}

describe("draft.5 runner", () => {
  test("pages indexer queries, retains them raw, and publishes a verifiable report/3", async () => {
    const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-v5-"));
    directories.push(project);
    const manifestPath = join(project, "verify.toml");
    await writeFile(manifestPath, manifest5());
    const tx = mintTransaction();
    const calls: string[] = [];
    const plainCell = { output: { capacity: "0x2540be400", lock: { code_hash: accounts3[1]!.lock.codeHash, hash_type: "type", args: accounts3[1]!.lock.args }, type: null },
      output_data: null, out_point: { tx_hash: `0x${"61".repeat(32)}`, index: "0x0" }, block_number: "0x1", tx_index: "0x0" };
    const result = await runManifest({
      manifestPath, projectRoot: project, outputDir: join(project, "evidence"), devnet: devnet(project),
      runStep: async (_command, options) => {
        await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: tx }));
        return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, durationMs: 3 };
      },
      rpc: async (_url, method, params) => {
        calls.push(method);
        if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
        if (method === "send_transaction") return transactionHash(tx);
        if (method === "get_transaction") return { tx_status: { status: "committed" } };
        if (method === "get_live_cell") return liveResponse(tx);
        if (method === "get_cells") {
          const [key, order, limit, cursor] = params as [{ script: { args: string }; with_data: boolean; filter?: unknown }, string, string, string | null];
          expect(order).toBe("asc"); expect(limit).toBe("0x64"); expect(cursor).toBeNull();
          if (key.script.args === accounts3[1]!.lock.args) return { objects: [plainCell], last_cursor: "0x02" };
          return { objects: [indexerCell(tx, 0, key.with_data)], last_cursor: "0x01" };
        }
        throw new Error(`unexpected RPC ${method}`);
      },
    });
    expect(result.verdict).toBe("PASS");
    expect(result.report.schema).toBe("ckb-verify-report/3");
    expect(calls.filter((m) => m === "get_cells")).toHaveLength(3); // filtered cell, CKB balance, UDT balance (identical keys are snapshotted once)
    const stored = JSON.parse(await Bun.file(result.reportPath).text());
    expect(() => verifyReport(stored)).not.toThrow();
    expect(schemaProblems(REPORT_SCHEMA_ID, stored)).toEqual([]);
    expect(stored.environment.schema).toBe("ckb-verify-environment/4");
    expect(stored.environment.devnet.accounts).toHaveLength(2);
    expect(stored.outcomeClaims.steps[0].expectedCycles).toEqual({ gte: 1, lt: 1000 });
    expect(stored.outcomeClaims.assertions[3].observed.total).toBe("1000");
    expect(JSON.stringify(stored)).not.toContain("77".repeat(32));
  });

  test("refuses an indexer selection above the resource limit as an execution error, not a verdict", async () => {
    const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-v5-limit-"));
    directories.push(project);
    const manifestPath = join(project, "verify.toml");
    await writeFile(manifestPath, manifest5());
    const tx = mintTransaction();
    let page = 0;
    await expect(runManifest({
      manifestPath, projectRoot: project, outputDir: join(project, "evidence"), devnet: devnet(project),
      runStep: async (_command, options) => {
        await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: tx }));
        return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, durationMs: 3 };
      },
      rpc: async (_url, method) => {
        if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
        if (method === "send_transaction") return transactionHash(tx);
        if (method === "get_transaction") return { tx_status: { status: "committed" } };
        if (method === "get_live_cell") return liveResponse(tx);
        if (method === "get_cells") {
          page += 1;
          const objects = Array.from({ length: 100 }, (_, i) => ({ ...indexerCell(tx, 0, true), out_point: { tx_hash: `0x${(page * 1000 + i).toString(16).padStart(64, "0")}`, index: "0x0" } }));
          return { objects, last_cursor: `0x${page.toString(16)}` };
        }
        throw new Error(`unexpected RPC ${method}`);
      },
    })).rejects.toThrow("more than 1000 live Cells");
    expect(await Bun.file(join(project, "evidence", "report.json")).exists()).toBe(false);
  });
});

describe("draft.5 tool-version drift", () => {
  async function driftProject(): Promise<{ project: string; manifestPath: string }> {
    const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-v5-drift-"));
    directories.push(project);
    const manifestPath = join(project, "verify.toml");
    await writeFile(manifestPath, manifest5().replace('ckb = "0.209.0"', 'ckb = "0.208.0"'));
    return { project, manifestPath };
  }
  const rpc = (tx: ReturnType<typeof mintTransaction>) => async (_url: string, method: string, params?: unknown[]) => {
    if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
    if (method === "send_transaction") return transactionHash(tx);
    if (method === "get_transaction") return { tx_status: { status: "committed" } };
    if (method === "get_live_cell") return liveResponse(tx);
    if (method === "get_cells") {
      const key = (params as [{ script: { args: string }; with_data: boolean }])[0];
      if (key.script.args === accounts3[1]!.lock.args) return { objects: [{ output: { capacity: "0x2540be400", lock: { code_hash: accounts3[1]!.lock.codeHash, hash_type: "type", args: accounts3[1]!.lock.args }, type: null }, output_data: null, out_point: { tx_hash: `0x${"61".repeat(32)}`, index: "0x0" }, block_number: "0x1", tx_index: "0x0" }], last_cursor: "0x02" };
      return { objects: [indexerCell(tx, 0, key.with_data)], last_cursor: "0x01" };
    }
    throw new Error(`unexpected RPC ${method}`);
  };
  const runStep = (tx: ReturnType<typeof mintTransaction>) => async (_command: string, options: { env?: Record<string, string | undefined> }) => {
    await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: tx }));
    return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, durationMs: 3 };
  };

  test("a requested version without a pinned archive is refused by default", async () => {
    const { project, manifestPath } = await driftProject();
    await expect(runManifest({ manifestPath, projectRoot: project, outputDir: join(project, "evidence"), devnet: devnet(project), runStep: runStep(mintTransaction()), rpc: rpc(mintTransaction()) }))
      .rejects.toThrow("no pinned CKB release archive for 0.208.0");
  });

  test("--allow-version-drift runs on the pinned CKB, records provenance/3, and taints replay", async () => {
    const { project, manifestPath } = await driftProject();
    const tx = mintTransaction();
    const result = await runManifest({ manifestPath, projectRoot: project, outputDir: join(project, "evidence"), devnet: devnet(project), runStep: runStep(tx), rpc: rpc(tx), allowVersionDrift: true });
    expect(result.verdict).toBe("PASS");
    const stored = JSON.parse(await Bun.file(result.reportPath).text());
    expect(() => verifyReport(stored)).not.toThrow();
    expect(schemaProblems(REPORT_SCHEMA_ID, stored)).toEqual([]);
    expect(stored.environment.toolchain.requested.ckb).toBe("0.208.0");
    expect(stored.environment.provenance.schema).toBe("ckb-verify-provenance/3");
    expect(stored.environment.provenance.toolchain).toEqual({ ckb: { requested: "0.208.0", observed: "0.209.0", driftAllowed: true } });
    expect(stored.environment.provenance.replay.status).toBe("tainted");
    const codes = stored.environment.provenance.replay.reasons.map((r: { code: string }) => r.code);
    expect(codes).toContain("tool_version_drift");
    expect(stored.environment.provenance.replay.reasons.find((r: { code: string }) => r.code === "tool_version_drift").detail).toContain("requested ckb 0.208.0 but observed 0.209.0");
    // A report that records drift without having allowed it is inconsistent even after rehashing.
    stored.environment.provenance.toolchain.ckb.driftAllowed = false;
    const { canonicalSha256 } = await import("../src/canonical");
    stored.digests.environment = canonicalSha256(stored.environment);
    expect(() => verifyReport(stored)).toThrow("without being allowed");
  });

  test("the flag is refused for draft.4 manifests", async () => {
    const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-v5-drift4-"));
    directories.push(project);
    const manifestPath = join(project, "verify.toml");
    await writeFile(manifestPath, manifest5().replace("draft.5", "draft.4").replace(/expect\.cycles.*\n/, "").replace(/\[\[step\.assert\.cell\]\][\s\S]*$/, '[[step.assert.cell]]\nout_point = { step = "mint", index = 0 }\ncount = 1\n'));
    await expect(runManifest({ manifestPath, projectRoot: project, outputDir: join(project, "evidence"), devnet: devnet(project), runStep: runStep(mintTransaction()), rpc: rpc(mintTransaction()), allowVersionDrift: true }))
      .rejects.toThrow("requires a 0.1.0-draft.5 manifest");
  });
});
