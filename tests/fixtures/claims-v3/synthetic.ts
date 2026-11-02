// Synthetic draft.5-grammar inputs (spec 0.1.0-draft.5 or the frozen 0.1.0) only: never devnet output or execution evidence.
import { ccc } from "@ckb-ccc/core";
import type { CkbJsonRpcTransaction } from "../../../src/rpc";
import type { OutputV4 } from "../../../src/cell-claims";
import type { ResolvedSystemScripts } from "../../../src/offckb";
import type { CkbVerifyReportV3 } from "../../../src/runner";
import type { EnvironmentEvidenceV4 } from "../../../src/report";
import type { V01Spec } from "../../../src/types";
import { canonicalSha256, sha256Bytes } from "../../../src/canonical";
import { deriveOutcomeV3, populateEvidenceV3, verdictForOutcomeV3, type IndexerInput, type RunInputV3 } from "../../../src/claims-v3";
import { transactionHash } from "../../../src/transaction";
import { hex32, liveResponse } from "../claims-v2/synthetic";

export const OWNER_ARGS = hex32("ee");
export const bindings3: ResolvedSystemScripts = {
  secp256k1_blake160_sighash_all: { codeHash: hex32("31"), hashType: "type", cellDeps: [{ outPoint: { txHash: hex32("41"), index: 0 }, depType: "depGroup" }] },
  xudt: { codeHash: hex32("13"), hashType: "type", cellDeps: [{ outPoint: { txHash: hex32("23"), index: 0 }, depType: "code" }] },
  dao: { codeHash: hex32("11"), hashType: "type", cellDeps: [{ outPoint: { txHash: hex32("21"), index: 0 }, depType: "code" }] },
};
const lockOf = (byte: string) => ({ codeHash: hex32("31"), hashType: "type" as const, args: `0x${byte.repeat(20)}` });
export const accounts3 = [0, 1].map((index) => {
  const lock = lockOf(index === 0 ? "a0" : "a1");
  return { index, address: ccc.Address.from({ script: lock, prefix: "ckt" }).toString(), lock };
});
export const UDT_AMOUNT = 1000n;
export const udtData = (amount: bigint): string => `0x${Buffer.from(amount.toString(16).padStart(32, "0"), "hex").reverse().toString("hex")}`;
const rpcScript = (lock: { codeHash: string; hashType: "data" | "type" | "data1" | "data2"; args: string }) => ({ code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args });

/** The synthetic manifest's name under each identifier; the grammar and claims are identical. */
export const syntheticName = (spec: V01Spec): string => spec === "0.1.0" ? "synthetic-v0.1" : "synthetic-draft5";

export function manifest5(extraFinal = "", spec: V01Spec = "0.1.0-draft.5"): string {
  return `[meta]\nname = "${syntheticName(spec)}"\nspec = "${spec}"\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\n[replay]\ndependencies = []\n[setup]\naccounts = 2\n` +
    `[[step]]\nname = "mint"\nrun = "inert-fake-adapter"\nexpect.tx = "committed"\nexpect.cycles = { gte = 1, lt = 1000 }\n` +
    `[[step.assert.cell]]\nout_point = { step = "mint", index = 0 }\nlock = { account = 0 }\ntype = { builtin = "xudt", args = "${OWNER_ARGS}" }\ndata = { len = 16 }\ncapacity = { gte = "142 CKB" }\n` +
    `[[assert.cell]]\nlock = { account = 0 }\ntype = { builtin = "xudt" }\ncount = { gte = 1, lte = 10 }\ndata = { min_bytes = 16 }\n` +
    `[[assert.cell_deps]]\nstep = "mint"\ncontains = { builtin = "xudt" }\n` +
    `[[assert.balance]]\naccount = 1\ngte = "99.5 CKB"\n` +
    `[[assert.balance]]\naccount = 0\nudt = { type = { builtin = "xudt", args = "${OWNER_ARGS}" } }\ngte = "1000"\n${extraFinal}`;
}

export function mintTransaction(): CkbJsonRpcTransaction & { outputs_data: string[] } {
  return {
    version: "0x0", header_deps: [], inputs: [], witnesses: ["0x"],
    cell_deps: [{ out_point: { tx_hash: hex32("23"), index: "0x0" }, dep_type: "code" }, { out_point: { tx_hash: hex32("41"), index: "0x0" }, dep_type: "dep_group" }],
    outputs: [{ capacity: "0x34e62ce00", lock: rpcScript(accounts3[0]!.lock), type: { code_hash: hex32("13"), hash_type: "type", args: OWNER_ARGS } }],
    outputs_data: [udtData(UDT_AMOUNT)],
  };
}

/** One indexer page of the given Cells, as the runner retains it. */
export function indexerInput(searchKey: IndexerInput["search_key"], objects: IndexerInput["pages"][number]["response"]["objects"]): IndexerInput {
  return { kind: "indexer", search_key: searchKey, pages: [{ after_cursor: null, response: { objects, last_cursor: "0x01" } }] };
}
export function indexerCell(tx: CkbJsonRpcTransaction & { outputs_data: string[] }, index: number, withData: boolean, txIndex = "0x1") {
  return { output: structuredClone(tx.outputs[index]) as OutputV4, output_data: withData ? tx.outputs_data[index]! : null,
    out_point: { tx_hash: transactionHash(tx), index: `0x${index.toString(16)}` }, block_number: "0x1", tx_index: txIndex };
}

export function environment4(text: string): EnvironmentEvidenceV4 {
  const sha = `sha256:${"1".repeat(64)}` as const;
  return {
    schema: "ckb-verify-environment/4", runner: { name: "ckb-verify", version: "0.0.2" },
    toolchain: { requested: { ckb: "0.209.0", offckb: "0.4.13" }, observed: { ckb: "0.209.0", offckb: "0.4.13" } },
    platform: { os: "linux", arch: "x64" },
    devnet: { network: "devnet", genesisHash: hex32("51"), systemScripts: structuredClone(bindings3), accounts: structuredClone(accounts3) },
    provenance: { schema: "ckb-verify-provenance/3", toolchain: { ckb: { requested: "0.209.0", observed: "0.209.0", driftAllowed: false } }, manifest: { sha256: sha256Bytes(Buffer.from(text)) },
      source: { gitCommit: "a".repeat(40), dirty: false, dirtyDigest: null }, lockfile: { path: "bun.lock", sha256: sha },
      replay: { declaredDependencies: [], status: "stable", reasons: [] },
      runtime: { name: "bun", requestedVersion: "1.2.19", observedVersion: "1.2.19", metadata: { path: "package.json", sha256: sha } },
      binaries: { ckbDebugger: null, ckb: { version: "0.209.0", platform: "linux", architecture: "x64", asset: "synthetic.tar.gz", sourceUrl: "https://example.invalid/synthetic.tar.gz",
        expectedArchiveSha256: sha, archiveSha256: sha, binarySha256: sha } } },
  };
}

/** The raw run input for the manifest above: one committed step with 100 cycles, every claim's retained query. */
export function syntheticInputV3(options: { cycles?: number; ckbBalanceCapacity?: string; udtData?: string; extraFinal?: string; spec?: V01Spec } = {}): { input: RunInputV3; environment: EnvironmentEvidenceV4 } {
  const spec = options.spec ?? "0.1.0-draft.5";
  const text = manifest5(options.extraFinal ?? "", spec);
  const tx = mintTransaction();
  if (options.udtData !== undefined) tx.outputs_data = [options.udtData];
  const hash = transactionHash(tx);
  const owner = { code_hash: hex32("13"), hash_type: "type" as const, args: OWNER_ARGS };
  const mintCell = indexerCell(tx, 0, true);
  const plainCell = { output: { capacity: options.ckbBalanceCapacity ?? "0x2540be400", lock: rpcScript(accounts3[1]!.lock), type: null } as OutputV4, output_data: null,
    out_point: { tx_hash: hex32("61"), index: "0x0" }, block_number: "0x1", tx_index: "0x0" };
  const step = { name: "mint", expectedStatus: "committed" as const, expectedCycles: { gte: 1, lt: 1000 }, observedStatus: "committed" as const, cycles: options.cycles ?? 100,
    transaction: tx, transactionHash: hash, durationMs: 1,
    claims: [{ kind: "cell" as const, target: { outPoint: { step: "mint", index: 0 }, lock: { kind: "account" as const, index: 0 }, type: { kind: "builtin" as const, name: "xudt" as const, args: OWNER_ARGS } },
      expected: { count: { gte: 1 }, data: { len: 16 }, capacity: { gte: "14200000000" } },
      input: { kind: "query" as const, outPoint: { tx_hash: hash, index: "0x0" }, response: liveResponse(tx) as import("../../../src/cell-claims").LiveCellResponse } }] };
  const assertions: RunInputV3["assertions"] = [
    { kind: "cell", target: { lock: { kind: "account", index: 0 }, type: { kind: "builtin", name: "xudt", args: null } }, expected: { count: { gte: 1, lte: 10 }, data: { minBytes: 16 } },
      input: indexerInput({ script: rpcScript(accounts3[0]!.lock), script_type: "lock", script_search_mode: "exact", filter: { script: { ...owner, args: "0x" } }, with_data: true }, [mintCell]) },
    { kind: "cell_deps", target: { step: "mint" }, expected: { contains: { kind: "builtin", name: "xudt" } } },
    { kind: "balance", target: { kind: "account", index: 1 }, expected: { amount: { gte: "9950000000" } },
      input: indexerInput({ script: rpcScript(accounts3[1]!.lock), script_type: "lock", script_search_mode: "exact", with_data: false }, [plainCell]) },
    { kind: "balance", target: { kind: "account", index: 0 }, expected: { udt: { type: { kind: "builtin", name: "xudt", args: OWNER_ARGS } }, amount: { gte: "1000" } },
      input: indexerInput({ script: rpcScript(accounts3[0]!.lock), script_type: "lock", script_search_mode: "exact", filter: { script: owner }, with_data: true }, [mintCell]) },
  ];
  return { input: { name: syntheticName(spec), spec, manifestText: text, steps: [step], assertions }, environment: environment4(text) };
}

export function syntheticReportV3(options: Parameters<typeof syntheticInputV3>[0] = {}): CkbVerifyReportV3 {
  const { input, environment } = syntheticInputV3(options);
  const outcomeClaims = deriveOutcomeV3(input, environment);
  return structuredClone({ schema: "ckb-verify-report/3", verdict: verdictForOutcomeV3(outcomeClaims), createdAt: "synthetic-not-executed",
    evidence: populateEvidenceV3(input, outcomeClaims), outcomeClaims, environment,
    digests: { outcome: canonicalSha256(outcomeClaims), environment: canonicalSha256(environment) } });
}
