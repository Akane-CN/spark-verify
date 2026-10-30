import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256 } from "../src/canonical";
import { inspectReport, validateManifestFile } from "../src/offline";
import { parseManifestText } from "../src/manifest";
import { MANIFEST_SCHEMA_ID, REPORT_SCHEMA_ID, SCHEMA_FILES, schemaProblems } from "../src/schemas";
import { syntheticReportV2 } from "./fixtures/claims-v2/synthetic";

const root = join(import.meta.dir, "..");
const fixtures = join(root, "tests/fixtures/conformance/manifests");
const invalidCases = JSON.parse(await readFile(join(fixtures, "invalid/cases.json"), "utf8")) as Array<{ file: string; parser: string; schema: string }>;
const semanticCases = JSON.parse(await readFile(join(fixtures, "invalid/semantic-cases.json"), "utf8")) as Array<{ file: string; parser: string }>;

describe("published schemas", () => {
  test("every schema file declares the $id the registry expects and compiles under strict Ajv", () => {
    for (const id of Object.keys(SCHEMA_FILES)) expect(schemaProblems(id, {})).not.toEqual([]); // compiled and rejecting an empty object
  });

  test("every showcase manifest and every valid fixture satisfies the manifest schema and the parser", async () => {
    const files: string[] = [];
    for await (const rel of new Bun.Glob("showcases/*/verify.*.toml").scan({ cwd: root })) files.push(join(root, rel));
    for (const name of await readdir(join(fixtures, "valid"))) files.push(join(fixtures, "valid", name));
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(schemaProblems(MANIFEST_SCHEMA_ID, Bun.TOML.parse(text)), file).toEqual([]);
      expect(() => parseManifestText(text, file)).not.toThrow();
      const validation = await validateManifestFile(file);
      expect(validation.ok, file).toBe(true);
    }
  });

  test.each(invalidCases)(
    "invalid fixture %p is rejected by the parser and the schema with a field path", async ({ file, parser, schema }) => {
      const path = join(fixtures, "invalid", file);
      const text = await readFile(path, "utf8");
      expect(() => parseManifestText(text, path)).toThrow(parser);
      const problems = schemaProblems(MANIFEST_SCHEMA_ID, Bun.TOML.parse(text));
      expect(problems.some((problem) => problem.startsWith(schema)), `${file}: ${JSON.stringify(problems)}`).toBe(true);
      const validation = await validateManifestFile(path);
      expect(validation.ok).toBe(false);
      expect(validation.problems.join("\n")).toContain(parser);
      expect(validation.problems.join("\n")).toContain(schema.split(" ")[0]!);
    },
  );

  test.each(semanticCases)(
    "semantic rule %p is enforced by the parser even where the schema cannot express it", async ({ file, parser }) => {
      const path = join(fixtures, "invalid", file);
      const text = await readFile(path, "utf8");
      expect(() => parseManifestText(text, path)).toThrow(parser);
      expect(schemaProblems(MANIFEST_SCHEMA_ID, Bun.TOML.parse(text))).toEqual([]); // the schema alone cannot see it
      const validation = await validateManifestFile(path);
      expect(validation.ok).toBe(false);
      expect(validation.problems.join("\n")).toContain(parser);
    },
  );

  test("the report schema accepts the historical sample and the synthetic report/2 and pinpoints structural damage", async () => {
    const legacy = JSON.parse(await readFile(join(root, "docs/examples/secp-transfer-committed-report.json"), "utf8"));
    expect(schemaProblems(REPORT_SCHEMA_ID, legacy)).toEqual([]);
    const modern = syntheticReportV2();
    expect(schemaProblems(REPORT_SCHEMA_ID, modern)).toEqual([]);

    const cases: Array<[string, (report: Record<string, unknown>) => void, string]> = [
      ["extra top-level field", (r) => { r.notes = "x"; }, "/ must NOT have additional properties (notes)"],
      ["malformed digest", (r) => { (r.digests as Record<string, unknown>).outcome = "sha256:short"; }, "/digests/outcome must match pattern"],
      ["unknown verdict", (r) => { r.verdict = "MAYBE"; }, "/verdict must be equal to one of the allowed values"],
      ["unknown report schema", (r) => { r.schema = "ckb-verify-report/9"; }, "/schema"],
      ["wrong outcome schema", (r) => { (r.outcomeClaims as Record<string, unknown>).schema = "ckb-verify-outcome/1"; }, "/outcomeClaims/schema must be equal to constant"],
      ["step without duration", (r) => { delete ((r.evidence as { steps: Array<Record<string, unknown>> }).steps[0] as Record<string, unknown>).durationMs; }, "/evidence/steps/0 must have required property 'durationMs'"],
      ["extra claim field", (r) => { ((r.outcomeClaims as { steps: Array<{ claims: Array<Record<string, unknown>> }> }).steps[0]!.claims[0] as Record<string, unknown>).note = 1; }, "/outcomeClaims/steps/0/claims/0 must NOT have additional properties (note)"],
      ["environment schema drift", (r) => { (r.environment as Record<string, unknown>).schema = "ckb-verify-environment/2"; }, "/environment/schema"],
      ["rejection with unknown kind", (r) => { ((r.evidence as { steps: Array<Record<string, unknown>> }).steps[0] as Record<string, unknown>).rejection = { kind: "timeout" }; }, "/evidence/steps/0/rejection/kind must be equal to one of the allowed values"],
    ];
    for (const [label, damage, expected] of cases) {
      const report = syntheticReportV2() as unknown as Record<string, unknown>;
      damage(report);
      const problems = schemaProblems(REPORT_SCHEMA_ID, report);
      expect(problems.some((problem) => problem.startsWith(expected)), `${label}: ${JSON.stringify(problems)}`).toBe(true);
      const inspection = inspectReport(report);
      expect(inspection.valid, label).toBe(false);
      expect(inspection.schemaCheck?.ok, label).toBe(false);
    }
  });

  test("a structurally valid but semantically tampered report fails the verifier, not the schema", () => {
    const report = syntheticReportV2();
    (report.outcomeClaims.steps[0]!.claims[0] as { observed: { dataBytes: number } }).observed.dataBytes = 9;
    report.digests = { outcome: canonicalSha256(report.outcomeClaims), environment: canonicalSha256(report.environment) };
    const inspection = inspectReport(report);
    expect(inspection.schemaCheck).toEqual({ id: REPORT_SCHEMA_ID, ok: true, problems: [] });
    expect(inspection.valid).toBe(false);
    expect(inspection.problems.join("\n")).toContain("mismatch");
  });
});
