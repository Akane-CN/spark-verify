// Spec 0.2.0 showcase producer: the runner deploys showcases/repository-script/build/witness_lock from this
// repository ([setup.scripts]); these commands create Cells locked by it and spend them. The witness lock
// accepts a spend when witness 0 of its group starts with its args' first byte (exit 42 otherwise).
// Trusted-code producer: it never broadcasts; the runner submits every transaction it writes.
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";

/** The runner's normalized OffCKB binding shape; checked here so the producer is self-contained (no repository imports). */
interface Binding { codeHash: string; hashType: "type" | "data" | "data1" | "data2"; cellDeps: Array<{ outPoint: { txHash: string; index: number }; depType: "code" | "depGroup" }> }
function validateBinding(value: unknown, name: string): Binding {
  const b = value as Binding | undefined;
  if (b === undefined || !/^0x[0-9a-f]{64}$/.test(b.codeHash) || !["type", "data", "data1", "data2"].includes(b.hashType) || !Array.isArray(b.cellDeps) ||
      !b.cellDeps.every((d) => /^0x[0-9a-f]{64}$/.test(d.outPoint?.txHash) && Number.isSafeInteger(d.outPoint?.index) && (d.depType === "code" || d.depType === "depGroup"))) {
    throw new Error(`${name} binding is malformed`);
  }
  return b;
}

/** 300 CKB in shannons. */
export const CELL_CAPACITY = 300n * 100_000_000n;
/** A fixed fee keeps every transaction, and so every digest, identical across fresh devnets. */
export const SPEND_FEE_SHANNON = 100_000n;
export const MODES = ["inspect", "create", "spend-matching", "spend-wrong", "spend-again", "pure-writes-result"] as const;
type Mode = (typeof MODES)[number];

interface SetupScriptInfo { codeHash: string; hashType: "type" | "data" | "data1" | "data2"; cellDeps: Array<{ outPoint: { txHash: string; index: number }; depType: "code" | "depGroup" }> }

export function lockOf(script: SetupScriptInfo, args: string): ccc.Script {
  return ccc.Script.from({ codeHash: script.codeHash, hashType: script.hashType, args });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing runner context");
  return value;
}

async function writeResult(resultPath: string, transaction: ccc.Transaction): Promise<void> {
  const envelope = { protocol: 1, transaction: cccA.JsonRpcTransformers.transactionFrom(transaction as unknown as ccc.TransactionLike) };
  const temporaryPath = `${resultPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporaryPath, resultPath); } finally { await rm(temporaryPath, { force: true }); }
}

/** Spends one witness-lock Cell to `receiver` with the given raw witness; no signature is involved. */
export function spendTransaction(cell: { txHash: string; index: number; capacity: bigint }, script: SetupScriptInfo, receiver: ccc.ScriptLike, witness: string): ccc.Transaction {
  return ccc.Transaction.from({
    cellDeps: script.cellDeps.map((dep) => ({ outPoint: dep.outPoint, depType: dep.depType })),
    inputs: [{ previousOutput: { txHash: cell.txHash, index: cell.index } }],
    outputs: [{ capacity: cell.capacity - SPEND_FEE_SHANNON, lock: receiver }],
    outputsData: ["0x"],
    witnesses: [witness],
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode;
  if (process.argv.length !== 3 || !MODES.includes(mode)) throw new Error("invalid mode");
  const resultPath = required("CKB_VERIFY_RESULT");
  const rpcUrl = required("CKB_VERIFY_RPC_URL");
  const { scripts } = JSON.parse(await readFile(required("CKB_VERIFY_SCRIPTS"), "utf8")) as { scripts: Record<string, SetupScriptInfo> };
  const witnessLock = scripts.witness_lock, witnessLockV1 = scripts.witness_lock_v1;
  if (witnessLock === undefined) throw new Error("setup script witness_lock is not deployed");
  if (mode === "inspect") {
    // A pure step: read the deployment the runner recorded, check it, and write no result.
    validateBinding({ codeHash: witnessLock.codeHash, hashType: witnessLock.hashType, cellDeps: witnessLock.cellDeps }, "witness_lock");
    console.log(`witness_lock ${witnessLock.hashType} ${witnessLock.codeHash}`);
    return;
  }
  if (mode === "pure-writes-result") {
    // Negative control: a pure step that writes a result must be refused by the runner.
    await writeFile(resultPath, "{}\n", { flag: "wx", mode: 0o600 });
    return;
  }
  const accountsPath = required("CKB_VERIFY_ACCOUNTS");
  const metadata = await lstat(accountsPath);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error("accounts must be private");
  const { accounts } = JSON.parse(await readFile(accountsPath, "utf8"));
  const context = JSON.parse(await readFile(required("CKB_VERIFY_CONTEXT"), "utf8"));
  const binding = validateBinding(context.systemScripts.secp256k1_blake160_sighash_all, "secp256k1_blake160_sighash_all");
  const known = { codeHash: binding.codeHash, hashType: binding.hashType, cellDeps: binding.cellDeps.map((cellDep) => ({ cellDep })) };
  const info = (name: string): ccc.ScriptInfoLike => {
    const b = validateBinding(context.systemScripts[name], name);
    return { codeHash: b.codeHash, hashType: b.hashType, cellDeps: b.cellDeps.map((cellDep) => ({ cellDep })) };
  };
  const client = new ccc.ClientPublicTestnet({ url: rpcUrl, fallbacks: [], scripts: {
    [ccc.KnownScript.Secp256k1Blake160]: known,
    [ccc.KnownScript.AnyoneCanPay]: info("anyone_can_pay"), // CCC derives the signer's addresses from both locks
    [ccc.KnownScript.NervosDao]: info("dao"), // CCC fee completion inspects DAO identity on every input
  } as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> });
  const signer = new ccc.SignerCkbPrivateKey(client, accounts[0].privkey);
  const receiver = (await ccc.Address.fromString(accounts[1].address, client)).script;

  if (mode === "create") {
    if (witnessLockV1 === undefined) throw new Error("setup script witness_lock_v1 is not deployed");
    const transaction = ccc.Transaction.from({
      outputs: [
        { capacity: CELL_CAPACITY, lock: lockOf(witnessLock, "0x01") },
        { capacity: CELL_CAPACITY, lock: lockOf(witnessLockV1, "0x02") },
      ],
      outputsData: ["0x", "0x"],
    });
    await transaction.completeInputsByCapacity(signer);
    await transaction.completeFeeBy(signer, 1_000n);
    await writeResult(resultPath, await signer.signTransaction(transaction as unknown as ccc.TransactionLike));
    return;
  }

  // The Cell "create" made under witness_lock args 0x01: output 0 of the first transaction that created one.
  const lock = lockOf(witnessLock, "0x01");
  let created: { txHash: string; index: number } | undefined;
  // The node indexer follows the chain asynchronously; wait (bounded) for it to index the create step.
  for (let attempt = 0; created === undefined && attempt < 150; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    for await (const entry of client.findTransactions({ script: lock, scriptType: "lock", scriptSearchMode: "exact" }, "asc", 10)) {
      if (!entry.isInput) { created = { txHash: entry.txHash, index: Number(entry.cellIndex) }; break; }
    }
  }
  if (created === undefined) throw new Error("no witness_lock Cell was created");
  const witness = mode === "spend-wrong" ? "0x02" : "0x01";
  // spend-again re-spends the Cell after spend-matching consumed it, to a different receiver: a dead input.
  const to = mode === "spend-again" ? (await signer.getRecommendedAddressObj()).script : receiver;
  await writeResult(resultPath, spendTransaction({ ...created, capacity: CELL_CAPACITY }, witnessLock, to, witness));
}

if (import.meta.main) {
  try { await main(); }
  catch {
    // Never render CCC/parser exceptions that might echo account material.
    console.error("repository-script producer failed; require a mode and the complete CKB_VERIFY_* context");
    process.exitCode = 1;
  }
}
