// Published JSON Schemas compiled once with Ajv (strict). Shape validation complements the strict
// parser and the semantic verifier; it never replaces them.
import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

export const MANIFEST_SCHEMA_ID = "https://github.com/Akane-CN/spark-verify/schemas/ckb-verify-manifest-v1.schema.json";
export const REPORT_SCHEMA_ID = "https://github.com/Akane-CN/spark-verify/schemas/ckb-verify-report.schema.json";
export const CLAIMS_SCHEMA_ID = "https://spark-verify.invalid/schemas/ckb-verify-claims-v2.schema.json";
export const PROVENANCE_V1_SCHEMA_ID = "https://github.com/Akane-CN/spark-verify/schemas/ckb-verify-provenance-v1.schema.json";
export const PROVENANCE_V2_SCHEMA_ID = "https://github.com/Akane-CN/spark-verify/schemas/ckb-verify-provenance-v2.schema.json";

/** Every published schema file, keyed by `$id`; the files ship inside the package under `schemas/`. */
export const SCHEMA_FILES: Readonly<Record<string, string>> = {
  [CLAIMS_SCHEMA_ID]: "ckb-verify-claims-v2.schema.json",
  [PROVENANCE_V1_SCHEMA_ID]: "ckb-verify-provenance-v1.schema.json",
  [PROVENANCE_V2_SCHEMA_ID]: "ckb-verify-provenance-v2.schema.json",
  [MANIFEST_SCHEMA_ID]: "ckb-verify-manifest-v1.schema.json",
  [REPORT_SCHEMA_ID]: "ckb-verify-report.schema.json",
};

let registry: Ajv2020 | undefined;

function ajv(): Ajv2020 {
  if (registry !== undefined) return registry;
  const instance = new Ajv2020({ strict: true, allErrors: true, discriminator: true });
  for (const [id, file] of Object.entries(SCHEMA_FILES)) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8")) as { $id?: string };
    if (schema.$id !== id) throw new Error(`schema ${file} declares $id ${String(schema.$id)}, expected ${id}`);
    instance.addSchema(schema);
  }
  registry = instance;
  return instance;
}

function validator(id: string): ValidateFunction {
  const compiled = ajv().getSchema(id);
  if (compiled === undefined) throw new Error(`unknown schema: ${id}`);
  return compiled;
}

/** One line per violation: the JSON Pointer of the offending value, then Ajv's message and the relevant parameter. */
export function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  const params = error.params as Record<string, unknown>;
  let detail = "";
  if (error.keyword === "additionalProperties") detail = ` (${String(params.additionalProperty)})`;
  else if (error.keyword === "enum") detail = ` (${JSON.stringify(params.allowedValues)})`;
  else if (error.keyword === "const") detail = ` (${JSON.stringify(params.allowedValue)})`;
  else if (error.keyword === "required") detail = ` (${String(params.missingProperty)})`;
  else if (error.keyword === "discriminator") detail = ` (${String(params.tag)}=${JSON.stringify(params.tagValue)})`;
  return `${path} ${error.message ?? error.keyword}${detail}`;
}

/** Returns an empty array when `value` satisfies the schema; otherwise every violation, deduplicated. */
export function schemaProblems(id: string, value: unknown): string[] {
  const validate = validator(id);
  if (validate(value) === true) return [];
  return [...new Set((validate.errors ?? []).map(formatSchemaError))];
}
