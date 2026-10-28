// Synthetic semantic inputs only: never devnet output or execution evidence.
import { hashCkb } from "@ckb-ccc/core";
import type { CkbJsonRpcTransaction } from "../../../src/rpc";
import type { ResolvedSystemScripts } from "../../../src/offckb";

import type { CkbVerifyReportV2 } from "../../../src/runner";
import { canonicalSha256, sha256Bytes } from "../../../src/canonical";
import { transactionHash } from "../../../src/transaction";

export function syntheticReportV2(): CkbVerifyReportV2 {
  const text = manifest4('type = { builtin = "dao", args_bytes = 0 }\ndata = { min_bytes = 1 }') +
    '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }\n' +
    '\n[[step]]\nname = "unreferenced"\nrun = "inert-fake-adapter"\n' +
    '\n[[step]]\nname = "also-unreferenced"\nrun = "inert-fake-adapter"\n' +
    '\n[[assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 1\ntype = { builtin = "dao", args_bytes = 0 }\ndata = { min_bytes = 1 }\n' +
    '\n[[assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }\n';
  const tx = syntheticTransaction(); tx.outputs_data = ["0xabcd"];
  tx.cell_deps = bindings.dao!.cellDeps.map(d => ({ out_point: { tx_hash: d.outPoint.txHash, index: `0x${d.outPoint.index.toString(16)}` }, dep_type: d.depType === "code" ? "code" : "dep_group" }));
  const hash = transactionHash(tx);
  // Independently literal observations, not produced by deriveOutcomeV2.
  const cell = { kind: "cell" as const, target: { step: "produce", index: 0 }, expected: { count: 1 as const,
    type: { kind: "builtin" as const, name: "dao" as const, argsBytes: 0 }, data: { minBytes: 1 } },
    observed: { state: "live" as const, count: 1 as const, type: { identity: { kind: "builtin" as const, name: "dao" as const }, argsBytes: 0 }, dataBytes: 2 }, observationValid: true, ok: true };
  const dep = { kind: "cell_deps" as const, target: { step: "produce" }, expected: { contains: { kind: "builtin" as const, name: "dao" as const } }, observed: { present: [true, true] }, observationValid: true as const, ok: true };
  const input = { kind: "query" as const, outPoint: { tx_hash: hash, index: "0x0" }, response: liveResponse(tx) as import("../../../src/cell-claims").LiveCellResponse };
  const step = { name: "produce", expectedStatus: "committed" as const, observedStatus: "committed" as const, cycles: 100 };
  const unclaimed = ["unreferenced", "also-unreferenced"].map(name => ({ name, observedStatus: "committed" as const, cycles: 100, claims: [] }));
  const evidence = { name: "synthetic-cell-claims", spec: "0.1.0-draft.4" as const, manifestText: text,
    steps: [{ ...step, transaction: tx, transactionHash: hash, durationMs: 1, claims: [{ ...cell, input }, dep] },
      ...unclaimed.map(s => ({ ...s, transaction: structuredClone(tx), transactionHash: hash, durationMs: 1 }))],
    assertions: structuredClone([{ ...cell, input }, dep]) };
  const outcomeClaims = { schema: "ckb-verify-outcome/2" as const, name: evidence.name, spec: evidence.spec,
    steps: [{ ...step, claims: [cell, dep] }, ...unclaimed], assertions: structuredClone([cell, dep]) };
  const sha = `sha256:${"1".repeat(64)}` as const;
  const environment: import("../../../src/report").EnvironmentEvidence = {
    schema: "ckb-verify-environment/3", runner: { name: "ckb-verify", version: "0.0.2" },
    toolchain: { requested: { ckb: "0.209.0", offckb: "0.4.13" }, observed: { ckb: "0.209.0", offckb: "0.4.13" } },
    platform: { os: "linux", arch: "x64" }, devnet: { network: "devnet", genesisHash: hex32("51"), systemScripts: structuredClone(bindings) },
    provenance: { schema: "ckb-verify-provenance/2", manifest: { sha256: sha256Bytes(Buffer.from(text)) },
      source: { gitCommit: "a".repeat(40), dirty: false, dirtyDigest: null }, lockfile: { path: "bun.lock", sha256: sha },
      replay: { declaredDependencies: [], status: "stable", reasons: [] },
      runtime: { name: "bun", requestedVersion: "1.2.19", observedVersion: "1.2.19", metadata: { path: "package.json", sha256: sha } },
      binaries: { ckbDebugger: null, ckb: { version: "0.209.0", platform: "linux", architecture: "x64", asset: "synthetic.tar.gz", sourceUrl: "https://example.invalid/synthetic.tar.gz",
        expectedArchiveSha256: sha, archiveSha256: sha, binarySha256: sha } } },
  };
  return structuredClone({ schema: "ckb-verify-report/2", verdict: "PASS", createdAt: "synthetic-not-executed", evidence, outcomeClaims, environment,
    digests: { outcome: canonicalSha256(outcomeClaims), environment: canonicalSha256(environment) } });
}

export const hex32 = (byte: string): string => `0x${byte.repeat(32)}`;
export const bindings: ResolvedSystemScripts = {
  dao: { codeHash: hex32("11"), hashType: "type", cellDeps: [
    { outPoint: { txHash: hex32("21"), index: 0 }, depType: "code" },
    { outPoint: { txHash: hex32("22"), index: 1 }, depType: "depGroup" },
  ] },
  spore: { codeHash: hex32("12"), hashType: "data1", cellDeps: [
    { outPoint: { txHash: hex32("23"), index: 0 }, depType: "code" },
  ] },
};
export function syntheticTransaction(typed = true): CkbJsonRpcTransaction {
  return {
    version: "0x0", cell_deps: [], header_deps: [], inputs: [],
    outputs: [{ capacity: "0x174876e800", lock: { code_hash: hex32("31"), hash_type: "type", args: "0x1234" },
      type: typed ? { code_hash: bindings.dao!.codeHash, hash_type: "type", args: "0x" } : null }],
    outputs_data: ["0x"], witnesses: ["0x"],
  };
}
export function liveResponse(tx: CkbJsonRpcTransaction, index = 0) {
  const content = tx.outputs_data[index];
  if (typeof content !== "string") throw new Error("synthetic data must be bytes");
  return { status: "live", cell: { output: structuredClone(tx.outputs[index]),
    data: { content, hash: content === "0x" ? hex32("00") : hashCkb(Buffer.from(content.slice(2), "hex")) } }, block_hash: null };
}
export function manifest4(assertions = 'type = { builtin = "dao", args_bytes = 0 }'): string {
  return `[meta]\nname = "synthetic-cell-claims"\nspec = "0.1.0-draft.4"\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\n[replay]\ndependencies = []\n[setup]\naccounts = 2\n[[step]]\nname = "produce"\nrun = "inert-fake-adapter"\nexpect.tx = "committed"\n[[step.assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 1\n${assertions}\n`;
}
