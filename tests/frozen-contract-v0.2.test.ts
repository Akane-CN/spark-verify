// The frozen spec 0.2.0 contract (docs/version-policy.md#the-frozen-020-contract): report/4 + outcome/4 +
// environment/5 + provenance/4. Checked like 0.1.0: the schema parts this tuple uses are pinned by RFC 8785
// digest, a committed real report re-verifies offline with locked digests, and the pinned default devnet
// identity the verifier accepts is locked. A failure means a change touched the contract; the fix is a new
// identifier, never an edit of lock.json.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256 } from "../src/canonical";
import { DEFAULT_DEVNET } from "../src/devnet-identity";
import { verifyReport } from "../src/report";

const root = join(import.meta.dir, "..");
type Json = Record<string, any>;
const json = async (path: string): Promise<Json> => JSON.parse(await readFile(join(root, path), "utf8"));
const lock = await json("tests/fixtures/frozen-v0.2/lock.json");

export async function frozenSchemaPartsV02(): Promise<Record<string, unknown>> {
  const report = await json("schemas/ckb-verify-report.schema.json");
  const report4 = (report.oneOf as Json[]).filter((branch) => branch.properties?.schema?.const === "ckb-verify-report/4");
  expect(report4).toHaveLength(1);
  return {
    "manifest-v2": await json("schemas/ckb-verify-manifest-v2.schema.json"),
    "claims-v4": await json("schemas/ckb-verify-claims-v4.schema.json"),
    "provenance-v4": await json("schemas/ckb-verify-provenance-v4.schema.json"),
    "report report/4 branch": report4[0],
  };
}

describe("frozen 0.2.0 contract", () => {
  test("the lock names the frozen identifiers", () => {
    expect(lock.contract).toEqual({
      spec: "0.2.0", report: "ckb-verify-report/4", outcome: "ckb-verify-outcome/4",
      environment: "ckb-verify-environment/5", provenance: "ckb-verify-provenance/4",
      evidenceBundle: "ckb-verify-evidence-bundle/1", producerProtocol: 1,
    });
  });

  test("the 0.2.0 schema parts are byte-for-byte what was frozen", async () => {
    const parts = await frozenSchemaPartsV02();
    expect(Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, canonicalSha256(part)]))).toEqual(lock.schemas);
  });

  test("the golden real report re-verifies offline with its locked digests", async () => {
    const report = await json(lock.golden.path);
    expect(report.schema).toBe("ckb-verify-report/4");
    expect(() => verifyReport(report)).not.toThrow();
    expect(report.digests).toEqual(lock.golden.digests);
    expect(canonicalSha256(report)).toBe(lock.golden.report);
  });

  test("the pinned default devnet identity is locked", () => {
    expect(DEFAULT_DEVNET).toEqual(lock.defaultDevnet);
  });
});
