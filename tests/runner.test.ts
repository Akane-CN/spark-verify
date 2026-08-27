import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runManifest, type DevnetAdapter, type StepCommandRunner } from "../src/runner";
import type { OffckbRunContext } from "../src/offckb";
import type { CommandResult } from "../src/process";
import { transactionHash } from "../src/transaction";
import { RpcError } from "../src/rpc";

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

function fakeDevnet(project: string, debuggerOutput = "", privateKey = KEY): DevnetAdapter {
  const root = join(project, ".runtime");
  const accountsPath = join(root, "accounts.json");
  const context: OffckbRunContext = {
    network: "devnet",
    offckbVersion: "0.4.13",
    ckbRequestedVersion: "0.209.0",
    ckbVersion: "0.209.0 (test)",
    genesisHash: HASH,
    rpcUrl: "http://127.0.0.1:8114",
    proxyUrl: "http://127.0.0.1:28114",
    accountsPath,
    systemScriptsPath: join(root, "system-scripts.json"),
    contextPath: join(root, "context.json"),
    systemScripts: {},
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
    async installDebugger() {},
    async debuggerVersion() {
      return "ckb-debugger 1.1.1";
    },
    async debugScript() {
      return { ...commandResult(debuggerOutput, "Command failed"), exitCode: debuggerOutput === "" ? 0 : 1 };
    },
    async stop() {},
  };
}

describe("runManifest", () => {
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

    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet: fakeDevnet(project),
      runStep,
      rpc,
      signal: controller.signal,
    });

    expect(result.verdict).toBe("PASS");
    expect(result.report.evidence.steps[0]).toMatchObject({
      name: "transfer",
      expectedStatus: "committed",
      observedStatus: "committed",
      transactionHash: txHash,
      cycles: 100,
      claims: [{ expected: { count: 1 }, observed: { count: 1 }, ok: true }],
    });
    expect(await Bun.file(result.reportPath).exists()).toBe(true);
    expect(result.report.digests.outcome).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.report.digests.environment).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.report.environment).toMatchObject({
      sourceRevision: { gitCommit: null, dirty: null },
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

  test("redacts and rejects evidence containing an OffCKB development private key", async () => {
    const { project, manifestPath, outputDir } = await projectWithManifest(1);
    const manifest = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, manifest.replace('spec = "0.1.0-draft.3"', `spec = "0.1.0-draft.3"\ndescription = "${KEY}"`));
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

    await expect(
      runManifest({ manifestPath, projectRoot: project, outputDir, devnet: fakeDevnet(project), runStep, rpc }),
    ).rejects.toThrow("development private key");
    expect(await Bun.file(join(outputDir, "manifest.toml")).text()).not.toContain(KEY);
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

    const result = await runManifest({
      manifestPath,
      projectRoot: project,
      outputDir,
      devnet: fakeDevnet(project, "Run result: -11\nAll cycles: 393345(384.1K)\n"),
      runStep,
      rpc,
    });

    expect(submitted).toBe(true);
    expect(result.verdict).toBe("PASS");
    expect(result.report.environment).toMatchObject({
      observedToolchain: { ckbDebugger: "ckb-debugger 1.1.1" },
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
