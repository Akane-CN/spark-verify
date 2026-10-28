import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { writeFile, rename, rm, lstat, readFile } from "node:fs/promises";
import { validateBinding } from "../../src/cell-claims";
import type { OffckbRunContext } from "../../src/offckb";

type ProducerContext = Pick<OffckbRunContext, "network" | "rpcUrl" | "systemScripts">;

/** Use the runner's normalized fresh export, never a second deployment map. */
export function clientFromContext(context: ProducerContext, rpcUrl: string): ccc.ClientPublicTestnet {
  if (context.network !== "devnet" || context.rpcUrl !== rpcUrl) throw new Error("runner context mismatch");
  const known = (name: string): ccc.ScriptInfoLike => {
    const binding = validateBinding(context.systemScripts[name], `context.systemScripts.${name}`);
    return { codeHash: binding.codeHash, hashType: binding.hashType,
      cellDeps: binding.cellDeps.map(cellDep => ({ cellDep })) };
  };
  return new ccc.ClientPublicTestnet({ url: rpcUrl, fallbacks: [], scripts: {
    [ccc.KnownScript.Secp256k1Blake160]: known("secp256k1_blake160_sighash_all"),
    [ccc.KnownScript.AnyoneCanPay]: known("anyone_can_pay"),
    [ccc.KnownScript.NervosDao]: known("dao"),
  } as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> });
}

export async function buildTransaction(mode: string, signer: ccc.Signer, receiver: ccc.ScriptLike): Promise<ccc.Transaction> {
  if (mode !== "dao" && mode !== "plain") throw new Error("mode must be dao or plain");
  if (mode === "plain") return ccc.Transaction.from({ outputs: [{ capacity: ccc.fixedPointFrom(100), lock: receiver }] });
  const lock = (await signer.getRecommendedAddressObj()).script;
  const type = await ccc.Script.fromKnownScript(signer.client, ccc.KnownScript.NervosDao, "0x");
  const transaction = ccc.Transaction.from({
    outputs: [{ capacity: ccc.fixedPointFrom(200), lock, type }],
    outputsData: ["0x0000000000000000"],
  });
  await transaction.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.NervosDao);
  return transaction;
}

export async function produce(mode: string, signer: ccc.Signer, receiver: ccc.ScriptLike, resultPath: string): Promise<void> {
  const transaction = await buildTransaction(mode, signer, receiver);
  await transaction.completeInputsByCapacity(signer);
  await transaction.completeFeeBy(signer, 1_000n);
  // CCC 1.14.0 class optional members predate exactOptionalPropertyTypes.
  const signed = await signer.signTransaction(transaction as unknown as ccc.TransactionLike);
  const envelope = { protocol: 1, transaction: cccA.JsonRpcTransformers.transactionFrom(signed as unknown as ccc.TransactionLike) };
  const temporaryPath = `${resultPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporaryPath, resultPath); }
  finally { await rm(temporaryPath, { force: true }); }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "dao" && mode !== "plain")) throw new Error("invalid mode");
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error("missing runner context");
    return value;
  };
  const resultPath = required("CKB_VERIFY_RESULT");
  const accountsPath = required("CKB_VERIFY_ACCOUNTS");
  const contextPath = required("CKB_VERIFY_CONTEXT");
  const rpcUrl = required("CKB_VERIFY_RPC_URL");
  const metadata = await lstat(accountsPath);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error("accounts must be private");
  const { accounts } = JSON.parse(await readFile(accountsPath, "utf8"));
  if (!Array.isArray(accounts) || accounts.length < 2 ||
      typeof accounts[0]?.privkey !== "string" || !/^0x[0-9a-f]{64}$/.test(accounts[0].privkey) ||
      typeof accounts[1]?.address !== "string") throw new Error("invalid accounts");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const client = clientFromContext(context, rpcUrl);
  const signer = new ccc.SignerCkbPrivateKey(client, accounts[0].privkey);
  const receiver = await ccc.Address.fromString(accounts[1].address, client);
  await produce(mode, signer, receiver.script, resultPath);
}

if (import.meta.main) {
  try { await main(); }
  catch {
    // Never render CCC/parser exceptions that might echo account material.
    console.error("cell-properties producer failed; require dao|plain and complete CKB_VERIFY_* context with mode-0600 accounts");
    process.exitCode = 1;
  }
}
