import { cccA } from "@ckb-ccc/core/advanced";
import { RpcError, type CkbJsonRpcTransaction } from "./rpc";

export interface ParsedRejection {
  kind: "script" | "node";
  rpcCode: number;
  code?: number;
  role?: "lock" | "type";
  source?: { cell: "input" | "output"; index: number };
}

export interface DebuggerResult {
  result: number;
  cycles: number;
}

function nonNegativeHexInteger(value: unknown, path: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/.test(value)) throw new Error(`${path} must be a hex integer`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${path} exceeds the safe integer range`);
  return Number(parsed);
}

export function parseRpcCycles(value: unknown): { cycles: number; fee: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("test_tx_pool_accept result must be an object");
  }
  const result = value as Record<string, unknown>;
  return {
    cycles: nonNegativeHexInteger(result.cycles, "test_tx_pool_accept.cycles"),
    fee: nonNegativeHexInteger(result.fee, "test_tx_pool_accept.fee"),
  };
}

export function parseRejection(error: RpcError): ParsedRejection {
  const source = /source:\s*(Inputs|Outputs)\[(\d+)]\.(Lock|Type)/.exec(error.message);
  const code = /error code\s+(-?\d+)/.exec(error.message);
  if (source === null || code === null) return { kind: "node", rpcCode: error.code };
  return {
    kind: "script",
    rpcCode: error.code,
    code: Number(code[1]),
    source: {
      cell: source[1] === "Inputs" ? "input" : "output",
      index: Number(source[2]),
    },
    role: source[3] === "Lock" ? "lock" : "type",
  };
}

export function parseDebuggerResult(output: string): DebuggerResult {
  const result = /(?:^|\n)Run result:\s*(-?\d+)/.exec(output);
  const cycles = /(?:^|\n)All cycles:\s*(\d+)/.exec(output);
  if (result === null || cycles === null) throw new Error("ckb-debugger output is missing its result and cycle count");
  const parsedCycles = Number(cycles[1]);
  if (!Number.isSafeInteger(parsedCycles)) throw new Error("ckb-debugger cycle count exceeds the safe integer range");
  return { result: Number(result[1]), cycles: parsedCycles };
}

export interface NormalizedScript {
  codeHash: string;
  hashType: string;
  args: string;
}

export function normalizeScript(script: unknown): NormalizedScript {
  if (typeof script !== "object" || script === null || Array.isArray(script)) {
    throw new Error("expected a CKB JSON-RPC script object");
  }
  const value = script as Record<string, unknown>;
  if (
    typeof value.code_hash !== "string" ||
    typeof value.hash_type !== "string" ||
    typeof value.args !== "string"
  ) {
    throw new Error("invalid CKB JSON-RPC script object");
  }
  return { codeHash: value.code_hash, hashType: value.hash_type, args: value.args };
}

export function scriptHash(script: NormalizedScript): string {
  return cccA.JsonRpcTransformers.scriptTo({
    code_hash: script.codeHash,
    hash_type: script.hashType,
    args: script.args,
  } as Parameters<typeof cccA.JsonRpcTransformers.scriptTo>[0]).hash();
}

export function transactionHash(transaction: CkbJsonRpcTransaction): string {
  const parsed = cccA.JsonRpcTransformers.transactionTo(transaction as never);
  return parsed.hash() as string;
}
