import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { mkdtemp, readFile, readdir, rm, stat, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { parseManifestText } from "../src/manifest";
import { isManifestV4 } from "../src/types";
import { claimDefinition, deriveOutcomeV2, populateEvidenceV2, verdictForOutcomeV2, type RunInputV2 } from "../src/cell-claims";
import { syntheticReportV2, syntheticTransaction, liveResponse, bindings } from "./fixtures/claims-v2/synthetic";
import { canonicalSha256, sha256Bytes } from "../src/canonical";
import { transactionHash } from "../src/transaction";

const positiveToml = `[meta]
name = "cell-properties-dao"
spec = "0.1.0-draft.4"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "deposit"
run = "bun run showcases/cell-properties/produce.ts dao"
timeout = "60s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "deposit", index = 0 }
count = 1
type = { builtin = "dao", args_bytes = 0 }
data = { min_bytes = 1 }

[[step.assert.cell_deps]]
step = "deposit"
contains = { builtin = "dao" }
`;
const manifestCases = {
  committed: positiveToml,
  "wrong-type": positiveToml.replace('type = { builtin = "dao", args_bytes = 0 }', 'type = { builtin = "spore", args_bytes = 0 }'),
  "wrong-data": positiveToml.replace("min_bytes = 1", "min_bytes = 9"),
  "missing-dep": positiveToml.replace("produce.ts dao", "produce.ts plain")
    .replace('type = { builtin = "dao", args_bytes = 0 }\n', "").replace('data = { min_bytes = 1 }\n', ""),
  "ordinary-cell": positiveToml.replace("produce.ts dao", "produce.ts plain"),
  "wrong-args": positiveToml.replace("args_bytes = 0", "args_bytes = 1"),
};

test("cell-properties manifests preserve the exact approved six-case committed matrix", async () => {
  for (const [name, expected] of Object.entries(manifestCases)) {
    const file = Bun.file(join(import.meta.dir, `../showcases/cell-properties/verify.${name}.toml`));
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(text).toBe(expected);
    const manifest = parseManifestText(text);
    expect(manifest.meta.spec).toBe("0.1.0-draft.4");
    expect(manifest.steps[0]!.expect).toEqual({ tx: "committed" });
    expect(manifest.toolchain.ckbDebugger).toBeUndefined();
    expect(manifest.steps[0]!.assertions.length).toBe(2);
  }
});

const cellProducer = join(import.meta.dir, "../showcases/cell-properties/produce.ts");
const hex32 = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;
function localContext(byte: string) {
  return {
    network: "devnet" as const, rpcUrl: "http://127.0.0.1:1",
    systemScripts: {
      secp256k1_blake160_sighash_all: { codeHash: hex32("11"), hashType: "type" as const,
        cellDeps: [{ outPoint: { txHash: hex32("22"), index: 0 }, depType: "depGroup" as const }] },
      anyone_can_pay: { codeHash: hex32("66"), hashType: "type" as const,
        cellDeps: [{ outPoint: { txHash: hex32("66"), index: 0 }, depType: "code" as const }] },
      dao: { codeHash: hex32(byte), hashType: "type" as const,
        cellDeps: [{ outPoint: { txHash: hex32(byte), index: 2 }, depType: "code" as const }] },
    },
  };
}

test("cell-properties builds a 200 CKB DAO output from fresh context identity", async () => {
  expect(await Bun.file(cellProducer).exists()).toBe(true);
  const { clientFromContext, buildTransaction } = await import(cellProducer);
  for (const byte of ["33", "44"]) {
    const context = localContext(byte);
    const client = clientFromContext(context, context.rpcUrl);
    const signer = new ccc.SignerCkbPrivateKey(client, hex32("01")); // synthetic disposable key
    const lock = (await signer.getRecommendedAddressObj()).script;
    const tx: ccc.Transaction = await buildTransaction("dao", signer, lock);
    expect(tx.outputs[0]!.capacity).toBe(ccc.fixedPointFrom(200));
    expect(tx.outputs[0]!.lock.eq(lock)).toBe(true);
    expect(tx.outputs[0]!.type?.codeHash).toBe(hex32(byte));
    expect(tx.outputs[0]!.type?.hashType).toBe("type");
    expect(tx.outputs[0]!.type?.args).toBe("0x");
    expect(tx.outputsData).toEqual(["0x0000000000000000"]);
    expect(tx.cellDeps.map(dep => ({ hash: dep.outPoint.txHash, index: dep.outPoint.index, kind: dep.depType })))
      .toEqual([{ hash: hex32(byte), index: 2n, kind: "code" }]);
  }
});

test("cell-properties plain mode builds an untyped empty-data transfer without DAO deps", async () => {
  const { clientFromContext, buildTransaction } = await import(cellProducer);
  const context = localContext("33");
  const client = clientFromContext(context, context.rpcUrl);
  const signer = new ccc.SignerCkbPrivateKey(client, hex32("01"));
  const receiver = ccc.Script.from({ codeHash: hex32("11"), hashType: "type", args: `0x${"77".repeat(20)}` });
  const tx: ccc.Transaction = await buildTransaction("plain", signer, receiver);
  expect(tx.outputs[0]!.lock.eq(receiver)).toBe(true);
  expect(tx.outputs[0]!.capacity).toBe(ccc.fixedPointFrom(100));
  expect(tx.outputs[0]!.type).toBeUndefined();
  expect(tx.outputsData).toEqual(["0x"]);
  expect(tx.cellDeps).toEqual([]);
  await expect(buildTransaction("other", signer, receiver)).rejects.toThrow("mode must be dao or plain");
});

test("cell-properties completes and signs both modes into private atomic protocol-1 envelopes", async () => {
  const module = await import(cellProducer);
  expect(typeof module.produce).toBe("function");
  const directory = await mkdtemp(join(tmpdir(), "cell-producer-"));
  try {
    for (const mode of ["dao", "plain"]) {
      const context = localContext("33");
      const client: ccc.ClientPublicTestnet = module.clientFromContext(context, context.rpcUrl);
      await expect(client.getKnownScript(ccc.KnownScript.AnyoneCanPay)).resolves.toMatchObject({ codeHash: hex32("66") });
      client.getFeeRate = async () => { throw new Error("fee history must not be queried"); };
      const signer = new ccc.SignerCkbPrivateKey(client, hex32("01"));
      const lock = (await signer.getRecommendedAddressObj()).script;
      // Synthetic funding Cell only; CCC completion/signing/serialization are real.
      const funding = ccc.Cell.from({ outPoint: { txHash: hex32("55"), index: 0 },
        cellOutput: { capacity: ccc.fixedPointFrom(1000), lock }, outputData: "0x" });
      signer.findCells = async function* () { yield funding; };
      const path = join(directory, `${mode}.json`);
      await module.produce(mode, signer, lock, path);
      const text = await readFile(path, "utf8");
      const envelope = JSON.parse(text);
      expect(Object.keys(envelope).sort()).toEqual(["protocol", "transaction"]);
      expect(envelope.protocol).toBe(1);
      const tx = cccA.JsonRpcTransformers.transactionTo(envelope.transaction);
      expect(tx.inputs.length).toBe(1);
      expect(ccc.bytesFrom(tx.getWitnessArgsAt(0)!.lock!).length).toBe(65);
      expect(funding.cellOutput.capacity - tx.getOutputsCapacity()).toBe(tx.estimateFee(1_000n));
      expect(tx.cellDeps.some(dep => dep.outPoint.txHash === hex32("33"))).toBe(mode === "dao");
      expect(text).not.toContain(hex32("01").slice(2));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readdir(directory)).some(name => name.includes(".tmp-"))).toBe(false);
    }
    const source = await readFile(cellProducer, "utf8");
    expect(source).toContain("signTransaction");
    expect(source).not.toMatch(/sendTransaction|send_transaction/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cell-properties entrypoint refuses incomplete context and non-private accounts without output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cell-entry-"));
  try {
    const resultPath = join(directory, "result.json");
    const accountsPath = join(directory, "accounts.json");
    await Bun.write(accountsPath, JSON.stringify({ accounts: [{ privkey: hex32("01") }] }));
    for (const args of [["dao"], ["plain"], ["other"], ["dao", "extra"]]) {
      const result = Bun.spawnSync({ cmd: [process.execPath, "run", cellProducer, ...args], cwd: root,
        env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("CKB_VERIFY_");
    }
    const result = Bun.spawnSync({ cmd: [process.execPath, "run", cellProducer, "dao"], cwd: root,
      env: { PATH: process.env.PATH ?? "", CKB_VERIFY_RESULT: resultPath, CKB_VERIFY_ACCOUNTS: accountsPath,
        CKB_VERIFY_RPC_URL: "http://127.0.0.1:1", CKB_VERIFY_CONTEXT: join(directory, "unused.json") },
      stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("mode-0600");
    expect(result.stderr.toString()).not.toContain(hex32("01").slice(2));
    expect(await Bun.file(resultPath).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cell-properties wrapper checks files and ports even when CLI and report audit fail", async () => {
  const wrapper = join(root, "showcases/cell-properties/verify.sh");
  expect(await Bun.file(wrapper).exists()).toBe(true);
  const result = Bun.spawnSync({ cmd: ["bash", "-c", `
    source "$1"
    run_fixture() { printf 'inert refusal\\n'; return 2; }
    audit_report() { printf 'AUDIT_FAILURE\\n' >&2; return 7; }
    verify_files() { printf 'FILES_CHECKED\\n'; return 8; }
    verify_ports() { printf 'PORTS_CHECKED\\n'; return 9; }
    run_case committed
  `, "inert-wrapper-test", wrapper], cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("AUDIT_FAILURE");
  expect(result.stdout.toString()).toContain("FILES_CHECKED");
  expect(result.stdout.toString()).toContain("PORTS_CHECKED");
  expect(result.stdout.toString()).not.toContain("ACCEPTANCE PASS");
});

// These deliberately synthetic report controls test the wrapper, never native acceptance.
function wrapperUnitReport(name: keyof typeof manifestCases, data?: string) {
  const report = syntheticReportV2();
  const text = manifestCases[name], m = parseManifestText(text);
  if (!isManifestV4(m)) throw new Error("test requires draft.4");
  const plain = name === "missing-dep" || name === "ordinary-cell";
  const tx = syntheticTransaction(!plain);
  (tx.outputs[0] as { capacity: string }).capacity = `0x${ccc.fixedPointFrom(plain ? 100 : 200).toString(16)}`;
  tx.outputs_data = [data ?? (plain ? "0x" : "0x0000000000000000")];
  tx.cell_deps = plain ? [] : bindings.dao!.cellDeps.map(d => ({ out_point: {
    tx_hash: d.outPoint.txHash, index: `0x${d.outPoint.index.toString(16)}` }, dep_type: d.depType === "code" ? "code" : "dep_group" }));
  report.environment.provenance.manifest.sha256 = sha256Bytes(Buffer.from(text));
  const input: RunInputV2 = { name: m.meta.name, spec: m.meta.spec, manifestText: text, assertions: [],
    steps: [{ name: "deposit", expectedStatus: "committed", observedStatus: "committed", durationMs: 1,
      transaction: tx, transactionHash: transactionHash(tx), claims: m.steps[0]!.assertions.map(c => c.kind === "cell_deps"
        ? claimDefinition(c) : { ...claimDefinition(c), input: { kind: "query", outPoint: { tx_hash: transactionHash(tx), index: "0x0" },
          response: liveResponse(tx) as import("../src/cell-claims").LiveCellResponse } }) }] };
  report.outcomeClaims = deriveOutcomeV2(input, report.environment);
  report.evidence = populateEvidenceV2(input, report.outcomeClaims);
  report.verdict = verdictForOutcomeV2(report.outcomeClaims);
  report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
  return report;
}
async function wrapperCode(marker: string) {
  const source = await readFile(join(root, "showcases/cell-properties/verify.sh"), "utf8");
  const code = source.split(`<<'${marker}'\n`)[1]?.split(`\n${marker}\n`)[0];
  expect(typeof code).toBe("string");
  return code!;
}
async function runWrapperCode(code: string, args: string[], cwd = root) {
  const child = Bun.spawn({ cmd: [process.execPath, "-", ...args], cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(code); child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("cell-properties audit reads complete synthetic PASS and FAIL controls and rejects wrong failure causes", async () => {
  const code = await wrapperCode("REPORT_AUDIT");
  const directory = await mkdtemp(join(tmpdir(), "synthetic-wrapper-audit-"));
  try {
    const path = join(directory, "report.json");
    const audit = async (name: keyof typeof manifestCases, report = wrapperUnitReport(name), exit = name === "committed" ? 0 : 1) => {
      await Bun.write(path, JSON.stringify(report));
      const output = `${report.verdict}: ${report.verdict === "PASS" ? "All declared claims passed in the recorded environment." : "Declared claims failed."}\nreport: ${path}\noutcome: ${report.digests.outcome}\nenvironment: ${report.digests.environment}\n`;
      return runWrapperCode(code, [name, String(exit), output]);
    };
    for (const name of Object.keys(manifestCases) as Array<keyof typeof manifestCases>) {
      const result = await audit(name);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(path);
    }
    expect((await audit("wrong-data", wrapperUnitReport("wrong-data", "0x"))).exitCode).not.toBe(0);
    expect((await audit("committed", wrapperUnitReport("committed"), 1)).exitCode).not.toBe(0);
    const tampered = wrapperUnitReport("wrong-args"); tampered.verdict = "PASS";
    expect((await audit("wrong-args", tampered)).exitCode).not.toBe(0);
    const incomplete = wrapperUnitReport("committed"); delete (incomplete as { schema?: string }).schema;
    expect((await audit("committed", incomplete)).exitCode).not.toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cell-properties closeout detects account, pending evidence and occupied IPv4/IPv6 ports", async () => {
  const files = await wrapperCode("FILES_CHECK"), ports = await wrapperCode("PORTS_CHECK");
  const directory = await mkdtemp(join(tmpdir(), "wrapper-cleanup-"));
  try {
    expect((await runWrapperCode(files, [], directory)).exitCode).toBe(0);
    for (const relative of [".ckb-verify/offckb/accounts.json", ".ckb-verify/runs/a/.report.json.pending"]) {
      const path = join(directory, relative);
      await mkdir(join(path, ".."), { recursive: true }); await Bun.write(path, "synthetic-remnant");
      expect((await runWrapperCode(files, [], directory)).exitCode).not.toBe(0);
      await rm(path);
    }
    expect((await runWrapperCode(ports, [])).exitCode).toBe(0);
    for (const host of ["127.0.0.1", "::1"]) {
      const listener = createServer();
      try {
        await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen({ host, port: 28114, ipv6Only: true }, resolve); });
        expect((await runWrapperCode(ports, [])).exitCode).not.toBe(0);
        expect(listener.listening).toBe(true); // Do not kill someone else's listener.
      } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cell-properties repeat comparison preserves real binding differences and refuses unrelated drift", async () => {
  const code = await wrapperCode("REPEAT_CHECK");
  const directory = await mkdtemp(join(tmpdir(), "synthetic-repeat-"));
  try {
    const paths = [join(directory, "one/report.json"), join(directory, "two/report.json")];
    for (const path of paths) await mkdir(join(path, ".."), { recursive: true });
    const first = wrapperUnitReport("committed");
    await Bun.write(paths[0]!, JSON.stringify(first));
    const compare = async (other = structuredClone(first)) => {
      other.digests.environment = canonicalSha256(other.environment);
      await Bun.write(paths[1]!, JSON.stringify(other));
      return runWrapperCode(code, paths);
    };
    expect((await compare()).exitCode).toBe(0);
    const changed = structuredClone(first); changed.environment.devnet.genesisHash = hex32("ab");
    const result = await compare(changed);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("recorded-devnet-difference");
    expect(result.stdout.toString()).toContain(hex32("ab"));
    expect(result.stdout.toString()).toContain(first.environment.devnet.genesisHash);
    changed.environment.provenance.source.gitCommit = "b".repeat(40);
    expect((await compare(changed)).exitCode).not.toBe(0);
    expect((await compare(wrapperUnitReport("wrong-data"))).exitCode).not.toBe(0);
    expect((await runWrapperCode(code, [paths[0]!, paths[0]!])).exitCode).not.toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cell-properties named bounded CI command routes six cases and repeat but refuses a dirty preflight", async () => {
  const wrapper = join(root, "showcases/cell-properties/verify.sh");
  const source = await readFile(wrapper, "utf8");
  expect(source).toContain("main() {");
  expect(source).toContain("for name in wrong-type wrong-data missing-dep ordinary-cell wrong-args");
  expect(source.match(/run_case committed/g)?.length).toBe(2);
  expect(source).toContain("timeout --signal=INT --kill-after=15s 300s");
  const result = Bun.spawnSync({ cmd: ["bash", "-c", `
    source "$1"
    verify_files() { printf 'PREFLIGHT_REFUSAL\\n'; return 1; }
    verify_ports() { printf 'PORTS_CHECKED\\n'; }
    run_fixture() { printf 'FORBIDDEN_NATIVE_REACHED\\n'; return 99; }
    main
  `, "inert-main-test", wrapper], cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("PORTS_CHECKED");
  expect(result.stdout.toString()).not.toContain("FORBIDDEN_NATIVE_REACHED");
  const pkg = await Bun.file(join(root, "package.json")).json();
  expect(pkg.scripts["showcase:cell-properties"]).toBe("bash showcases/cell-properties/verify.sh");
  const workflow = await readFile(join(root, ".github/workflows/verify.yml"), "utf8");
  expect(workflow).toContain("  cell-properties:");
  const job = workflow.split("  cell-properties:")[1]!;
  expect(job).toContain("timeout-minutes: 40");
  expect(job).toContain("run: bun run showcase:cell-properties");
  expect(job).not.toMatch(/upload-artifact|pull_request_target/);
});

test("cell-properties never announces acceptance before final independent closeout", () => {
  // Routing/fault-injection control only: no CLI/native process or real report.
  const result = Bun.spawnSync({ cmd: ["bash", "-c", `
    source "$1"
    checks=0
    verify_files() { checks=$((checks + 1)); (( checks == 1 )); }
    verify_ports() { printf 'FINAL_PORT_CHECK\\n'; }
    run_case() { LAST_REPORT=inert; return 0; }
    compare_repeat() { return 0; }
    main
  `, "inert-final-closeout", join(root, "showcases/cell-properties/verify.sh")], cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("FINAL_PORT_CHECK");
  expect(result.stdout.toString()).not.toContain("ACCEPTANCE PASS");
});

const root = join(import.meta.dir, "..");
const producer = join(root, "showcases", "secp-transfer", "produce.ts");

describe("secp transfer showcase producer boundary", () => {
  test("fails before touching the chain when runner context is missing", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", producer, "committed"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("CKB_VERIFY_RESULT");
  });

  test("contains no transaction submission call", async () => {
    const source = await Bun.file(producer).text();

    expect(source).toContain("signTransaction");
    expect(source).not.toContain("sendTransaction");
    expect(source).not.toContain("send_transaction");
  });
});
