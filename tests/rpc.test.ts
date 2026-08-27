import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResultProtocolError,
  RpcError,
  type FetchLike,
  loadResultEnvelope,
  rpcCall,
  waitForTransaction,
} from "../src/rpc";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TRANSACTION = {
  version: "0x0",
  cell_deps: [],
  header_deps: [],
  inputs: [],
  outputs: [],
  outputs_data: [],
  witnesses: [],
};

describe("rpcCall", () => {
  test("returns a JSON-RPC result", async () => {
    const fakeFetch: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ jsonrpc: "2.0", method: "get_tip_header", params: [] });
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { number: "0x2" } });
    };

    await expect(rpcCall("http://127.0.0.1:8114", "get_tip_header", [], fakeFetch)).resolves.toEqual({ number: "0x2" });
  });

  test("preserves structured JSON-RPC errors", async () => {
    const fakeFetch: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -3, message: "TransactionFailedToVerify", data: "ValidationFailure -31" },
      });
    };

    try {
      await rpcCall("http://127.0.0.1:8114", "send_transaction", [TRANSACTION], fakeFetch);
      throw new Error("expected rpcCall to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ method: "send_transaction", code: -3, data: "ValidationFailure -31" });
    }
  });

  test("times out a transport that never settles", async () => {
    const never: FetchLike = async () => await new Promise<Response>(() => undefined);
    await expect(rpcCall("http://127.0.0.1:8114", "get_tip_header", [], never, 5)).rejects.toThrow(
      "get_tip_header timed out after 5ms",
    );
  });

  test("forwards an external abort to the transport before rejecting", async () => {
    const controller = new AbortController();
    let transportObservedAbort = false;
    const never: FetchLike = async (_input, init) =>
      await new Promise<Response>(() => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            transportObservedAbort = true;
          },
          { once: true },
        );
      });

    const pending = rpcCall("http://127.0.0.1:8114", "get_tip_header", [], never, 100, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("get_tip_header aborted");
    expect(transportObservedAbort).toBe(true);
  });
});

describe("waitForTransaction", () => {
  test("recognizes a terminal committed transaction", async () => {
    const statuses = ["pending", "proposed", "committed"];
    const call = async () => ({ tx_status: { status: statuses.shift() } });

    await expect(
      waitForTransaction("unused", "0xabc", { call, intervalMs: 0, timeoutMs: 100 }),
    ).resolves.toMatchObject({ status: "committed" });
  });

  test("recognizes terminal rejection and timeout", async () => {
    const rejectedCall = async () => ({ tx_status: { status: "rejected", reason: "bad witness" } });
    await expect(
      waitForTransaction("unused", "0xabc", { call: rejectedCall, intervalMs: 0, timeoutMs: 100 }),
    ).resolves.toEqual({ status: "rejected", reason: "bad witness" });

    const pendingCall = async () => ({ tx_status: { status: "pending" } });
    await expect(
      waitForTransaction("unused", "0xabc", { call: pendingCall, intervalMs: 1, timeoutMs: 3 }),
    ).rejects.toThrow("transaction 0xabc did not reach a terminal state");
  });

  test("enforces the overall deadline when an injected RPC call never settles", async () => {
    let transportObservedAbort = false;
    const never = async (_url: string, _method: string, _params: unknown[], signal?: AbortSignal) =>
      await new Promise<unknown>(() => {
        signal?.addEventListener(
          "abort",
          () => {
            transportObservedAbort = true;
          },
          { once: true },
        );
      });
    await expect(
      waitForTransaction("unused", "0xabc", { call: never, intervalMs: 0, timeoutMs: 5 }),
    ).rejects.toThrow("transaction 0xabc did not reach a terminal state after 5ms");
    expect(transportObservedAbort).toBe(true);
  });

  test("aborts an in-flight transaction wait when the run is interrupted", async () => {
    const controller = new AbortController();
    let transportObservedAbort = false;
    setTimeout(() => controller.abort(), 5);

    await expect(
      waitForTransaction("unused", "0xabc", {
        call: async (_url: string, _method: string, _params: unknown[], signal?: AbortSignal) =>
          await new Promise<never>(() => {
            signal?.addEventListener(
              "abort",
              () => {
                transportObservedAbort = true;
              },
              { once: true },
            );
          }),
        intervalMs: 0,
        timeoutMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow("transaction wait aborted");
    expect(transportObservedAbort).toBe(true);
  });
});

describe("loadResultEnvelope", () => {
  test("loads exactly one versioned signed transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-result-"));
    directories.push(directory);
    const path = join(directory, "result.json");
    await writeFile(path, JSON.stringify({ protocol: 1, transaction: TRANSACTION }));

    await expect(loadResultEnvelope(path)).resolves.toEqual({ protocol: 1, transaction: TRANSACTION });
  });

  test("rejects malformed envelopes and unknown transaction keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-result-"));
    directories.push(directory);
    const path = join(directory, "result.json");
    await writeFile(path, JSON.stringify({ protocol: 2, transaction: { ...TRANSACTION, hash: "0xabc" } }));

    await expect(loadResultEnvelope(path)).rejects.toBeInstanceOf(ResultProtocolError);
    await expect(loadResultEnvelope(path)).rejects.toThrow("protocol must equal 1");

    await writeFile(path, JSON.stringify({ protocol: 1, transaction: { ...TRANSACTION, hash: "0xabc" } }));
    await expect(loadResultEnvelope(path)).rejects.toThrow("transaction.hash is not supported");
  });
});
