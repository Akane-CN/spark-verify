// The frozen v0.1 contract (docs/version-policy.md#the-frozen-v01-contract): spec `0.1.0` is the draft.5
// grammar under its release identifier, written as report/3 + outcome/3 + environment/4 + provenance/3.
// "Frozen" is checked, not asserted: the parts of every published schema that the v0.1 tuple uses are
// pinned by RFC 8785 digest, a committed golden report must re-verify offline with locked digests, and the
// whole draft.5 conformance corpus must behave identically under `0.1.0`. A failure here means a change
// touched the frozen contract; the fix is a new identifier, never an edit of `lock.json`.
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256 } from "../src/canonical";
import { parseManifestText } from "../src/manifest";
import { verifyReport } from "../src/report";
import { MANIFEST_SCHEMA_ID, schemaProblems } from "../src/schemas";

const root = join(import.meta.dir, "..");
const frozen = join(root, "tests/fixtures/frozen-v0.1");
const conformance = join(root, "tests/fixtures/conformance/manifests");
type Json = Record<string, any>;
const json = async (path: string): Promise<Json> => JSON.parse(await readFile(join(root, path), "utf8"));
const lock = await json("tests/fixtures/frozen-v0.1/lock.json");

/** The parts of the published schemas the v0.1 tuple uses; branches for other tuples are excluded on purpose. */
export async function frozenSchemaParts(): Promise<Record<string, unknown>> {
  const manifest = await json("schemas/ckb-verify-manifest-v1.schema.json");
  const common = structuredClone(manifest.properties);
  delete common.meta.properties.spec; // the accepted-identifier list grows when a spec is added
  const v01 = (manifest.allOf as Json[]).filter((branch) => {
    const spec = branch.if?.properties?.meta?.properties?.spec;
    return spec?.const === "0.1.0" || (Array.isArray(spec?.enum) && spec.enum.includes("0.1.0"));
  });
  const report = await json("schemas/ckb-verify-report.schema.json");
  const report3 = (report.oneOf as Json[]).filter((branch) => branch.properties?.schema?.const === "ckb-verify-report/3");
  expect(v01).toHaveLength(1);
  expect(report3).toHaveLength(1);
  return {
    "manifest-v1 common properties": { properties: common, required: manifest.required, additionalProperties: manifest.additionalProperties },
    "manifest-v1 0.1.0 branch": v01[0],
    "report report/3 branch": { branch: report3[0], $defs: report.$defs },
    "claims-v3": await json("schemas/ckb-verify-claims-v3.schema.json"),
    "provenance-v3": await json("schemas/ckb-verify-provenance-v3.schema.json"),
  };
}

const withSpec = (text: string, spec: string): string => {
  const replaced = text.replace(/^spec = "0\.1\.0-draft\.5"$/m, `spec = "${spec}"`);
  expect(replaced).not.toBe(text);
  return replaced;
};
const parserMessage = (text: string): string => {
  try { parseManifestText(text, "fixture.toml"); } catch (error) { return (error as Error).message; }
  return "accepted";
};

describe("frozen v0.1 contract", () => {
  test("the lock names the frozen identifiers", () => {
    expect(lock.contract).toEqual({
      spec: "0.1.0", report: "ckb-verify-report/3", outcome: "ckb-verify-outcome/3",
      environment: "ckb-verify-environment/4", provenance: "ckb-verify-provenance/3",
      evidenceBundle: "ckb-verify-evidence-bundle/1", producerProtocol: 1,
    });
  });

  test("the v0.1 parts of every published schema are byte-for-byte what was frozen (RFC 8785 digests)", async () => {
    const parts = await frozenSchemaParts();
    const observed = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, canonicalSha256(part)]));
    expect(observed).toEqual(lock.schemas);
  });

  test("the golden 0.1.0 report re-verifies offline with its locked digests", async () => {
    const report = await json("tests/fixtures/frozen-v0.1/report.json");
    expect(report.schema).toBe("ckb-verify-report/3");
    expect(report.evidence.spec).toBe("0.1.0");
    expect(report.outcomeClaims.spec).toBe("0.1.0");
    expect(() => verifyReport(report)).not.toThrow();
    expect(report.digests).toEqual(lock.golden.digests);
    expect(canonicalSha256(report)).toBe(lock.golden.report);
  });

  test("evidence and outcome must name the same identifier", async () => {
    const report = await json("tests/fixtures/frozen-v0.1/report.json");
    report.outcomeClaims.spec = "0.1.0-draft.5";
    expect(() => verifyReport(report)).toThrow("unsupported report/3 version tuple");
  });

  test("every valid draft.5 fixture parses identically under 0.1.0, apart from the identifier", async () => {
    const twins = [["draft5-vocabulary.toml", "v0.1.0-vocabulary.toml"]] as const;
    for (const [draft, release] of twins) {
      const a = parseManifestText(await readFile(join(conformance, "valid", draft), "utf8"), draft);
      const b = parseManifestText(await readFile(join(conformance, "valid", release), "utf8"), release);
      expect(b.meta.spec).toBe("0.1.0");
      expect({ ...b, meta: { ...b.meta, spec: a.meta.spec, name: a.meta.name } }).toEqual(a);
    }
  });

  test("every draft.5 invalid fixture fails identically under 0.1.0, in the parser and the schema", async () => {
    const cases = [
      ...(await json("tests/fixtures/conformance/manifests/invalid/cases.json") as unknown as Array<{ file: string }>),
      ...(await json("tests/fixtures/conformance/manifests/invalid/semantic-cases.json") as unknown as Array<{ file: string }>),
    ].filter(({ file }) => file.startsWith("draft5-"));
    const onDisk = (await readdir(join(conformance, "invalid"))).filter((name) => name.startsWith("draft5-"));
    expect(cases.map(({ file }) => file).sort()).toEqual(onDisk.sort());
    for (const { file } of cases) {
      const text = await readFile(join(conformance, "invalid", file), "utf8");
      const release = withSpec(text, "0.1.0");
      expect(parserMessage(release), file).toBe(parserMessage(text));
      expect(parserMessage(release), file).not.toBe("accepted");
      expect(schemaProblems(MANIFEST_SCHEMA_ID, Bun.TOML.parse(release)), file)
        .toEqual(schemaProblems(MANIFEST_SCHEMA_ID, Bun.TOML.parse(text)));
    }
  });
});
