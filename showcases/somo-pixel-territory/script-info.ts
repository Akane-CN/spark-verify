import type { ccc } from "@ckb-ccc/core";

export interface SoMoScriptInfos {
  cluster: ccc.ScriptInfoLike & { cobuild: true };
  anyoneCanPay: ccc.ScriptInfoLike;
  secp256k1: ccc.ScriptInfoLike;
  dao: ccc.ScriptInfoLike;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function scriptInfo(devnet: Record<string, unknown>, name: string): ccc.ScriptInfoLike {
  const entry = object(devnet[name], `system scripts file.devnet.${name}`);
  return object(entry.script, `system scripts file.devnet.${name}.script`) as unknown as ccc.ScriptInfoLike;
}

export function resolveSoMoScriptInfos(systemScripts: unknown): SoMoScriptInfos {
  const root = object(systemScripts, "system scripts file");
  const devnet = object(root.devnet, "system scripts file.devnet");
  const cluster = scriptInfo(devnet, "spore_cluster");

  return {
    cluster: { ...cluster, cobuild: true },
    anyoneCanPay: scriptInfo(devnet, "anyone_can_pay"),
    secp256k1: scriptInfo(devnet, "secp256k1_blake160_sighash_all"),
    dao: scriptInfo(devnet, "dao"),
  };
}
