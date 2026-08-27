import { readFile, rename, writeFile } from "node:fs/promises";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { spore } from "@ckb-ccc/spore";
import { resolveSoMoScriptInfos } from "./script-info";

const CLUSTER_DATA = {
  name: "SoMo Pixel Territory",
  description: "Deterministic SoMo Pixel Territory cluster acceptance fixture.",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function ownerPubkeyHash(lockArgs: ccc.HexLike): ccc.Hex {
  const args = ccc.bytesFrom(lockArgs);
  if (args.length < 20) throw new Error("signer lock args must contain a 20-byte public key hash");
  return ccc.hexFrom(args.slice(0, 20));
}

const resultPath = requireEnv("CKB_VERIFY_RESULT");
const rpcUrl = requireEnv("CKB_VERIFY_RPC_URL");
const accountsPath = requireEnv("CKB_VERIFY_ACCOUNTS");
const systemScriptsPath = requireEnv("CKB_VERIFY_SYSTEM_SCRIPTS");
const mode = process.argv[2];
if (mode !== "committed" && mode !== "rejected") throw new Error("mode must be committed or rejected");

const accountRoot = object(await jsonFile(accountsPath), "accounts file");
if (!Array.isArray(accountRoot.accounts) || accountRoot.accounts.length < 1) {
  throw new Error("accounts file must contain at least one account");
}
const sender = object(accountRoot.accounts[0], "accounts[0]");
if (typeof sender.privkey !== "string") throw new Error("accounts[0].privkey is required");

const scriptInfos = resolveSoMoScriptInfos(await jsonFile(systemScriptsPath));
const scripts = {
  [ccc.KnownScript.Secp256k1Blake160]: scriptInfos.secp256k1,
  [ccc.KnownScript.AnyoneCanPay]: scriptInfos.anyoneCanPay,
  [ccc.KnownScript.NervosDao]: scriptInfos.dao,
} as unknown as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>;
const client = new ccc.ClientPublicTestnet({ url: rpcUrl, fallbacks: [], scripts });
const signer = new ccc.SignerCkbPrivateKey(client, sender.privkey);
const signerLock = (await signer.getRecommendedAddressObj()).script;
const acpLock = ccc.Script.from({
  codeHash: scriptInfos.anyoneCanPay.codeHash,
  hashType: scriptInfos.anyoneCanPay.hashType,
  args: ownerPubkeyHash(signerLock.args),
});

// The pinned SoMo source calls this seam with an ACP `to` lock. Its Spore canary
// carries a nested CCC canary, while this repository intentionally retains CCC
// 1.14.0 at the root; the two APIs meet through their transaction-like shape.
type CreateClusterParams = Parameters<typeof spore.createSporeCluster>[0];
const created = await spore.createSporeCluster({
  signer,
  data: CLUSTER_DATA,
  to: acpLock,
  scriptInfo: scriptInfos.cluster,
} as unknown as CreateClusterParams);
const transaction = ccc.Transaction.from(created.tx as unknown as ccc.TransactionLike);

// ACP is an output lock in this flow, so CCC cannot infer its dep from an input.
// Add the exact CellDep exported by this fresh OffCKB devnet, never testnet data.
await transaction.addCellDepInfos(client, scriptInfos.anyoneCanPay.cellDeps);
await transaction.completeFeeBy(signer, 1_000n);
const signed = await signer.signOnlyTransaction(transaction as unknown as ccc.TransactionLike);

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
