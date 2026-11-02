// Repository-owned v0.1 (spec 0.1.0) vocabulary fixture: one transaction that mints an owner-mode xUDT Cell to the
// development signer and transfers 100 CKB to the second account. Trusted-code producer; never broadcasts.
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { writeFile, rename, rm, lstat, readFile } from "node:fs/promises";
import { validateBinding } from "../../src/cell-claims";
import type { OffckbRunContext } from "../../src/offckb";

type ProducerContext = Pick<OffckbRunContext, "network" | "rpcUrl" | "systemScripts">;
export const MINT_AMOUNT = 1000n;
export const XUDT_CAPACITY_CKB = 150;

/** Use the runner's normalized fresh export, never a second deployment map. */
export function clientFromContext(context: ProducerContext, rpcUrl: string): ccc.ClientPublicTestnet {
  if (context.network !== "devnet" || context.rpcUrl !== rpcUrl) throw new Error("runner context mismatch");
  const known = (name: string): ccc.ScriptInfoLike => {
    const binding = validateBinding(context.systemScripts[name], `context.systemScripts.${name}`);
    return { codeHash: binding.codeHash, hashType: binding.hashType, cellDeps: binding.cellDeps.map((cellDep) => ({ cellDep })) };
  };
  return new ccc.ClientPublicTestnet({ url: rpcUrl, fallbacks: [], scripts: {
    [ccc.KnownScript.Secp256k1Blake160]: known("secp256k1_blake160_sighash_all"),
    [ccc.KnownScript.AnyoneCanPay]: known("anyone_can_pay"),
    [ccc.KnownScript.NervosDao]: known("dao"), // CCC fee completion inspects DAO identity on every input
    [ccc.KnownScript.XUdt]: known("xudt"),
  } as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> });
}

/** 16-byte little-endian unsigned amount, the UDT data prefix the v0.1 balance claim decodes. */
export function udtAmountData(amount: bigint): string {
  return `0x${Buffer.from(amount.toString(16).padStart(32, "0"), "hex").reverse().toString("hex")}`;
}

export async function buildTransaction(mode: string, signer: ccc.Signer, receiver: ccc.ScriptLike): Promise<ccc.Transaction> {
  if (mode !== "mint") throw new Error("mode must be mint");
  const owner = (await signer.getRecommendedAddressObj()).script;
  // Owner mode: the xUDT args are the owner lock hash; the signer's own input satisfies it.
  const type = await ccc.Script.fromKnownScript(signer.client, ccc.KnownScript.XUdt, owner.hash());
  const transaction = ccc.Transaction.from({
    outputs: [
      { capacity: ccc.fixedPointFrom(XUDT_CAPACITY_CKB), lock: owner, type },
      { capacity: ccc.fixedPointFrom(100), lock: receiver },
    ],
    outputsData: [udtAmountData(MINT_AMOUNT), "0x"],
  });
  await transaction.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.XUdt);
  return transaction;
}

export async function produce(mode: string, signer: ccc.Signer, receiver: ccc.ScriptLike, resultPath: string): Promise<void> {
  const transaction = await buildTransaction(mode, signer, receiver);
  await transaction.completeInputsByCapacity(signer);
  await transaction.completeFeeBy(signer, 1_000n);
  const signed = await signer.signTransaction(transaction as unknown as ccc.TransactionLike);
  const envelope = { protocol: 1, transaction: cccA.JsonRpcTransformers.transactionFrom(signed as unknown as ccc.TransactionLike) };
  const temporaryPath = `${resultPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporaryPath, resultPath); }
  finally { await rm(temporaryPath, { force: true }); }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || mode !== "mint") throw new Error("invalid mode");
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
    console.error("vocabulary producer failed; require mint and complete CKB_VERIFY_* context with mode-0600 accounts");
    process.exitCode = 1;
  }
}
