// report/4 (spec 0.2.0) offline verification, on real reports from the repository-script showcase. Every
// tamper recomputes both digests, so each rejection below comes from a semantic check, not a stale hash.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256 } from "../src/canonical";
import { deriveOutcomeV4, verdictForOutcomeV4 } from "../src/claims-v4";
import { inspectReport } from "../src/offline";
import { verifyReport } from "../src/report";
import { REPORT_SCHEMA_ID, schemaProblems } from "../src/schemas";

type Json = Record<string, any>;
const fixture = async (name: string): Promise<Json> => JSON.parse(await readFile(join(import.meta.dir, "fixtures/report-v4", `${name}.json`), "utf8"));
const names = ["committed", "rejected", "node-rejected", "zero"] as const;

/** Apply a change, then make the digests, outcome, and verdict self-consistent again where possible. */
function tampered(report: Json, change: (r: Json) => void, rederive = true): Json {
  const copy = structuredClone(report);
  change(copy);
  if (rederive) {
    try {
      copy.outcomeClaims = deriveOutcomeV4(copy.evidence, copy.environment);
      copy.verdict = verdictForOutcomeV4(copy.outcomeClaims as never);
    } catch { /* the derivation itself refuses the tamper */ }
  }
  copy.digests = { outcome: canonicalSha256(copy.outcomeClaims), environment: canonicalSha256(copy.environment) };
  return copy;
}

describe("report/4 real showcase reports", () => {
  for (const name of names) {
    test(`${name} verifies offline and matches the published schema`, async () => {
      const report = await fixture(name);
      expect(report.schema).toBe("ckb-verify-report/4");
      expect(() => verifyReport(report)).not.toThrow();
      expect(schemaProblems(REPORT_SCHEMA_ID, report)).toEqual([]);
      const inspection = inspectReport(report);
      expect(inspection.valid).toBe(true);
      expect(inspection.digests.recomputed).toEqual(report.digests);
    });
  }

  test("the outcome binds each deployed binary's hash and resolved code hash", async () => {
    const report = await fixture("committed");
    expect(report.outcomeClaims.setup.scripts.map((s: Json) => [s.name, s.kind, s.hashType])).toEqual([
      ["witness_lock", "binary", "type"], ["witness_lock_v1", "binary", "data1"], ["signer_lock", "builtin", "type"]]);
    const [typeScript, dataScript] = report.outcomeClaims.setup.scripts;
    expect(typeScript.binarySha256).toBe(dataScript.binarySha256);
    expect(dataScript.codeHash).toBe(dataScript.dataHash);
    expect(typeScript.codeHash).not.toBe(typeScript.dataHash);
    expect(report.outcomeClaims.steps.map((s: Json) => s.kind)).toEqual(["pure", "transaction", "transaction"]);
  });
});

describe("report/4 tamper rejection", () => {
  const refuses = async (name: (typeof names)[number], change: (r: Json) => void, message?: string, rederive = true) => {
    const report = tampered(await fixture(name), change, rederive);
    expect(() => verifyReport(report)).toThrow(message ?? "");
  };

  test("a different binary cannot reuse the evidence", async () => {
    // Offline there are no binary bytes to re-hash: a consistently rewritten binary hash yields a
    // self-consistent report, but a different outcome digest, so it never matches the original evidence.
    const original = await fixture("committed");
    const swapped = tampered(original, (r) => { r.environment.devnet.scripts[0].binarySha256 = `sha256:${"00".repeat(32)}`; });
    expect(() => verifyReport(swapped)).not.toThrow();
    expect(swapped.digests.outcome).not.toBe(original.digests.outcome);
    // Changing only the environment record, without re-deriving, is refused outright.
    await refuses("committed", (r) => { r.environment.devnet.scripts[0].binarySha256 = `sha256:${"00".repeat(32)}`; }, "outcomeClaims", false);
    await refuses("committed", (r) => { r.environment.devnet.scripts[1].dataHash = `0x${"11".repeat(32)}`; }, "deployment.dataHash");
    await refuses("committed", (r) => { r.environment.devnet.scripts[1].deployment.dataHash = `0x${"11".repeat(32)}`; }, "deployment.dataHash");
    await refuses("committed", (r) => { r.environment.devnet.scripts[0].codeHash = r.environment.devnet.scripts[0].dataHash; }, "codeHash");
    await refuses("committed", (r) => { r.environment.devnet.scripts[0].typeId.script.args = `0x${"22".repeat(32)}`; });
  });

  test("a changed script reference or setup declaration fails binding", async () => {
    await refuses("committed", (r) => { r.evidence.manifestText = r.evidence.manifestText.replace('hash_type = "data1"', 'hash_type = "data2"'); });
    await refuses("committed", (r) => { r.environment.devnet.scripts[2].codeHash = `0x${"33".repeat(32)}`; }, "alias");
    await refuses("committed", (r) => { r.environment.devnet.scripts.pop(); }, "records 2 scripts");
  });

  test("the error group, rejection script, and retained inputs bind each other", async () => {
    await refuses("rejected", (r) => { r.evidence.steps[1].expectedErrorGroup.script.args = "0x02"; }, "expectedErrorGroup");
    await refuses("rejected", (r) => { r.evidence.steps[1].rejection.script.args = "0x02"; });
    await refuses("rejected", (r) => { delete r.evidence.steps[1].inputCells; }, "inputCells");
    await refuses("rejected", (r) => { r.evidence.steps[1].inputCells[0].response.cell.output.lock.args = "0x02"; });
  });

  test("a rewritten verdict or outcome is caught even with fresh digests", async () => {
    await refuses("rejected", (r) => { r.verdict = "FAIL"; }, "verdict", false);
    await refuses("committed", (r) => { r.outcomeClaims.setup.accounts = 3; }, "outcomeClaims", false);
  });

  test("node rejections must carry a terminal RPC code", async () => {
    await refuses("node-rejected", (r) => { r.evidence.steps[2].rejection.rpcCode = -1106; }, "terminal node rejection code");
    await refuses("node-rejected", (r) => { r.evidence.steps[2].rejection.code = 42; });
  });

  test("pure steps carry no transaction", async () => {
    await refuses("committed", (r) => { r.evidence.steps[0].transactionHash = `0x${"44".repeat(32)}`; }, "transactionHash");
    await refuses("committed", (r) => { r.evidence.steps[0].kind = "transaction"; }, "kind");
  });

  test("genesis, sealing, and provenance are anchored to pinned values", async () => {
    await refuses("zero", (r) => { r.environment.devnet.genesisHash = `0x${"55".repeat(32)}`; }, "pinned default devnet genesis");
    await refuses("zero", (r) => { r.environment.devnet.sealing.files[0].sha256 = `sha256:${"66".repeat(32)}`; }, "sealing fingerprint");
    await refuses("zero", (r) => { r.environment.provenance.devnet.defaultSealingFingerprint = `sha256:${"77".repeat(32)}`; });
    await refuses("zero", (r) => { r.environment.provenance.replay.status = "tainted"; }, "replay status");
    await refuses("zero", (r) => { r.environment.provenance.repository.url = "https://user:token@github.com/x/y"; }, "sanitized");
  });

  test("account counts bind the manifest, including zero", async () => {
    await refuses("zero", (r) => { r.environment.devnet.accounts.push({ index: 0, address: "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqwgx292hnvmn68xf779vmzrshpmm6epn4c0cgwga", lock: { codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" } }); });
  });
});
