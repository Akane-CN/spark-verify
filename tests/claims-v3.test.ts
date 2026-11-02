import { describe, expect, test } from "bun:test";
import { canonicalSha256 } from "../src/canonical";
import { cyclesSatisfy, deriveOutcomeV3, validateIndexerInput, verdictForOutcomeV3, type BalanceOutcomeV3, type CellOutcomeV3, type IndexerInput } from "../src/claims-v3";
import { inspectReport } from "../src/offline";
import { verifyReport } from "../src/report";
import { REPORT_SCHEMA_ID, schemaProblems } from "../src/schemas";
import { accounts3, indexerCell, indexerInput, mintTransaction, syntheticInputV3, syntheticReportV3, udtData, UDT_AMOUNT } from "./fixtures/claims-v3/synthetic";
import { hex32 } from "./fixtures/claims-v2/synthetic";

const rpcScript = (lock: { codeHash: string; hashType: "data" | "type" | "data1" | "data2"; args: string }) => ({ code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args });

describe("draft.5 derivation", () => {
  test("the synthetic report derives PASS, verifies, satisfies the published schema, and inspects offline", () => {
    const report = syntheticReportV3();
    expect(report.verdict).toBe("PASS");
    expect(() => verifyReport(report)).not.toThrow();
    expect(schemaProblems(REPORT_SCHEMA_ID, report)).toEqual([]);
    const step = report.outcomeClaims.steps[0]!;
    expect(step.expectedCycles).toEqual({ gte: 1, lt: 1000 });
    expect(step.cycles).toBe(100);
    const outPointClaim = step.claims[0] as CellOutcomeV3;
    expect(outPointClaim.observed).toMatchObject({ state: "selected", count: 1 });
    expect((outPointClaim.observed as { cells: Array<{ capacity: string; dataBytes: number }> }).cells[0]).toMatchObject({ capacity: "14200000000", dataBytes: 16 });
    const [filtered, deps, ckb, udt] = report.outcomeClaims.assertions as [CellOutcomeV3, unknown, BalanceOutcomeV3, BalanceOutcomeV3];
    expect(filtered.observed).toMatchObject({ state: "selected", count: 1 });
    expect(deps).toMatchObject({ kind: "cell_deps", observed: { present: [true] }, ok: true });
    expect(ckb.observed).toEqual({ cells: 1, total: "10000000000", malformed: [] });
    expect(udt.observed).toEqual({ cells: 1, total: UDT_AMOUNT.toString(), malformed: [] });
    const inspection = inspectReport(report);
    expect(inspection.valid).toBe(true);
    expect(inspection.schema).toBe("ckb-verify-report/3");
    expect(inspection.spec).toBe("0.1.0-draft.5");
    expect(inspection.digests.recomputed).toEqual(report.digests);
  });

  test("cycles comparators decide the verdict; missing cycles never satisfy a comparator", () => {
    expect(syntheticReportV3({ cycles: 999 }).verdict).toBe("PASS");
    expect(syntheticReportV3({ cycles: 1000 }).verdict).toBe("FAIL");
    expect(syntheticReportV3({ cycles: 0 }).verdict).toBe("FAIL");
    expect(cyclesSatisfy({ eq: 5 }, 5)).toBe(true);
    expect(cyclesSatisfy({ eq: 5 }, 6)).toBe(false);
    expect(cyclesSatisfy({ lte: 5, gte: 5 }, 5)).toBe(true);
    expect(cyclesSatisfy({ lt: 5 }, undefined)).toBe(false);
  });

  test("balance totals and UDT decoding: aggregate semantics, malformed data invalidates the observation", () => {
    expect(syntheticReportV3({ ckbBalanceCapacity: "0x250e2cc00" }).verdict).toBe("FAIL"); // 99.4 CKB < 99.5 CKB
    const short = syntheticReportV3({ udtData: "0x0102" });
    const udt = short.outcomeClaims.assertions[3] as BalanceOutcomeV3;
    expect(udt.observed).toMatchObject({ cells: 1, total: null, malformed: [{ index: 0 }] });
    expect(udt.observationValid).toBe(false);
    expect(udt.ok).toBe(false);
    expect(short.verdict).toBe("FAIL");
    const exact = syntheticReportV3({ udtData: udtData(999n) });
    expect((exact.outcomeClaims.assertions[3] as BalanceOutcomeV3).observed.total).toBe("999");
    expect(exact.verdict).toBe("FAIL");
    expect(() => verifyReport(short)).not.toThrow(); // a valid FAIL report
  });

  test("count comparators and wildcard filters select by prefix; extra server objects outside the selector are ignored", () => {
    const { input, environment } = syntheticInputV3();
    const tx = mintTransaction();
    const other = indexerCell(tx, 0, true, "0x2");
    other.output.type = { code_hash: hex32("13"), hash_type: "type", args: `0x${"99".repeat(32)}` };
    other.out_point = { tx_hash: hex32("62"), index: "0x0" };
    const filtered = input.assertions[0] as Extract<typeof input.assertions[number], { kind: "cell" }>;
    filtered.input = indexerInput((filtered.input as IndexerInput).search_key, [indexerCell(tx, 0, true), other]);
    const outcome = deriveOutcomeV3(input, environment);
    expect((outcome.assertions[0] as CellOutcomeV3).observed).toMatchObject({ state: "selected", count: 2 });
    expect(verdictForOutcomeV3(outcome)).toBe("PASS");
    // The same two objects on the exact-args UDT query would contradict its filter and be refused as input.
    const udt = input.assertions[3] as Extract<typeof input.assertions[number], { kind: "balance" }>;
    udt.input = indexerInput(udt.input.search_key, [indexerCell(tx, 0, true), other]);
    expect(() => deriveOutcomeV3(input, environment)).toThrow("does not match the filter");
  });

  test.each([
    ["a forged search key", (r: ReturnType<typeof syntheticReportV3>) => { (r.evidence.assertions[2] as { input: { search_key: { script_search_mode: string } } }).input.search_key.script_search_mode = "prefix"; }, "search_key"],
    ["a broken page chain", (r: ReturnType<typeof syntheticReportV3>) => { const a = r.evidence.assertions[2] as { input: { pages: unknown[] } }; a.input.pages.push({ after_cursor: "0x99", response: { objects: [], last_cursor: "0x" } }); }, "non-final page"],
    ["a duplicate out_point across pages", (r: ReturnType<typeof syntheticReportV3>) => { const a = r.evidence.assertions[2] as { input: { pages: Array<{ response: { objects: unknown[] } }> } }; a.input.pages[0]!.response.objects.push(structuredClone(a.input.pages[0]!.response.objects[0])); }, "duplicate out_point"],
    ["an object outside the search key", (r: ReturnType<typeof syntheticReportV3>) => { const a = r.evidence.assertions[2] as { input: { pages: Array<{ response: { objects: Array<{ output: { lock: { args: string } } }> } }> } }; a.input.pages[0]!.response.objects[0]!.output.lock.args = "0x00"; }, "does not match the search key"],
    ["a stored total that contradicts the pages", (r: ReturnType<typeof syntheticReportV3>) => { (r.evidence.assertions[2] as { observed: { total: string } }).observed.total = "1"; }, "stored derivation"],
    ["a flipped ok on a FAIL claim", (r: ReturnType<typeof syntheticReportV3>) => { (r.outcomeClaims.assertions[2] as { ok: boolean }).ok = false; }, "outcomeClaims"],
    ["an account whose address contradicts its lock", (r: ReturnType<typeof syntheticReportV3>) => { r.environment.devnet.accounts[0]!.lock.args = "0x00"; }, "accounts[0].address"],
    ["a missing exported account", (r: ReturnType<typeof syntheticReportV3>) => { r.environment.devnet.accounts.pop(); }, "accounts[1]"],
    ["a report/3 that claims environment/3", (r: ReturnType<typeof syntheticReportV3>) => { (r.environment as { schema: string }).schema = "ckb-verify-environment/3"; }, "version tuple"],
    ["an expectedCycles field the manifest did not declare", (r: ReturnType<typeof syntheticReportV3>) => { delete (r.evidence.steps[0] as { expectedCycles?: unknown }).expectedCycles; }, "presence mismatch"],
  ])("rejects %s even after rehashing", (_label, damage, message) => {
    const report = syntheticReportV3();
    damage(report);
    report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
    expect(() => verifyReport(report)).toThrow(message);
    expect(inspectReport(report).valid).toBe(false);
  });

  test("indexer input validation enforces page shape, size, and limits", () => {
    const tx = mintTransaction();
    const key = { script: rpcScript(accounts3[0]!.lock), script_type: "lock" as const, script_search_mode: "exact" as const, with_data: false };
    expect(() => validateIndexerInput({ kind: "indexer", search_key: key, pages: [] }, "i")).toThrow("at least one page");
    expect(() => validateIndexerInput({ kind: "indexer", search_key: key, pages: [{ after_cursor: "0x1", response: { objects: [], last_cursor: "0x" } }] }, "i")).toThrow("continue the previous page");
    const full = Array.from({ length: 100 }, (_, i) => ({ ...indexerCell(tx, 0, false), out_point: { tx_hash: hex32((16 + i).toString(16).padStart(2, "0")), index: "0x0" } }));
    expect(() => validateIndexerInput({ kind: "indexer", search_key: key, pages: [{ after_cursor: null, response: { objects: full, last_cursor: "0x1" } }] }, "i")).toThrow("fewer than 100");
    expect(() => validateIndexerInput({ kind: "indexer", search_key: key, pages: [{ after_cursor: null, response: { objects: full, last_cursor: "0x1" } }, { after_cursor: "0x1", response: { objects: [], last_cursor: "0x2" } }] }, "i")).not.toThrow();
    expect(() => validateIndexerInput({ kind: "indexer", search_key: key, pages: [{ after_cursor: null, response: { objects: [indexerCell(tx, 0, true)], last_cursor: "0x1" } }] }, "i")).toThrow("must be null without with_data");
  });
});
