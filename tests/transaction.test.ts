import { describe, expect, test } from "bun:test";
import { RpcError } from "../src/rpc";
import {
  normalizeScript,
  parseDebuggerResult,
  parseRejection,
  parseRpcCycles,
  scriptHash,
  transactionHash,
} from "../src/transaction";

const HASH = `0x${"11".repeat(32)}`;

describe("transaction evidence", () => {
  test("normalizes a CKB script rejection", () => {
    const error = new RpcError(
      "send_transaction",
      -302,
      "TransactionFailedToVerify: Verification failed Script(TransactionScriptError { source: Inputs[0].Lock, cause: ValidationFailure: see error code -11 on page https://example.invalid/#-11 })",
      null,
    );

    expect(parseRejection(error)).toEqual({
      kind: "script",
      rpcCode: -302,
      code: -11,
      source: { cell: "input", index: 0 },
      role: "lock",
    });
  });

  test("keeps non-script node rejection separate", () => {
    const error = new RpcError("send_transaction", -301, "PoolRejectedDuplicatedTransaction", null);

    expect(parseRejection(error)).toEqual({ kind: "node", rpcCode: -301 });
  });

  test("parses the rejected debugger result and cycles despite a nonzero exit", () => {
    expect(parseDebuggerResult("Run result: -11\nAll cycles: 393345(384.1K)\n")).toEqual({ result: -11, cycles: 393345 });
    expect(() => parseDebuggerResult("Command failed")).toThrow("result and cycle count");
  });

  test("parses hexadecimal dry-run cycles without loss", () => {
    expect(parseRpcCycles({ cycles: "0x189997", fee: "0x1d0" })).toEqual({ cycles: 1_612_183, fee: 464 });
  });

  test("normalizes and hashes the actual rejected script group", () => {
    const script = normalizeScript({
      code_hash: `0x${"12".repeat(32)}`,
      hash_type: "type",
      args: "0x34",
    });

    expect(script).toEqual({ codeHash: `0x${"12".repeat(32)}`, hashType: "type", args: "0x34" });
    expect(scriptHash(script)).toBe("0x1e9d962c4362619ef288c09221fd609f82cce8bfe2f278c769e5809802c5fca8");
  });

  test("computes the raw transaction hash independent of witnesses", () => {
    const transaction = {
      version: "0x0",
      cell_deps: [],
      header_deps: [],
      inputs: [],
      outputs: [],
      outputs_data: [],
      witnesses: ["0x"],
    };
    const changedWitness = { ...transaction, witnesses: [`0x${"ff".repeat(65)}`] };

    expect(transactionHash(transaction)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(transactionHash(changedWitness)).toBe(transactionHash(transaction));
    expect(transactionHash(transaction)).not.toBe(HASH);
  });
});
