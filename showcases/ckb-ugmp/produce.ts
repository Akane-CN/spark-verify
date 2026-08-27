import { readFile, rename, writeFile } from "node:fs/promises";
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import { createSpore } from "@ckb-ccc/spore";
import { sporeScriptInfoFromSystemScripts } from "./spore";

const DOB_METADATA_CONTENT_TYPE = "application/json;dob=0";
const GAME_PROFILE = {
  v: 0,
  n: "CKB-UGMP deterministic devnet game profile",
  r: "urn:ckb-ugmp:showcase:game-profile:v1",
  m: "application/json",
} as const;

type KnownScripts = Partial<
  Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>
>;
type SporeSdkSigner = Parameters<typeof createSpore>[0]["signer"];

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

function knownScriptInfo(
  devnet: Record<string, unknown>,
  name: string,
): ccc.ScriptInfoLike {
  const entry = object(devnet[name], `system scripts file.devnet.${name}`);
  return object(
    entry.script,
    `system scripts file.devnet.${name}.script`,
  ) as unknown as ccc.ScriptInfoLike;
}

class OffckbClient extends ccc.ClientJsonRpc {
  constructor(
    url: string,
    private readonly knownScripts: KnownScripts,
  ) {
    super(url, { fallbacks: [] });
  }

  get addressPrefix(): string {
    return "ckt";
  }

  async getKnownScript(script: ccc.KnownScript): Promise<ccc.ScriptInfo> {
    const found = this.knownScripts[script];
    if (found === undefined) {
      throw new Error(`OffCKB did not export required script ${script}`);
    }
    return ccc.ScriptInfo.from(found);
  }
}

const resultPath = requireEnv("CKB_VERIFY_RESULT");
const rpcUrl = requireEnv("CKB_VERIFY_RPC_URL");
const accountsPath = requireEnv("CKB_VERIFY_ACCOUNTS");
const systemScriptsPath = requireEnv("CKB_VERIFY_SYSTEM_SCRIPTS");
const mode = process.argv[2];
if (mode !== "committed" && mode !== "rejected") {
  throw new Error("mode must be committed or rejected");
}

const accountRoot = object(await jsonFile(accountsPath), "accounts file");
if (!Array.isArray(accountRoot.accounts) || accountRoot.accounts.length < 1) {
  throw new Error("accounts file must contain at least one account");
}
const sender = object(accountRoot.accounts[0], "accounts[0]");
if (typeof sender.privkey !== "string") {
  throw new Error("accounts[0].privkey is required");
}

const rawSystemScripts = await jsonFile(systemScriptsPath);
const scriptRoot = object(rawSystemScripts, "system scripts file");
const devnet = object(scriptRoot.devnet, "system scripts file.devnet");
const knownScripts: KnownScripts = {
  [ccc.KnownScript.Secp256k1Blake160]: knownScriptInfo(
    devnet,
    "secp256k1_blake160_sighash_all",
  ),
  [ccc.KnownScript.AnyoneCanPay]: knownScriptInfo(devnet, "anyone_can_pay"),
  [ccc.KnownScript.NervosDao]: knownScriptInfo(devnet, "dao"),
};
const client = new OffckbClient(rpcUrl, knownScripts);

// @ckb-ccc/spore 1.5.17 carries core 1.12.5 while this runner keeps core
// 1.14.0. The signer APIs are runtime-compatible; keep the cast at this one
// package boundary instead of downgrading the runner's shared CCC dependency.
const cccSigner = new ccc.SignerCkbPrivateKey(client, sender.privkey);
const signer = cccSigner as unknown as SporeSdkSigner;
const scriptInfo = sporeScriptInfoFromSystemScripts(rawSystemScripts);
const content = ccc.bytesFrom(JSON.stringify(GAME_PROFILE), "utf8");

// Adapted build/sign seam from HNO3Miracle/CKB-UGMP at
// 543def6e717b2d67f619a76c3d9283e55b211b83. The runner, not this producer,
// owns transaction submission.
const { tx } = await createSpore({
  signer,
  data: {
    contentType: DOB_METADATA_CONTENT_TYPE,
    content,
  },
  clusterMode: "skip",
  scriptInfo,
});
await tx.completeFeeBy(signer, 1_000n);
const signed = await cccSigner.signTransaction(
  tx as unknown as ccc.TransactionLike,
);

if (mode === "rejected") {
  const witness = signed.getWitnessArgsAt(0);
  if (witness?.lock === undefined) {
    throw new Error("signed transaction has no first witness lock");
  }
  const signature = ccc.bytesFrom(witness.lock);
  if (signature.length === 0) throw new Error("first witness lock is empty");
  signature[0] = (signature[0] ?? 0) ^ 0x01;
  witness.lock = ccc.hexFrom(signature);
  signed.setWitnessArgsAt(0, witness);
}

const envelope = {
  protocol: 1,
  transaction: cccA.JsonRpcTransformers.transactionFrom(
    signed as unknown as ccc.TransactionLike,
  ),
};
const temporaryPath = `${resultPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, {
  mode: 0o600,
});
await rename(temporaryPath, resultPath);
