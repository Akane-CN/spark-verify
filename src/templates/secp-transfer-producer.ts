import { readFile, rename, writeFile } from "node:fs/promises";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const resultPath = requireEnv("CKB_VERIFY_RESULT");
const rpcUrl = requireEnv("CKB_VERIFY_RPC_URL");
const accountsPath = requireEnv("CKB_VERIFY_ACCOUNTS");
const systemScriptsPath = requireEnv("CKB_VERIFY_SYSTEM_SCRIPTS");
const mode = process.argv[2];
if (mode !== "committed" && mode !== "rejected") throw new Error("mode must be committed or rejected");

const accountRoot = object(await jsonFile(accountsPath), "accounts file");
if (!Array.isArray(accountRoot.accounts) || accountRoot.accounts.length < 2) {
  throw new Error("accounts file must contain at least two accounts");
}
const sender = object(accountRoot.accounts[0], "accounts[0]");
const receiverAccount = object(accountRoot.accounts[1], "accounts[1]");
if (typeof sender.privkey !== "string") throw new Error("accounts[0].privkey is required");
if (typeof receiverAccount.address !== "string") throw new Error("accounts[1].address is required");

const scriptRoot = object(await jsonFile(systemScriptsPath), "system scripts file");
const devnet = object(scriptRoot.devnet, "system scripts file.devnet");
function script(name: string): ccc.ScriptInfoLike {
  const entry = object(devnet[name], `system scripts file.devnet.${name}`);
  return object(entry.script, `system scripts file.devnet.${name}.script`) as unknown as ccc.ScriptInfoLike;
}

const scripts = {
  [ccc.KnownScript.Secp256k1Blake160]: script("secp256k1_blake160_sighash_all"),
  [ccc.KnownScript.AnyoneCanPay]: script("anyone_can_pay"),
  [ccc.KnownScript.NervosDao]: script("dao"),
} as unknown as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>;
const client = new ccc.ClientPublicTestnet({ url: rpcUrl, fallbacks: [], scripts });
const signer = new ccc.SignerCkbPrivateKey(client, sender.privkey);
const receiver = await ccc.Address.fromString(receiverAccount.address, client);
const transaction = ccc.Transaction.from({
  outputs: [{ lock: receiver.script, capacity: ccc.fixedPointFrom(100) }],
});
await transaction.completeInputsByCapacity(signer);
await transaction.completeFeeBy(signer, 1_000n);
const signed = await signer.signTransaction(transaction as unknown as ccc.TransactionLike);

if (mode === "rejected") {
  const witness = signed.getWitnessArgsAt(0);
  if (witness?.lock === undefined) throw new Error("signed transaction has no first witness lock");
  const signature = ccc.bytesFrom(witness.lock);
  if (signature.length === 0) throw new Error("first witness lock is empty");
  signature[0] = (signature[0] ?? 0) ^ 0x01;
  witness.lock = ccc.hexFrom(signature);
  signed.setWitnessArgsAt(0, witness);
}

const envelope = {
  protocol: 1,
  transaction: cccA.JsonRpcTransformers.transactionFrom(signed as unknown as ccc.TransactionLike),
};
const temporaryPath = `${resultPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryPath, resultPath);
