import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { collectSourceRevision, runManifest, type DevnetAdapter, type StepCommandRunner } from "../src/runner";
import type { OffckbRunContext } from "../src/offckb";
import { runProcess, type CommandResult } from "../src/process";
import { transactionHash } from "../src/transaction";
import { RpcError } from "../src/rpc";
import { debuggerEvidence } from "./debugger-integration-fixture";
import { verifyReport } from "../src/report";
import { canonicalSha256 } from "../src/canonical";
import { bindings, syntheticTransaction, liveResponse, manifest4 } from "./fixtures/claims-v2/synthetic";
import type { CkbJsonRpcTransaction } from "../src/rpc";

const directories: string[] = [];
const HASH = `0x${"11".repeat(32)}`;
const KEY = `0x${"77".repeat(32)}`;
const LETTERED_KEY = `0x${"abcdef0123456789".repeat(4)}`;
const MIXED_CASE_KEY = `0x${"AbCdEf0123456789".repeat(4)}`;
const TRANSACTION = {
  version: "0x0",
  cell_deps: [],
  header_deps: [],
  inputs: [],
  outputs: [
    {
      capacity: "0x1",
      lock: { code_hash: `0x${"12".repeat(32)}`, hash_type: "type", args: "0x34" },
      type: null,
    },
  ],
  outputs_data: ["0x"],
  witnesses: [],
};
const REJECTED_TRANSACTION = {
  ...TRANSACTION,
  inputs: [
    {
      since: "0x0",
      previous_output: { tx_hash: `0x${"aa".repeat(32)}`, index: "0x0" },
    },
  ],
};

function commandResult(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, durationMs: 7 };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess(["git", ...args], { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function projectWithManifest(count: number): Promise<{ project: string; manifestPath: string; outputDir: string }> {
  const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-"));
  directories.push(project);
  const manifestPath = join(project, "verify.toml");
  const outputDir = join(project, "evidence");
  await writeFile(
    manifestPath,
    `[meta]\nname = "runner-committed"\nspec = "0.1.0-draft.3"\n\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\n\n[replay]\ndependencies = []\n\n[setup]\naccounts = 2\n\n[[step]]\nname = "transfer"\nrun = "fake-producer committed"\ntimeout = "10s"\nexpect.tx = "committed"\n\n[[step.assert.cell]]\nout_point = { step = "transfer", index = 0 }\ncount = ${count}\n`,
  );
  return { project, manifestPath, outputDir };
}

async function gitProjectWithManifest(): Promise<{ project: string; manifestPath: string; outputDir: string }> {
  const fixture = await projectWithManifest(1);
  const { project } = fixture;
  await writeFile(join(project, "package.json"), `${JSON.stringify({ packageManager: `bun@${Bun.version}` })}\n`);
  await writeFile(join(project, "bun.lock"), "initial lock\n");
  await writeFile(join(project, ".gitignore"), "evidence/\n.runtime/\n");
  await git(project, "init", "-q");
  await git(project, "config", "user.name", "Test");
  await git(project, "config", "user.email", "test@example.invalid");
  await git(project, "add", ".");
  await git(project, "commit", "-qm", "initial");
  return fixture;
}

async function projectWithRejectedManifest(): Promise<{ project: string; manifestPath: string; outputDir: string }> {
  const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-rejected-"));
  directories.push(project);
  const manifestPath = join(project, "verify.toml");
  const outputDir = join(project, "evidence");
  await writeFile(
    manifestPath,
    `[meta]\nname = "runner-rejected"\nspec = "0.1.0-draft.3"\n\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\nckb-debugger = "1.1.1"\n\n[replay]\ndependencies = []\n\n[setup]\naccounts = 2\n\n[[step]]\nname = "bad-signature"\nrun = "fake-producer rejected"\ntimeout = "10s"\nexpect.tx = "rejected"\nexpect.error.code = -11\n`,
  );
  return { project, manifestPath, outputDir };
}

async function projectWithTerminalRejectedManifest(): Promise<{
  project: string;
  manifestPath: string;
  outputDir: string;
}> {
  const project = await mkdtemp(join(tmpdir(), "ckb-verify-runner-terminal-rejected-"));
  directories.push(project);
  const manifestPath = join(project, "verify.toml");
  const outputDir = join(project, "evidence");
  await writeFile(
    manifestPath,
    `[meta]\nname = "runner-terminal-rejected"\nspec = "0.1.0-draft.3"\n\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\nckb-debugger = "1.1.1"\n\n[replay]\ndependencies = []\n\n[setup]\naccounts = 2\n\n[[step]]\nname = "delayed-rejection"\nrun = "fake-producer terminal-rejected"\ntimeout = "10s"\nexpect.tx = "rejected"\n`,
  );
  return { project, manifestPath, outputDir };
}

function fakeDevnet(project: string, debuggerOutput = "", privateKey = KEY): DevnetAdapter {
  const root = join(project, ".runtime");
  const accountsPath = join(root, "accounts.json");
  const context: OffckbRunContext = {
    network: "devnet",
    offckbVersion: "0.4.13",
    ckbRequestedVersion: "0.209.0",
    ckbVersion: "0.209.0 (test)",
    ckbBinary: {
      version: "0.209.0",
      platform: "linux",
      architecture: "x64",
      asset: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
      sourceUrl: "https://github.com/nervosnetwork/ckb/releases/download/v0.209.0/fixture.tar.gz",
      expectedArchiveSha256: `sha256:${"1".repeat(64)}`,
      archiveSha256: `sha256:${"1".repeat(64)}`,
      binarySha256: `sha256:${"2".repeat(64)}`,
    },
    genesisHash: HASH,
    rpcUrl: "http://127.0.0.1:8114",
    proxyUrl: "http://127.0.0.1:28114",
    accountsPath,
    systemScriptsPath: join(root, "system-scripts.json"),
    contextPath: join(root, "context.json"),
    systemScripts: {},
    accounts: [],
  };
  return {
    paths: {
      transactionsPath: join(root, "transactions"),
      fullTransactionsPath: join(root, "full-transactions"),
    },
    async start() {
      await mkdir(root, { recursive: true });
      await writeFile(accountsPath, JSON.stringify({ accounts: [{ privkey: privateKey }, { privkey: privateKey }] }), {
        mode: 0o600,
      });
      await writeFile(context.systemScriptsPath, JSON.stringify({ devnet: {} }));
      return context;
    },
    async prepareDebugger(version) {
      expect(version).toBe("1.1.1");
      return { version: "ckb-debugger 1.1.1", binary: debuggerEvidence() };
    },
    async debugScript() {
      return { ...commandResult(debuggerOutput, "Command failed"), exitCode: debuggerOutput === "" ? 0 : 1 };
    },
    async stop() {},
  };
}

async function syntheticRun(text: string, tx: CkbJsonRpcTransaction, response: () => unknown = () => liveResponse(tx),
  onStop?: (outputDir: string) => Promise<void>, signal?: AbortSignal) {
  const fixture = await projectWithManifest(1);
  await writeFile(fixture.manifestPath, text);
  const devnet = fakeDevnet(fixture.project);
  const start = devnet.start.bind(devnet);
  devnet.start = async () => ({ ...await start(), systemScripts: structuredClone(bindings) });
  let stopped = false;
  devnet.stop = async () => { stopped = true; await onStop?.(fixture.outputDir); };
  let queries = 0;
  const result = await runManifest({ manifestPath: fixture.manifestPath, projectRoot: fixture.project,
    outputDir: fixture.outputDir, devnet, ...(signal === undefined ? {} : { signal }),
    runStep: async (_command, options) => {
      await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: tx }));
      return commandResult();
    },
    rpc: async (_url, method, params, rpcSignal) => {
      if (signal !== undefined) expect(rpcSignal).toBeDefined();
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return transactionHash(tx);
      if (method === "get_transaction") return { tx_status: { status: "committed" } };
      if (method === "get_live_cell") {
        queries++;
        expect(params?.[0]).toMatchObject({ tx_hash: transactionHash(tx) });
        expect(params?.[1]).toBe(true);
        if (signal !== undefined) expect(rpcSignal).toBe(signal);
        return response();
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  }).catch(async error => {
    expect(stopped).toBe(true);
    for (const name of ["report.json", ".report.json.pending"]) expect(await Bun.file(join(fixture.outputDir, name)).exists()).toBe(false);
    throw error;
  });
  expect(stopped).toBe(true);
  const reportText = await Bun.file(result.reportPath).text();
  const stored = JSON.parse(reportText);
  verifyReport(stored);
  // Compare actual serialized bytes: JSON represents either numeric zero as 0.
  expect(reportText).toBe(`${JSON.stringify(result.report, null, 2)}\n`);
  return { ...result, queries };
}

// This fake-adapter seam tests publication, not an OffCKB/devnet lifecycle.
async function bindingPublication(edit: (scripts: any) => void, expected: "PASS" | "FAIL" | "NO_VERDICT", missingDep = false) {
  const fixture = await projectWithManifest(1);
  const text = manifest4('type = { builtin = "dao", args_bytes = 0 }') +
    '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }\n';
  await writeFile(fixture.manifestPath, text);
  const scripts = JSON.parse(JSON.stringify(bindings)); edit(scripts);
  const tx = syntheticTransaction();
  tx.cell_deps = bindings.dao!.cellDeps.slice(missingDep ? 1 : 0).map(d => ({
    out_point: { tx_hash: d.outPoint.txHash, index: `0x${d.outPoint.index.toString(16)}` },
    dep_type: d.depType === "depGroup" ? "dep_group" : "code",
  }));
  const devnet = fakeDevnet(fixture.project), start = devnet.start.bind(devnet);
  const accounts = join(fixture.project, ".runtime", "accounts.json");
  devnet.start = async () => ({ ...await start(), systemScripts: scripts });
  let stops = 0;
  devnet.stop = async () => { stops++; await rm(accounts, { force: true }); };
  let result: Awaited<ReturnType<typeof runManifest>> | undefined, failure: unknown;
  try {
    result = await runManifest({ ...fixture, projectRoot: fixture.project, devnet,
      runStep: async (_command, options) => {
        await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: tx }));
        return commandResult();
      },
      rpc: async (_url, method) => {
        if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
        if (method === "send_transaction") return transactionHash(tx);
        if (method === "get_transaction") return { tx_status: { status: "committed" } };
        if (method === "get_live_cell") return liveResponse(tx);
        throw new Error(`unexpected RPC ${method}`);
      },
    });
  } catch (error) { failure = error; }
  expect(stops).toBe(1);
  expect(await Bun.file(accounts).exists()).toBe(false);
  expect(await Bun.file(join(fixture.outputDir, ".report.json.pending")).exists()).toBe(false);
  const canonical = Bun.file(join(fixture.outputDir, "report.json"));
  if (expected === "NO_VERDICT") {
    // Do NOT treat a later disk-verifier failure as runManifest refusing publication.
    expect({ verdict: result?.verdict ?? "NO_VERDICT", published: await canonical.exists() }).toEqual({ verdict: "NO_VERDICT", published: false });
    expect(failure).toBeInstanceOf(Error);
  } else {
    expect(failure).toBeUndefined();
    expect(result!.verdict).toBe(expected);
    const stored = await canonical.json();
    expect(() => verifyReport(stored)).not.toThrow();
    expect(stored.verdict).toBe(expected);
    expect(stored.outcomeClaims.steps[0].claims[1].observed.present).toEqual(missingDep ? [false, true] : [true, true]);
  }
}

describe("draft.4 vertical tracer", () => {
  test.each(["malformed JSON", "rehashed contradiction"])(
    "FIX3 pending-file publication refuses actual %s bytes before canonical rename", async form => {
      const fixture = await projectWithManifest(1);
      await writeFile(fixture.manifestPath, manifest4());
      const tx = syntheticTransaction();
      const devnet = fakeDevnet(fixture.project), start = devnet.start.bind(devnet);
      const accounts = join(fixture.project, ".runtime", "accounts.json");
      const pending = join(fixture.outputDir, ".report.json.pending"), canonical = join(fixture.outputDir, "report.json");
      devnet.start = async () => ({ ...await start(), systemScripts: structuredClone(bindings) });
      let stops = 0, changedBytes = false;
      devnet.stop = async () => {
        stops++;
        await rm(accounts, { force: true });
        expect(await Bun.file(canonical).exists()).toBe(false);
        const stored = await Bun.file(pending).json();
        verifyReport(stored); // The report was valid before the actual file was changed.
        if (form === "malformed JSON") await writeFile(pending, "{invalid JSON\n");
        else {
          stored.evidence.steps[0].claims[0].observed.count = 0;
          stored.digests = { outcome: canonicalSha256(stored.outcomeClaims), environment: canonicalSha256(stored.environment) };
          await writeFile(pending, `${JSON.stringify(stored, null, 2)}\n`);
          // Failure must also invalidate a canonical path, not just the pending file.
          await writeFile(canonical, "stale verdict\n");
        }
        changedBytes = true;
      };
      let result: Awaited<ReturnType<typeof runManifest>> | undefined, failure: unknown;
      try {
        result = await runManifest({ ...fixture, projectRoot: fixture.project, devnet,
          runStep: async (_command, options) => {
            await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: tx }));
            return commandResult();
          },
          rpc: async (_url, method) => {
            if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
            if (method === "send_transaction") return transactionHash(tx);
            if (method === "get_transaction") return { tx_status: { status: "committed" } };
            if (method === "get_live_cell") return liveResponse(tx);
            throw new Error(`unexpected RPC ${method}`);
          },
        });
      } catch (error) { failure = error; }
      expect(changedBytes).toBe(true);
      // Assert refusal by runManifest itself, never a verifier failure after publication.
      expect({ verdict: result?.verdict ?? "NO_VERDICT", published: await Bun.file(canonical).exists() })
        .toEqual({ verdict: "NO_VERDICT", published: false });
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBeInstanceOf(Error);
      if (form === "rehashed contradiction") expect(String(failure)).toContain("stored derivation");
      expect(await Bun.file(pending).exists()).toBe(false);
      expect(await Bun.file(accounts).exists()).toBe(false);
      expect(stops).toBe(1);
    },
  );
  test("FIX3 signed-zero index publishes a report that verifies from actual file bytes", async () => {
    const text = manifest4().replace("index = 0", "index = -0");
    const { report, queries } = await syntheticRun(text, syntheticTransaction());
    verifyReport(report);
    expect(report.verdict).toBe("PASS");
    expect(queries).toBe(1);
    const claim = report.evidence.steps[0]!.claims[0]!;
    if (claim.kind !== "cell") throw new Error("expected cell claim");
    expect(Object.is((claim.target as { index: number }).index, -0)).toBe(true);
  });
  test.each(["0", "+0", "0.0", "-0", "-0.0", "-0e0"])(
    "FIX3 numeric spelling %s preserves PASS and valid FAIL file readback", async literal => {
      for (const target of ["index", "args", "count", "final-index"]) {
        let text = manifest4();
        if (target === "index" || target === "final-index") text = text.replace("index = 0", `index = ${literal}`);
        if (target === "final-index") text = text.replace("step.assert.cell", "assert.cell");
        if (target === "args") text = text.replace("args_bytes = 0", `args_bytes = ${literal}`);
        if (target === "count") text = manifest4("").replace("count = 1", `count = ${literal}`);
        const tx = syntheticTransaction();
        for (const live of [true, false]) {
          const result = await syntheticRun(text, tx, () => live ? liveResponse(tx) : { status: "dead", cell: null });
          expect(result.verdict).toBe((target === "count" ? !live : live) ? "PASS" : "FAIL");
          expect(result.queries).toBe(1);
          verifyReport(result.report);
        }
      }
    },
  );
  test("FIX3 shutdown primary error survives invalid pending bytes and removes both reports", async () => {
    const primary = new Error("FIX3 shutdown primary");
    let observed: unknown;
    try {
      await syntheticRun(manifest4(), syntheticTransaction(), undefined, async output => {
        await writeFile(join(output, ".report.json.pending"), "{invalid JSON\n");
        await writeFile(join(output, "report.json"), "stale verdict\n");
        throw primary;
      });
    } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([primary]);
  });
  test.each(["non-null toJSON", "forEach method", "forEach getter"])(
    "FIX2 canonical dispatch refuses publication for inherited %s", async form => {
      let reads = 0, calls = 0;
      await bindingPublication(s => {
        if (form === "non-null toJSON") Object.setPrototypeOf(s.dao, { toJSON: 42 });
        else {
          const forEach = () => { calls++; };
          Object.setPrototypeOf(s.dao.cellDeps, Object.create(Array.prototype, {
            forEach: form.endsWith("getter") ? { get() { reads++; return forEach; } } : { value: forEach },
          }));
        }
      }, "NO_VERDICT");
      expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
    });
  test.each(["method", "getter"])("FIX2 methods refuse null binding slot hidden by inherited map %s", async form => {
    let reads = 0, calls = 0;
    await bindingPublication(s => {
      const valid = JSON.parse(JSON.stringify(s.dao.cellDeps));
      s.dao.cellDeps = [null];
      const map = () => { calls++; return valid; };
      Object.setPrototypeOf(s.dao.cellDeps, Object.create(Array.prototype, {
        map: form === "getter" ? { get() { reads++; return map; } } : { value: map },
      }));
    }, "NO_VERDICT");
    expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
  });
  test("FIX2 methods preserve valid binding slots without invoking inherited map", async () => {
    let calls = 0;
    const edit = (s: any) => Object.setPrototypeOf(s.dao.cellDeps, Object.create(Array.prototype, {
      map: { value() { calls++; return []; } },
      [Symbol.iterator]: { value() { calls++; throw new Error("untrusted iterator executed"); } },
    }));
    await bindingPublication(edit, "PASS");
    await bindingPublication(edit, "FAIL", true);
    expect(calls).toBe(0);
  });
  test.each(["binding hook", "array hook", "binding getter", "array getter"])(
    "FIX2 hooks refuse publication for inherited toJSON %s and clean", async form => {
      let calls = 0, reads = 0;
      await bindingPublication(s => {
        const value = form.startsWith("array") ? s.dao.cellDeps : s.dao;
        const hook = () => { calls++; return Array.isArray(value) ? [] : {}; };
        Object.setPrototypeOf(value, Object.create(Object.getPrototypeOf(value), {
          toJSON: form.endsWith("getter") ? { get() { reads++; return hook; } } : { value: hook },
        }));
      }, "NO_VERDICT");
      expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
    });
  test.each(["all-hole", "leading", "middle", "trailing", "inherited", "explicit-null", "missing-alias", "inherited-alias"])(
    "SPEC02 publication refuses invalid binding %s and cleans", async form => {
      await bindingPublication(s => {
        const [a, z] = s.dao.cellDeps;
        if (form === "all-hole") s.dao.cellDeps = Array(1);
        if (form === "leading") s.dao.cellDeps = [, a, z];
        if (form === "middle") s.dao.cellDeps = [a, , z];
        if (form === "trailing") s.dao.cellDeps = [a, z, ,];
        if (form === "explicit-null") s.dao.cellDeps = [null];
        if (form === "inherited") {
          delete s.dao.cellDeps[0];
          Object.setPrototypeOf(s.dao.cellDeps, Object.create(Array.prototype, { 0: { value: a } }));
        }
        if (form === "missing-alias" || form === "inherited-alias") {
          const dao = s.dao; delete s.dao;
          if (form === "inherited-alias") Object.setPrototypeOf(s, { dao });
        }
      }, "NO_VERDICT");
    });
  test("SPEC02 non-enumerable own binding slots still publish verifiable PASS and FAIL", async () => {
    const edit = (s: any) => Object.defineProperty(s.dao.cellDeps, "0", { enumerable: false });
    await bindingPublication(edit, "PASS");
    await bindingPublication(edit, "FAIL", true);
  });
  test.each([
    ["alias", (s: any) => Object.defineProperty(s, "dao", { enumerable: false })],
    ["binding codeHash", (s: any) => Object.defineProperty(s.dao, "codeHash", { enumerable: false })],
    ["dependency index", (s: any) => Object.defineProperty(s.dao.cellDeps[0].outPoint, "index", { enumerable: false })],
    ["hidden extra undefined", (s: any) => Object.defineProperty(s.dao, "extra", { value: undefined })],
  ] as const)("SPEC01 publication refuses non-retained %s", async (_name, edit) => {
    await bindingPublication(edit, "NO_VERDICT");
  });
  test("SPEC01 publication controls retain dense PASS and valid FAIL", async () => {
    await bindingPublication(() => {}, "PASS");
    await bindingPublication(() => {}, "FAIL", true);
  });
  test("V05 invalid UTF-8 manifest fails before setup", async () => {
    const f = await projectWithManifest(1);
    await writeFile(f.manifestPath, Buffer.concat([Buffer.from(manifest4() + '# '), Buffer.from([0xff]), Buffer.from('\n')]));
    const devnet = fakeDevnet(f.project); let started = false;
    devnet.start = async () => { started = true; throw new Error("unexpected setup"); };
    await expect(runManifest({ manifestPath: f.manifestPath, projectRoot: f.project, outputDir: f.outputDir, devnet })).rejects.toThrow("UTF-8");
    expect(started).toBe(false);
  });
  test("Q01 retained raw manifest key invalidates pending report, never redact-and-publish", async () => {
    let pendingSeen = false;
    await expect(syntheticRun(manifest4() + `# synthetic known dev key ${KEY}\n`, syntheticTransaction(), undefined,
      async output => { pendingSeen = await Bun.file(join(output, '.report.json.pending')).exists(); })).rejects.toThrow(".report.json.pending");
    expect(pendingSeen).toBe(true);
  });
  test("Q01 retained witness key still cleans and invalidates publication", async () => {
    const tx = syntheticTransaction(); tx.witnesses = [KEY];
    await expect(syntheticRun(manifest4(), tx)).rejects.toThrow(".report.json.pending");
  });
  test("M02 siblings share one phase snapshot, later step and final reset it", async () => {
    const text = manifest4() + '\n[[step.assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 1\n' +
      '\n[[step]]\nname = "later"\nrun = "inert-fake-adapter"\n[[step.assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 0\n' +
      '\n[[assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 0\n';
    const tx = syntheticTransaction(); let calls = 0;
    const { report, queries } = await syntheticRun(text, tx, () => ++calls === 1 ? liveResponse(tx) : { status: "dead", cell: null });
    expect(report.verdict).toBe("PASS"); expect(queries).toBe(3);
    expect(report.outcomeClaims.steps[0]!.claims).toHaveLength(2);
    expect(report.outcomeClaims.steps[1]!.claims[0]!.observed).toEqual({ state: "non-live", status: "dead", count: 0 });
  });
  test("M01 all conjunction evidence survives a mismatch, repeated dependencies remain separate", async () => {
    const text = manifest4('type = { builtin = "spore", args_bytes = 0 }\ndata = { min_bytes = 1 }') +
      '\n[[step.assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 0\n' +
      '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }\n' +
      '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "spore" }\n';
    const { report, queries } = await syntheticRun(text, syntheticTransaction());
    expect(report.verdict).toBe("FAIL"); expect(queries).toBe(1);
    expect(report.outcomeClaims.steps[0]!.claims.map(c => c.ok)).toEqual([false, false, false, false]);
  });
  test("M01 malformed later evidence aborts even after an earlier mismatch", async () => {
    const text = manifest4('type = { builtin = "spore", args_bytes = 0 }') + '\n[[assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 0\n';
    const tx = syntheticTransaction(); let calls = 0;
    await expect(syntheticRun(text, tx, () => ++calls === 1 ? liveResponse(tx) : { status: "nonsense", cell: null })).rejects.toThrow("status");
    expect(calls).toBe(2);
  });
  test("S06 absent output fails count zero without querying", async () => {
    const { report, queries } = await syntheticRun(manifest4('').replace('index = 0', 'index = 7').replace('count = 1', 'count = 0'), syntheticTransaction());
    expect(queries).toBe(0); expect(report.verdict).toBe("FAIL");
    expect(report.outcomeClaims.steps[0]!.claims[0]).toMatchObject({ observed: { state: "missing-output", count: 0 }, observationValid: false, ok: false });
  });
  test("M02 raw get_live_cell receives the run cancellation signal", async () => {
    const controller = new AbortController();
    const { queries } = await syntheticRun(manifest4(), syntheticTransaction(), undefined, undefined, controller.signal);
    expect(queries).toBe(1);
  });
  test("L02 current draft.3 full report preserves count greater than one", async () => {
    const { report } = await syntheticRun(manifest4('').replace('draft.4', 'draft.3').replace('count = 1', 'count = 2'), syntheticTransaction());
    expect(report.schema).toBe("ckb-verify-report/1"); expect(report.verdict).toBe("FAIL");
  });
  test.each([[2, "PASS", [true, true]], [1, "FAIL", [true, false]], [0, "FAIL", [false, false]]] as const)(
    "S08 dependency tracer: %s members", async (members, verdict, vector) => {
      const tx = syntheticTransaction();
      tx.cell_deps = bindings.dao!.cellDeps.slice(0, members).map(d => ({ out_point: { tx_hash: d.outPoint.txHash, index: `0x${d.outPoint.index.toString(16)}` }, dep_type: d.depType === "depGroup" ? "dep_group" : "code" }));
      const text = manifest4('type = { builtin = "dao", args_bytes = 0 }') + '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }\n';
      const { report } = await syntheticRun(text, tx);
      expect(report.verdict).toBe(verdict);
      expect(report.outcomeClaims.steps[0]!.claims[1]).toEqual({ kind: "cell_deps", target: { step: "produce" },
        expected: { contains: { kind: "builtin", name: "dao" } }, observed: { present: [...vector] }, observationValid: true, ok: verdict === "PASS" });
    });
  test.each([["0x", 1, "FAIL"], ["0xab", 1, "PASS"], ["0xabcd", 2, "PASS"], ["0xabcd", 3, "FAIL"]] as const)(
    "S02 data tracer: %s >= %s", async (data, min, verdict) => {
      const tx = syntheticTransaction(); tx.outputs_data = [data];
      const { report } = await syntheticRun(manifest4(`data = { min_bytes = ${min} }`), tx);
      expect(report.verdict).toBe(verdict);
      expect(report.outcomeClaims.steps[0]!.claims[0]).toMatchObject({ observed: { state: "live", count: 1, dataBytes: (data.length - 2) / 2 } });
      expect(report.outcomeClaims.steps[0]!.claims[0]!.observed).not.toHaveProperty("type");
    });
  test.each([
    ["matching type", true, "dao", "PASS"],
    ["wrong type", true, "spore", "FAIL"],
    ["ordinary Cell", false, "dao", "FAIL"],
  ] as const)("S01 typed-output tracer: %s", async (_name, typed, alias, verdict) => {
    const tx = syntheticTransaction(typed);
    const text = manifest4(`type = { builtin = "${alias}", args_bytes = 0 }`);
    const { report, queries } = await syntheticRun(text, tx);
    expect(report.schema).toBe("ckb-verify-report/2");
    expect(report.verdict).toBe(verdict);
    expect(report.evidence).toMatchObject({ manifestText: text, steps: [{ transaction: tx }] });
    expect(report.outcomeClaims.schema).toBe("ckb-verify-outcome/2");
    expect(report.outcomeClaims.steps[0]!.claims[0]).toMatchObject({
      observed: { state: "live", count: 1, type: typed ? { argsBytes: 0, identity: alias === "dao"
        ? { kind: "builtin", name: "dao" } : { kind: "raw", codeHash: bindings.dao!.codeHash, hashType: "type" } } : null },
      observationValid: true, ok: verdict === "PASS",
    });
    expect(queries).toBe(1);
  });
});

describe("runManifest", () => {
  test.each(["1.1.2", "latest", "01.1.1"])("unsupported requested debugger %s fails before start", async pin => {
    const { project, manifestPath, outputDir } = await projectWithRejectedManifest();
    await writeFile(manifestPath, (await Bun.file(manifestPath).text()).replace('ckb-debugger = "1.1.1"', `ckb-debugger = "${pin}"`));
    const devnet = fakeDevnet(project); let starts = 0;
    devnet.start = async () => { starts++; throw new Error("must not start"); };
    await expect(runManifest({ manifestPath, projectRoot: project, outputDir, devnet })).rejects.toThrow("toolchain.ckb-debugger");
    expect(starts).toBe(0);
  });
  test("unexpected unpinned script rejection refuses before lazy preparation or debugging", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const devnet = fakeDevnet(project); let prepares = 0; let debugs = 0; let stopped = false;
    devnet.prepareDebugger = async () => { prepares++; throw new Error("unexpected prepare"); };
    devnet.debugScript = async () => { debugs++; throw new Error("unexpected debug"); };
    devnet.stop = async () => { stopped = true; };
    await expect(runManifest({ manifestPath, projectRoot: project, outputDir, devnet,
      runStep: async (_command, options) => {
        await writeFile(options.env!.CKB_VERIFY_RESULT!, JSON.stringify({ protocol: 1, transaction: REJECTED_TRANSACTION }));
        return commandResult();
      },
      rpc: async (_url, method) => {
        if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
        if (method === "send_transaction") throw new RpcError(method, -302,
          "TransactionFailedToVerify: Verification failed Script(TransactionScriptError { source: Inputs[0].Lock, cause: ValidationFailure: see error code -11 on page https://example.invalid/#-11 })", null);
        throw new Error("unexpected script lookup before pin check");
      },
    })).rejects.toThrow("script rejection requires a prepared pinned debugger");
    expect(prepares).toBe(0); expect(debugs).toBe(0); expect(stopped).toBe(true);
    expect(await Bun.file(join(outputDir, "report.json")).exists()).toBe(false);
  });
  test("selects the execution-platform debugger pin before starting the devnet", async () => {
    const { project, manifestPath, outputDir } = await projectWithRejectedManifest();
    const devnet = fakeDevnet(project); let starts = 0;
    devnet.start = async () => { starts++; throw new Error("unexpected startup"); };
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { ...arch, value: "arm64" });
    try {
      await expect(runManifest({ manifestPath, projectRoot: project, outputDir, devnet })).rejects.toThrow("no pinned debugger artifact");
      expect(starts).toBe(0);
    } finally { Object.defineProperty(process, "arch", arch); }
  });
  test("preparation failure loads keys first, redacts artifacts and errors, cleans and invalidates reports", async () => {
    const { project, manifestPath, outputDir } = await projectWithRejectedManifest();
    const devnet = fakeDevnet(project, "", LETTERED_KEY);
    let stopped = false;
    devnet.prepareDebugger = async version => {
      expect(version).toBe("1.1.1");
      await writeFile(join(outputDir, "native.txt"), MIXED_CASE_KEY);
      await writeFile(join(outputDir, "report.json"), "stale");
      await writeFile(join(outputDir, ".report.json.pending"), "stale");
      throw new Error(`prepare failed ${MIXED_CASE_KEY}`);
    };
    devnet.stop = async () => { stopped = true; };
    const error = await runManifest({ manifestPath, projectRoot: project, outputDir, devnet }).catch(error => error);
    expect(String(error)).toContain("prepare failed");
    expect(String(error)).not.toContain(MIXED_CASE_KEY);
    expect(await Bun.file(join(outputDir, "native.txt")).text()).toBe("[REDACTED]");
    expect(stopped).toBe(true);
    for (const path of ["report.json", ".report.json.pending"]) expect(await Bun.file(join(outputDir, path)).exists()).toBe(false);
  });
  test("forwards interruption to setup before any devnet context exists", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const controller = new AbortController();
    const devnet = fakeDevnet(project);
    let observed: AbortSignal | undefined;
    devnet.start = async (signal?: AbortSignal) => { observed = signal; throw new Error("setup failed"); };
    await expect(runManifest({ manifestPath, projectRoot: project, outputDir, devnet, signal: controller.signal })).rejects.toThrow("setup failed");
    expect(observed).toBe(controller.signal);
    expect(await Bun.file(join(outputDir, "report.json")).exists()).toBe(false);
  });

  test("submits a producer result, waits for commit, evaluates a live Cell, and writes a self-verifying report", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const runStep: StepCommandRunner = async (_command, options) => {
      expect(options.env).toMatchObject({
        CKB_VERIFY_RPC_URL: "http://127.0.0.1:8114",
        CKB_VERIFY_ACCOUNTS: join(project, ".runtime", "accounts.json"),
        CKB_VERIFY_SYSTEM_SCRIPTS: join(project, ".runtime", "system-scripts.json"),
        CKB_VERIFY_CONTEXT: join(project, ".runtime", "context.json"),
      });
      expect(options.env?.SPARK_VERIFY_RESULT).toBeUndefined();
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult("producer complete\n", `raw=${KEY.slice(2)} upper=${KEY.toUpperCase()}\n`);
    };
    const txHash = transactionHash(TRANSACTION);
    const controller = new AbortController();
    const rpcCalls: Array<{ method: string; signal: AbortSignal | undefined }> = [];
    const rpc = async (_url: string, method: string, _params?: unknown[], signal?: AbortSignal): Promise<unknown> => {
      rpcCalls.push({ method, signal });
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") return { status: "live", cell: { output: { capacity: "0x1" }, data: { content: "0x" } } };
      throw new Error(`unexpected RPC ${method}`);
    };

    const devnet = fakeDevnet(project);
    devnet.prepareDebugger = async () => { throw new Error("no-debug run must not prepare a debugger"); };
    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet,
      runStep,
      rpc,
      signal: controller.signal,
    });

    expect(result.verdict).toBe("PASS");
    expect(result.report.environment.provenance.binaries.ckbDebugger).toBeNull();
    expect(result.report.evidence.steps[0]).toMatchObject({
      name: "transfer",
      expectedStatus: "committed",
      observedStatus: "committed",
      transactionHash: txHash,
      cycles: 100,
      claims: [{ expected: { count: 1 }, observed: { count: 1 }, ok: true }],
    });
    expect(await Bun.file(result.reportPath).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, ".report.json.pending")).exists()).toBe(false);
    expect(result.report.digests.outcome).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.report.digests.environment).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(result.report.environment).sort()).toEqual([
      "devnet",
      "platform",
      "provenance",
      "runner",
      "schema",
      "toolchain",
    ]);
    expect(result.report.environment).toMatchObject({
      schema: "ckb-verify-environment/3",
      runner: { name: "ckb-verify", version: "0.0.2" },
      toolchain: {
        requested: { ckb: "0.209.0", offckb: "0.4.13" },
        observed: { ckb: "0.209.0 (test)", offckb: "0.4.13" },
      },
      provenance: {
        schema: "ckb-verify-provenance/2",
        replay: {
          declaredDependencies: [],
          status: "tainted",
          reasons: [
            { scope: "environment", code: "source_revision_unavailable" },
            { scope: "environment", code: "source_state_unavailable" },
            { scope: "environment", code: "runtime_pin_missing" },
            { scope: "environment", code: "lockfile_missing" },
          ],
        },
        source: { gitCommit: null, dirty: null, dirtyDigest: null },
        manifest: { sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
        lockfile: { path: "bun.lock", sha256: null },
        runtime: {
          name: "bun",
          requestedVersion: null,
          observedVersion: Bun.version,
          metadata: { path: "package.json", sha256: null },
        },
        binaries: {
          ckb: {
            version: "0.209.0",
            platform: "linux",
            architecture: "x64",
            asset: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
            expectedArchiveSha256: `sha256:${"1".repeat(64)}`,
            archiveSha256: `sha256:${"1".repeat(64)}`,
            binarySha256: `sha256:${"2".repeat(64)}`,
          },
        },
      },
      platform: { os: process.platform, arch: process.arch },
      devnet: { network: "devnet", genesisHash: HASH, systemScripts: {} },
    });
    expect(await Bun.file(join(outputDir, "steps", "01-transfer", "transaction.json")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "steps", "01-transfer", "stdout.txt")).text()).toBe("producer complete\n");
    const sanitizedStderr = await Bun.file(join(outputDir, "steps", "01-transfer", "stderr.txt")).text();
    expect(sanitizedStderr).not.toContain(KEY.slice(2));
    expect(sanitizedStderr).not.toContain(KEY.toUpperCase());
    expect(sanitizedStderr).toContain("[REDACTED]");
    expect(rpcCalls.length).toBeGreaterThan(0);
    expect(rpcCalls.every(({ signal }) => signal !== undefined)).toBe(true);
  });

  test("returns FAIL when a committed transaction contradicts a declared Cell count", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(0);
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") return { status: "live", cell: { output: {}, data: { content: "0x" } } };
      throw new Error(`unexpected RPC ${method}`);
    };

    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet: fakeDevnet(project),
      runStep,
      rpc,
    });

    expect(result.verdict).toBe("FAIL");
    expect(result.report.evidence.steps[0]?.claims[0]).toMatchObject({
      expected: { count: 0 },
      observed: { count: 1 },
      ok: false,
    });
    expect(await Bun.file(result.reportPath).exists()).toBe(true);
  });

  test.each(["failure", "interruption"])("does not publish a verdict after shutdown %s", async (failure) => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const devnet = fakeDevnet(project);
    let reportVisibleDuringStop: boolean | undefined;
    const controller = new AbortController();
    devnet.stop = async () => {
      reportVisibleDuringStop = await Bun.file(join(outputDir, "report.json")).exists();
      if (failure === "interruption") { controller.abort("SIGTERM"); return; }
      throw new Error("simulated shutdown failure");
    };
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") return { status: "live", cell: { output: {}, data: { content: "0x" } } };
      throw new Error(`unexpected RPC ${method}`);
    };

    await expect(runManifest({ manifestPath, projectRoot: project, outputDir, devnet, runStep, rpc, signal: controller.signal })).rejects.toThrow(
      failure === "interruption" ? "run interrupted" : "simulated shutdown failure",
    );
    expect(reportVisibleDuringStop).toBe(false);
    expect(await Bun.file(join(outputDir, "report.json")).exists()).toBe(false);
    expect(await Bun.file(join(outputDir, ".report.json.pending")).exists()).toBe(false);
  });

  test.each(["tracked file", "untracked file", "untracked symlink"] as const)(
    "does not publish a verdict when %s differs between source snapshots",
    async (source) => {
      const { project, manifestPath, outputDir } = await gitProjectWithManifest();
      const sourcePath = join(project, source === "tracked file" ? "bun.lock" : "fixture-input");
      if (source === "untracked file") await writeFile(sourcePath, "initial input\n");
      if (source === "untracked symlink") await symlink("verify.toml", sourcePath);
      const before = await collectSourceRevision(project);
      expect(before.dirty).toBe(source !== "tracked file");

      const runStep: StepCommandRunner = async (_command, options) => {
        const resultPath = options.env?.CKB_VERIFY_RESULT;
        if (resultPath === undefined) throw new Error("missing result path");
        await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
        if (source === "untracked symlink") {
          await rm(sourcePath);
          await symlink("package.json", sourcePath);
        } else await writeFile(sourcePath, "mutated during verification\n");
        return commandResult();
      };
      const txHash = transactionHash(TRANSACTION);
      const rpc = async (_url: string, method: string): Promise<unknown> => {
        if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
        if (method === "send_transaction") return txHash;
        if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
        if (method === "get_live_cell") return { status: "live", cell: { output: {}, data: { content: "0x" } } };
        throw new Error(`unexpected RPC ${method}`);
      };
      const devnet = fakeDevnet(project);
      let stopped = false;
      devnet.stop = async () => {
        stopped = true;
      };

      await expect(
        runManifest({ manifestPath, projectRoot: project, outputDir, devnet, runStep, rpc }),
      ).rejects.toThrow("source revision changed during verification");
      expect(stopped).toBe(true);
      expect(await Bun.file(join(outputDir, "report.json")).exists()).toBe(false);
      expect(await Bun.file(join(outputDir, ".report.json.pending")).exists()).toBe(false);
    },
  );

  test("does not detect source changes restored before the final snapshot", async () => {
    const { project, manifestPath, outputDir } = await gitProjectWithManifest();
    const sourcePath = join(project, "bun.lock");
    const original = await Bun.file(sourcePath).text();
    const before = await collectSourceRevision(project);
    expect(before).toMatchObject({ dirty: false, dirtyDigest: null });

    const runStep: StepCommandRunner = async (_command, options) => {
      await writeFile(sourcePath, "temporarily changed during verification\n");
      expect(await collectSourceRevision(project)).toMatchObject({
        gitCommit: before.gitCommit,
        dirty: true,
        dirtyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      await writeFile(sourcePath, original);
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") return { status: "live", cell: { output: {}, data: { content: "0x" } } };
      throw new Error(`unexpected RPC ${method}`);
    };

    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet: fakeDevnet(project),
      runStep,
      rpc,
    });

    expect(result.verdict).toBe("PASS");
    expect(result.report.environment.provenance.source).toEqual(before);
    expect(result.report.environment.provenance.replay).toEqual({ declaredDependencies: [], status: "stable", reasons: [] });
    expect(await Bun.file(result.reportPath).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, ".report.json.pending")).exists()).toBe(false);
  });

  test("fails a vacuous count-zero claim that references an output the transaction did not create", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(0);
    const manifest = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, manifest.replace("index = 0", "index = 1"));
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") throw new Error("missing output must not be queried");
      throw new Error(`unexpected RPC ${method}`);
    };

    const result = await runManifest({ manifestPath, projectRoot: project, outputDir, devnet: fakeDevnet(project), runStep, rpc });

    expect(result.verdict).toBe("FAIL");
    expect(result.report.evidence.steps[0]?.claims[0]).toMatchObject({
      target: { step: "transfer", index: 1 },
      expected: { count: 0 },
      observed: { count: 0 },
      ok: false,
      evidence: { reason: "output-index-out-of-range", transactionOutputCount: 1 },
    });
  });

  test("fails closed when get_live_cell says live without a valid Cell payload", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") return { status: "live" };
      throw new Error(`unexpected RPC ${method}`);
    };

    await expect(
      runManifest({ manifestPath, projectRoot: project, outputDir, devnet: fakeDevnet(project), runStep, rpc }),
    ).rejects.toThrow("get_live_cell live result must include cell.output");
  });

  test("fails closed when get_live_cell omits its status", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(0);
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") return {};
      throw new Error(`unexpected RPC ${method}`);
    };

    await expect(
      runManifest({ manifestPath, projectRoot: project, outputDir, devnet: fakeDevnet(project), runStep, rpc }),
    ).rejects.toThrow("get_live_cell status must be live, dead, or unknown");
  });

  test("aborts a running producer and stops the devnet before reporting interruption", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const controller = new AbortController();
    const baseDevnet = fakeDevnet(project);
    let stopped = false;
    const devnet: DevnetAdapter = {
      ...baseDevnet,
      async stop() {
        stopped = true;
        await rm(join(project, ".runtime", "accounts.json"), { force: true });
      },
    };
    const runStep: StepCommandRunner = async (_command, options) =>
      await new Promise<CommandResult>((resolve) => {
        const finish = () => resolve({ ...commandResult(), exitCode: null, signal: "SIGTERM" });
        if (options.signal?.aborted === true) finish();
        else if (options.signal !== undefined) {
          options.signal.addEventListener("abort", finish, { once: true });
          setTimeout(() => controller.abort(), 20);
        } else setTimeout(() => resolve(commandResult()), 200);
      });

    await expect(
      runManifest({
        manifestPath,
        projectRoot: project,
        outputDir,
        devnet,
        runStep,
        signal: controller.signal,
      }),
    ).rejects.toThrow("run interrupted");
    expect(stopped).toBe(true);
    expect(await Bun.file(join(project, ".runtime", "accounts.json")).exists()).toBe(false);
  });

  test("redacts leaked development keys even when a producer fails before report creation", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const manifest = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, manifest.replace("spec = \"0.1.0-draft.3\"", `spec = \"0.1.0-draft.3\"\ndescription = \"${KEY}\"`));

    await expect(
      runManifest({
        manifestPath,
        projectRoot: project,
        outputDir,
        devnet: fakeDevnet(project),
        runStep: async () => ({ ...commandResult(), exitCode: 7 }),
        rpc: async () => {
          throw new Error("RPC must not run after producer failure");
        },
      }),
    ).rejects.toThrow("step transfer exited 7");

    const copiedManifest = await Bun.file(join(outputDir, "manifest.toml")).text();
    expect(copiedManifest).not.toContain(KEY);
    expect(copiedManifest).toContain("[REDACTED]");
  });

  test("redacts and rejects an arbitrary mixed-case spelling of a development private key", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const manifest = await Bun.file(manifestPath).text();
    await writeFile(
      manifestPath,
      manifest.replace('spec = "0.1.0-draft.3"', `spec = "0.1.0-draft.3"\ndescription = "${MIXED_CASE_KEY}"`),
    );

    await expect(
      runManifest({
        manifestPath,
        projectRoot: project,
        outputDir,
        devnet: fakeDevnet(project, "", LETTERED_KEY),
        runStep: async () => ({ ...commandResult(), exitCode: 7 }),
        rpc: async () => {
          throw new Error("RPC must not run after producer failure");
        },
      }),
    ).rejects.toThrow("development private key");

    const copiedManifest = await Bun.file(join(outputDir, "manifest.toml")).text();
    expect(copiedManifest).not.toContain(MIXED_CASE_KEY);
    expect(copiedManifest).toContain("[REDACTED]");
  });

  test("rejects symbolic links inside an evidence bundle", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const linkedTarget = join(project, "outside-evidence.txt");
    await writeFile(linkedTarget, "external content\n");

    await expect(
      runManifest({
        manifestPath,
        projectRoot: project,
        outputDir,
        devnet: fakeDevnet(project),
        runStep: async (_command, options) => {
          const resultPath = options.env?.CKB_VERIFY_RESULT;
          if (resultPath === undefined) throw new Error("missing result path");
          await symlink(linkedTarget, join(dirname(resultPath), "linked-evidence.txt"));
          return { ...commandResult(), exitCode: 7 };
        },
        rpc: async () => {
          throw new Error("RPC should not be called");
        },
      }),
    ).rejects.toThrow("evidence contains an unsupported filesystem entry");
    expect(await Bun.file(join(outputDir, "steps", "01-transfer", "linked-evidence.txt")).exists()).toBe(false);
  });

  test("does not publish a report whose normalized evidence contains an OffCKB development private key", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(TRANSACTION);
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { transaction: TRANSACTION, tx_status: { status: "committed" } };
      if (method === "get_live_cell") {
        return { status: "live", cell: { output: { lock: { args: KEY } }, data: { content: "0x" } } };
      }
      throw new Error(`unexpected RPC ${method}`);
    };

    await expect(
      runManifest({ manifestPath, projectRoot: project, outputDir, devnet: fakeDevnet(project), runStep, rpc }),
    ).rejects.toThrow("development private key");
    expect(await Bun.file(join(outputDir, "manifest.toml")).text()).not.toContain(KEY);
    expect(await Bun.file(join(outputDir, "report.json")).exists()).toBe(false);
    expect(await Bun.file(join(outputDir, ".report.json.pending")).exists()).toBe(false);
  });

  test("preserves terminal delayed-rejection kind and reason without changing bare rejected semantics", async () => {
    const { project, manifestPath, outputDir } = await projectWithTerminalRejectedManifest();
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: REJECTED_TRANSACTION }));
      return commandResult();
    };
    const txHash = transactionHash(REJECTED_TRANSACTION);
    const reason = "PoolRejectedTransactionByOutputsValidator";
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x1", fee: "0x0" };
      if (method === "send_transaction") return txHash;
      if (method === "get_transaction") return { tx_status: { status: "rejected", reason } };
      throw new Error(`unexpected RPC ${method}`);
    };

    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet: fakeDevnet(project),
      runStep,
      rpc,
    });

    expect(result.verdict).toBe("PASS");
    expect(result.report.evidence.steps[0]).toMatchObject({
      expectedStatus: "rejected",
      observedStatus: "rejected",
      rejection: { kind: "node", reason },
    });
    expect(result.report.outcomeClaims.steps[0]).toMatchObject({
      expectedStatus: "rejected",
      observedStatus: "rejected",
      rejection: { kind: "node", reason },
    });
  });

  test("does not misclassify a send_transaction infrastructure error as an expected rejection", async () => {
    const { project, manifestPath, outputDir } = await projectWithRejectedManifest();
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: REJECTED_TRANSACTION }));
      return commandResult();
    };
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept") return { cycles: "0x64", fee: "0xa" };
      if (method === "send_transaction") throw new RpcError(method, -32601, "Method not found", null);
      throw new Error(`unexpected RPC ${method}`);
    };

    await expect(
      runManifest({ manifestPath, projectRoot: project, outputDir, devnet: fakeDevnet(project), runStep, rpc }),
    ).rejects.toThrow("send_transaction failed without a recognized script rejection");
  });

  test("submits and explains an expected script rejection with debugger cycles", async () => {
    const { project, manifestPath, outputDir } = await projectWithRejectedManifest();
    const runStep: StepCommandRunner = async (_command, options) => {
      const resultPath = options.env?.CKB_VERIFY_RESULT;
      if (resultPath === undefined) throw new Error("missing result path");
      await writeFile(resultPath, JSON.stringify({ protocol: 1, transaction: REJECTED_TRANSACTION }));
      return commandResult();
    };
    const rejectionMessage =
      "TransactionFailedToVerify: Verification failed Script(TransactionScriptError { source: Inputs[0].Lock, cause: ValidationFailure: see error code -11 on page https://example.invalid/#-11 })";
    let submitted = false;
    const rpc = async (_url: string, method: string): Promise<unknown> => {
      if (method === "test_tx_pool_accept" || method === "send_transaction") {
        if (method === "send_transaction") submitted = true;
        throw new RpcError(method, -302, rejectionMessage, { category: "script" });
      }
      if (method === "get_live_cell") {
        return {
          status: "live",
          cell: {
            output: {
              capacity: "0x174876e800",
              lock: { code_hash: `0x${"12".repeat(32)}`, hash_type: "type", args: "0x34" },
              type: null,
            },
            data: { content: "0x", hash: `0x${"00".repeat(32)}` },
          },
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    };

    let prepared = 0;
    const devnet = fakeDevnet(project, "Run result: -11\nAll cycles: 393345(384.1K)\n");
    const prepare = devnet.prepareDebugger;
    devnet.prepareDebugger = async version => { prepared++; return prepare(version); };
    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet,
      runStep,
      rpc,
    });

    expect(prepared).toBe(1);
    expect(submitted).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.report.environment).toMatchObject({
      schema: "ckb-verify-environment/3",
      provenance: { schema: "ckb-verify-provenance/2", binaries: { ckbDebugger: debuggerEvidence() } },
      toolchain: { observed: { ckbDebugger: "ckb-debugger 1.1.1" } },
    });
    expect(result.report.evidence.steps[0]).toMatchObject({
      name: "bad-signature",
      expectedStatus: "rejected",
      observedStatus: "rejected",
      expectedErrorCode: -11,
      cycles: 393345,
      rejection: {
        kind: "script",
        rpcCode: -302,
        code: -11,
        role: "lock",
        source: { cell: "input", index: 0 },
        script: { codeHash: `0x${"12".repeat(32)}`, hashType: "type", args: "0x34" },
        scriptHash: "0x1e9d962c4362619ef288c09221fd609f82cce8bfe2f278c769e5809802c5fca8",
      },
    });
    expect(await Bun.file(join(outputDir, "steps", "01-bad-signature", "rpc-error.json")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "steps", "01-bad-signature", "debugger.txt")).text()).toContain(
      "All cycles: 393345",
    );
  });
});
