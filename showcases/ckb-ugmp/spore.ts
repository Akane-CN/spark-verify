import type { SporeScriptInfoLike } from "@ckb-ccc/spore";

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hex32(value: unknown, path: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${path} must be a 32-byte 0x-prefixed hex string`);
  }
  return value as `0x${string}`;
}

function hashType(
  value: unknown,
  path: string,
): "data" | "type" | "data1" | "data2" {
  if (
    value !== "data" &&
    value !== "type" &&
    value !== "data1" &&
    value !== "data2"
  ) {
    throw new Error(`${path} must be data, type, data1, or data2`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseScript(value: unknown, path: string) {
  const input = object(value, path);
  if (typeof input.args !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input.args)) {
    throw new Error(`${path}.args must be a 0x-prefixed hex string`);
  }
  return {
    codeHash: hex32(input.codeHash, `${path}.codeHash`),
    hashType: hashType(input.hashType, `${path}.hashType`),
    args: input.args as `0x${string}`,
  };
}

export function sporeScriptInfoFromSystemScripts(
  value: unknown,
): SporeScriptInfoLike {
  const root = object(value, "system scripts file");
  const devnet = object(root.devnet, "system scripts file.devnet");
  const spore = object(devnet.spore, "system scripts file.devnet.spore");
  const script = object(spore.script, "system scripts file.devnet.spore.script");
  const rawCellDeps = script.cellDeps;
  if (!Array.isArray(rawCellDeps) || rawCellDeps.length === 0) {
    throw new Error(
      "system scripts file.devnet.spore.script.cellDeps must be a non-empty array",
    );
  }

  const cellDeps = rawCellDeps.map((value, index) => {
    const path = `system scripts file.devnet.spore.script.cellDeps[${index}]`;
    const entry = object(value, path);
    const cellDep = object(entry.cellDep, `${path}.cellDep`);
    const outPoint = object(cellDep.outPoint, `${path}.cellDep.outPoint`);
    if (cellDep.depType !== "code" && cellDep.depType !== "depGroup") {
      throw new Error(`${path}.cellDep.depType must be code or depGroup`);
    }
    const parsed = {
      cellDep: {
        outPoint: {
          txHash: hex32(outPoint.txHash, `${path}.cellDep.outPoint.txHash`),
          index: nonNegativeSafeInteger(
            outPoint.index,
            `${path}.cellDep.outPoint.index`,
          ),
        },
        depType: cellDep.depType,
      },
    };
    if (entry.type === undefined || entry.type === null) return parsed;
    return { ...parsed, type: parseScript(entry.type, `${path}.type`) };
  });

  return {
    codeHash: hex32(
      script.codeHash,
      "system scripts file.devnet.spore.script.codeHash",
    ),
    hashType: hashType(
      script.hashType,
      "system scripts file.devnet.spore.script.hashType",
    ),
    cellDeps,
    // OffCKB's deployed Spore V2 binary uses cobuild semantics, while its raw
    // system-script export intentionally contains only on-chain deployment data.
    cobuild: true,
  };
}
