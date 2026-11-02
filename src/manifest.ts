import { ManifestError } from "./errors";
import { resolvePinnedDebuggerAsset } from "./debugger-binary";
import type {
  CellAssertion,
  ClaimV4,
  CellAssertionV4,
  Builtin,
  Manifest,
  ManifestMeta,
  ManifestStep,
  ManifestToolchain,
  ReplayDependency,
  StepExpectation,
  TransactionExpectation,
} from "./types";

export { ManifestError } from "./errors";

const SPEC_VERSION = "0.1.0-draft.3" as const;
export { MAX_BYTES } from "./limits";
import { MAX_BYTES } from "./limits";
import { parseAssertionsV5, parseExpectationV5 } from "./manifest-v5";
const OFFCKB_VERSION = "0.4.13" as const;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const REPLAY_DEPENDENCIES = new Set<ReplayDependency>([
  "external_time",
  "randomness",
  "fee_estimation",
  "dynamic_since",
  "external_network",
]);

type TomlObject = Record<string, unknown>;

function fail(source: string, message: string, cause?: unknown): never {
  throw new ManifestError(source, message, cause instanceof Error ? { cause } : undefined);
}

function asObject(value: unknown, path: string, source: string): TomlObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, `${path} must be a table`);
  }
  return value as TomlObject;
}

function exactKeys(value: TomlObject, allowed: readonly string[], path: string, source: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(source, `${path ? `${path}.` : ""}${key} is not supported`);
    }
  }
}

function requiredString(value: unknown, path: string, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(source, `${path} must be a non-empty string`);
  }
  return value;
}

function exactVersion(value: unknown, path: string, source: string): string {
  const result = requiredString(value, path, source);
  if (!EXACT_VERSION.test(result)) {
    fail(source, `${path} must be an exact x.y.z version`);
  }
  return result;
}

function parseMeta(value: unknown, source: string): ManifestMeta {
  const table = asObject(value, "meta", source);
  exactKeys(table, ["name", "spec", "description"], "meta", source);
  const name = requiredString(table.name, "meta.name", source);
  if (name.length > 100) fail(source, "meta.name must not exceed 100 characters");
  if (table.spec !== SPEC_VERSION && table.spec !== "0.1.0-draft.4" && table.spec !== "0.1.0-draft.5" && table.spec !== "0.1.0") {
    fail(source, 'meta.spec must equal "0.1.0", "0.1.0-draft.5", "0.1.0-draft.4", or "0.1.0-draft.3"');
  }

  let description: string | undefined;
  if (table.description !== undefined) {
    description = requiredString(table.description, "meta.description", source);
  }

  return {
    name,
    spec: table.spec,
    ...(description === undefined ? {} : { description }),
  };
}

function parseToolchain(value: unknown, source: string): ManifestToolchain {
  const table = asObject(value, "toolchain", source);
  exactKeys(table, ["ckb", "offckb", "ckb-debugger"], "toolchain", source);
  const ckb = exactVersion(table.ckb, "toolchain.ckb", source);
  if (table.offckb !== OFFCKB_VERSION) {
    fail(source, `toolchain.offckb must equal "${OFFCKB_VERSION}"`);
  }

  let ckbDebugger: string | undefined;
  if (table["ckb-debugger"] !== undefined) {
    ckbDebugger = exactVersion(table["ckb-debugger"], "toolchain.ckb-debugger", source);
    try { resolvePinnedDebuggerAsset(ckbDebugger, "linux", "x64"); }
    catch (error) { fail(source, "toolchain.ckb-debugger has no supported pinned artifact", error); }
  }

  return {
    ckb,
    offckb: OFFCKB_VERSION,
    ...(ckbDebugger === undefined ? {} : { ckbDebugger }),
  };
}

function parseReplay(value: unknown, source: string): { dependencies: ReplayDependency[] } {
  const table = asObject(value, "replay", source);
  exactKeys(table, ["dependencies"], "replay", source);
  if (!Array.isArray(table.dependencies)) {
    fail(source, "replay.dependencies must be an array");
  }
  const dependencies = table.dependencies.map((dependency, index) => {
    if (typeof dependency !== "string" || !REPLAY_DEPENDENCIES.has(dependency as ReplayDependency)) {
      fail(source, `replay.dependencies[${index}] must be a supported replay dependency`);
    }
    return dependency as ReplayDependency;
  });
  if (new Set(dependencies).size !== dependencies.length) {
    fail(source, "replay.dependencies must not contain duplicates");
  }
  return { dependencies };
}

function parseSetup(value: unknown, source: string): { accounts: number } {
  const table = asObject(value, "setup", source);
  exactKeys(table, ["accounts"], "setup", source);
  const accounts = table.accounts;
  if (!Number.isInteger(accounts) || (accounts as number) < 1 || (accounts as number) > 20) {
    fail(source, "setup.accounts must be an integer between 1 and 20");
  }
  return { accounts: accounts as number };
}

function parseTimeout(value: unknown, path: string, source: string): number {
  let seconds: number;
  if (value === undefined) {
    seconds = 60;
  } else if (typeof value === "number" && Number.isInteger(value)) {
    seconds = value;
  } else if (typeof value === "string" && /^\d+s$/.test(value)) {
    seconds = Number(value.slice(0, -1));
  } else {
    fail(source, `${path} must be an integer number of seconds or an <n>s string`);
  }

  if (seconds < 1 || seconds > 600) {
    fail(source, `${path} must be between 1s and 600s`);
  }
  return seconds * 1_000;
}

function parseExpectation(value: unknown, path: string, source: string): StepExpectation | undefined {
  if (value === undefined) return undefined;
  const table = asObject(value, path, source);
  exactKeys(table, ["tx", "error"], path, source);
  if (table.tx !== "committed" && table.tx !== "rejected") {
    fail(source, `${path}.tx must be "committed" or "rejected"`);
  }
  const tx = table.tx as TransactionExpectation;

  let error: StepExpectation["error"];
  if (table.error !== undefined) {
    if (tx !== "rejected") fail(source, `${path}.error requires tx = "rejected"`);
    const errorTable = asObject(table.error, `${path}.error`, source);
    exactKeys(errorTable, ["code"], `${path}.error`, source);
    if (errorTable.code !== undefined && !Number.isSafeInteger(errorTable.code)) {
      fail(source, `${path}.error.code must be a safe integer`);
    }
    error = errorTable.code === undefined ? {} : { code: errorTable.code as number };
  }

  return { tx, ...(error === undefined ? {} : { error }) };
}

function parseCellAssertions(
  value: unknown,
  path: string,
  allowedStepNames: ReadonlySet<string>,
  source: string,
): CellAssertion[] {
  if (value === undefined) return [];
  const container = asObject(value, path, source);
  exactKeys(container, ["cell"], path, source);
  if (container.cell === undefined) return [];
  if (!Array.isArray(container.cell)) fail(source, `${path}.cell must be an array of tables`);

  return container.cell.map((raw, index) => {
    const itemPath = `${path}.cell[${index}]`;
    const table = asObject(raw, itemPath, source);
    exactKeys(table, ["out_point", "count"], itemPath, source);
    const outPoint = asObject(table.out_point, `${itemPath}.out_point`, source);
    exactKeys(outPoint, ["step", "index"], `${itemPath}.out_point`, source);
    const step = requiredString(outPoint.step, `${itemPath}.out_point.step`, source);
    if (!allowedStepNames.has(step)) {
      fail(source, `${itemPath}.out_point.step must reference this or an earlier step`);
    }
    if (!Number.isSafeInteger(outPoint.index) || (outPoint.index as number) < 0) {
      fail(source, `${itemPath}.out_point.index must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(table.count) || (table.count as number) < 0) {
      fail(source, `${itemPath}.count must be a non-negative safe integer`);
    }

    return {
      kind: "cell" as const,
      outPoint: { step, index: outPoint.index as number },
      count: table.count as number,
    };
  });
}

function boundedInteger(value: unknown, min: number, max: number, path: string, source: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(source, `${path} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function builtin(value: unknown, path: string, source: string): Builtin {
  if (value !== "dao" && value !== "spore") fail(source, `${path} must be dao or spore`);
  return value;
}

function parseAssertionsV4(value: unknown, path: string, names: ReadonlySet<string>, source: string): ClaimV4[] {
  if (value === undefined) return [];
  const container = asObject(value, path, source);
  exactKeys(container, ["cell", "cell_deps"], path, source);
  const cells = container.cell ?? [];
  if (!Array.isArray(cells)) fail(source, `${path}.cell must be an array of tables`);
  const claims: ClaimV4[] = cells.map((raw, i): CellAssertionV4 => {
    const p = `${path}.cell[${i}]`;
    const item = asObject(raw, p, source);
    exactKeys(item, ["out_point", "count", "type", "data"], p, source);
    const out = asObject(item.out_point, `${p}.out_point`, source);
    exactKeys(out, ["step", "index"], `${p}.out_point`, source);
    const step = requiredString(out.step, `${p}.out_point.step`, source);
    if (!names.has(step)) fail(source, `${p}.out_point.step must reference this or an earlier step`);
    const index = boundedInteger(out.index, 0, 0xffff_ffff, `${p}.out_point.index`, source);
    const count = boundedInteger(item.count, 0, 1, `${p}.count`, source) as 0 | 1;
    let type: CellAssertionV4["type"];
    if (Object.hasOwn(item, "type")) {
      if (count !== 1) fail(source, `${p}.type requires count = 1`);
      const t = asObject(item.type, `${p}.type`, source);
      exactKeys(t, ["builtin", "args_bytes"], `${p}.type`, source);
      type = { kind: "builtin", name: builtin(t.builtin, `${p}.type.builtin`, source),
        argsBytes: boundedInteger(t.args_bytes, 0, MAX_BYTES, `${p}.type.args_bytes`, source) };
    }
    let data: CellAssertionV4["data"];
    if (Object.hasOwn(item, "data")) {
      if (count !== 1) fail(source, `${p}.data requires count = 1`);
      const d = asObject(item.data, `${p}.data`, source);
      exactKeys(d, ["min_bytes"], `${p}.data`, source);
      data = { minBytes: boundedInteger(d.min_bytes, 1, MAX_BYTES, `${p}.data.min_bytes`, source) };
    }
    return { kind: "cell", outPoint: { step, index }, count, ...(type === undefined ? {} : { type }), ...(data === undefined ? {} : { data }) };
  });
  const deps = container.cell_deps ?? [];
  if (!Array.isArray(deps)) fail(source, `${path}.cell_deps must be an array of tables`);
  deps.forEach((raw, i) => {
    const p = `${path}.cell_deps[${i}]`, d = asObject(raw, p, source);
    exactKeys(d, ["step", "contains"], p, source);
    const step = requiredString(d.step, `${p}.step`, source);
    if (!names.has(step)) fail(source, `${p}.step must reference this or an earlier step`);
    const contains = asObject(d.contains, `${p}.contains`, source);
    exactKeys(contains, ["builtin"], `${p}.contains`, source);
    claims.push({ kind: "cell_deps", step, contains: { kind: "builtin", name: builtin(contains.builtin, `${p}.contains.builtin`, source) } });
  });
  return claims;
}

function parseSteps<A>(value: unknown, source: string,
  assertions: (value: unknown, path: string, names: ReadonlySet<string>, source: string) => A[],
  expectation: (value: unknown, path: string, source: string) => StepExpectation | undefined = parseExpectation,
): ManifestStep<A>[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(source, "step must contain at least one array table");
  }

  const tables = value.map((raw, index) => {
    const path = `step[${index}]`;
    const table = asObject(raw, path, source);
    exactKeys(table, ["name", "run", "timeout", "expect", "assert"], path, source);
    return table;
  });

  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, table] of tables.entries()) {
    const name = requiredString(table.name, `step[${index}].name`, source);
    if (seen.has(name)) fail(source, `step name "${name}" is duplicated`);
    seen.add(name);
    names.push(name);
  }

  return tables.map((table, index) => {
    const path = `step[${index}]`;
    const allowedStepNames = new Set(names.slice(0, index + 1));
    const expect = expectation(table.expect, `${path}.expect`, source);
    return {
      name: names[index] as string,
      run: requiredString(table.run, `${path}.run`, source),
      timeoutMs: parseTimeout(table.timeout, `${path}.timeout`, source),
      ...(expect === undefined ? {} : { expect }),
      assertions: assertions(table.assert, `${path}.assert`, allowedStepNames, source),
    };
  });
}

export function parseManifestText(text: string, source = "verify.toml"): Manifest {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    fail(source, "invalid TOML", error);
  }

  const root = asObject(parsed, "manifest", source);
  exactKeys(root, ["meta", "toolchain", "replay", "setup", "step", "assert"], "", source);
  const meta = parseMeta(root.meta, source);
  const common = { toolchain: parseToolchain(root.toolchain, source),
    replay: parseReplay(root.replay, source), setup: parseSetup(root.setup, source) };
  const parseBody = <A>(parser: (value: unknown, path: string, names: ReadonlySet<string>, source: string) => A[],
    expectation?: (value: unknown, path: string, source: string) => StepExpectation | undefined) => {
    const steps = parseSteps(root.step, source, parser, expectation);
    const assertions = parser(root.assert, "assert", new Set(steps.map(step => step.name)), source);

    const claimCount = steps.reduce(
      (count, step) => count + (step.expect === undefined ? 0 : 1) + step.assertions.length,
      assertions.length,
    );
    if (claimCount === 0) {
      fail(source, "manifest must declare at least one expectation or assertion");
    }

    if (steps.some(step => step.expect?.tx === "rejected") && common.toolchain.ckbDebugger === undefined) {
      fail(source, "rejected transactions require toolchain.ckb-debugger");
    }
    return { steps, assertions };
  };
  if (meta.spec === "0.1.0-draft.5" || meta.spec === "0.1.0") {
    return { meta: { ...meta, spec: meta.spec }, ...common, ...parseBody(parseAssertionsV5(common.setup.accounts), parseExpectationV5) };
  }
  return meta.spec === "0.1.0-draft.4"
    ? { meta: { ...meta, spec: "0.1.0-draft.4" }, ...common, ...parseBody(parseAssertionsV4) }
    : { meta: { ...meta, spec: "0.1.0-draft.3" }, ...common, ...parseBody(parseCellAssertions) };
}

export async function loadManifest(path: string): Promise<{ manifest: Manifest; bytes: Uint8Array }> {
  const file = Bun.file(path);
  if (!(await file.exists())) fail(path, "file does not exist");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const manifest = parseManifestText(new TextDecoder().decode(bytes), path);
  if (manifest.meta.spec !== "0.1.0-draft.3") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!Buffer.from(text, "utf8").equals(bytes)) fail(path, "manifest must roundtrip as UTF-8");
    } catch (error) { fail(path, "manifest must be valid UTF-8", error); }
  }
  return { manifest, bytes };
}
