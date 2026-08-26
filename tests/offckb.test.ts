import { describe, expect, test } from "bun:test";
import {
  OffckbProtocolError,
  createOffckbPaths,
  normalizeSystemScripts,
  parseAccountsResult,
  parseOffckbResult,
} from "../src/offckb";

const KEY = `0x${"11".repeat(32)}`;
const HASH = `0x${"22".repeat(32)}`;

describe("OffCKB protocol parsing", () => {
  test("selects the machine result line instead of human logs", () => {
    const stdout = [
      JSON.stringify({ level: "info", message: "ready" }),
      JSON.stringify({ ok: true, command: "node", rpcUrl: "http://127.0.0.1:8114", proxyUrl: "http://127.0.0.1:28114" }),
      "",
    ].join("\n");

    expect(parseOffckbResult(stdout, "node")).toMatchObject({ ok: true, command: "node" });
  });

  test("fails closed when the expected command result is missing", () => {
    expect(() => parseOffckbResult('{"ok":true,"command":"accounts"}\n', "node")).toThrow(OffckbProtocolError);
  });

  test("requires private development keys and returns only requested accounts", () => {
    const result = {
      ok: true,
      command: "accounts",
      accounts: [0, 1].map((index) => ({
        index,
        address: `ckt1-account-${index}`,
        privkey: KEY,
        lockScript: { codeHash: HASH, hashType: "type", args: `0x${String(index).padStart(40, "0")}` },
      })),
    };

    expect(parseAccountsResult(result, 1)).toEqual([
      {
        index: 0,
        address: "ckt1-account-0",
        privkey: KEY,
        lock: { codeHash: HASH, hashType: "type", args: `0x${"0".repeat(40)}` },
      },
    ]);
    expect(() => parseAccountsResult({ ...result, accounts: [{ ...result.accounts[0], privkey: undefined }] }, 1)).toThrow(
      "accounts[0].privkey",
    );
  });

  test("normalizes the observed OffCKB system-script export", () => {
    const raw = {
      devnet: {
        secp256k1_blake160_sighash_all: {
          name: "secp256k1_blake160_sighash_all",
          file: "Bundled(specs/cells/secp256k1_blake160_sighash_all)",
          script: {
            codeHash: HASH,
            hashType: "type",
            cellDeps: [
              {
                cellDep: {
                  outPoint: { txHash: `0x${"33".repeat(32)}`, index: 0 },
                  depType: "depGroup",
                },
              },
            ],
          },
        },
      },
      testnet: {},
      mainnet: {},
    };

    expect(normalizeSystemScripts(raw)).toEqual({
      secp256k1_blake160_sighash_all: {
        codeHash: HASH,
        hashType: "type",
        cellDeps: [
          {
            outPoint: { txHash: `0x${"33".repeat(32)}`, index: 0 },
            depType: "depGroup",
          },
        ],
      },
    });
  });
});

describe("OffCKB runtime paths", () => {
  test("keeps fresh chain state under the repository runtime directory", () => {
    expect(createOffckbPaths("/work/project", "/work/project/node_modules/.bin/offckb")).toEqual({
      root: "/work/project/.ckb-verify/offckb",
      configHome: "/work/project/.ckb-verify/offckb/config",
      dataHome: "/work/project/.ckb-verify/offckb/data",
      cacheHome: "/work/project/.ckb-verify/offckb/cache",
      stateHome: "/work/project/.ckb-verify/offckb/state",
      systemScriptsPath: "/work/project/.ckb-verify/offckb/system-scripts.json",
      accountsPath: "/work/project/.ckb-verify/offckb/accounts.json",
      contextPath: "/work/project/.ckb-verify/offckb/context.json",
      transactionsPath: "/work/project/.ckb-verify/offckb/data/offckb-nodejs/devnet/transactions",
      fullTransactionsPath: "/work/project/.ckb-verify/offckb/data/offckb-nodejs/devnet/full-transactions",
      debuggerPath: "/work/project/.ckb-verify/offckb/data/offckb-nodejs/tools/ckb-debugger",
      offckbBinary: "/work/project/node_modules/.bin/offckb",
    });
  });
});
