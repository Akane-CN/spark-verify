// The 0.2.0 grammar: the frozen 0.1.0 vocabulary plus RFC §3.2/§3.3 `[setup.scripts.<name>]` (repository
// binaries and built-in aliases), §5.3 named script references, §4.1 pure steps, §1 zero steps and §3.1
// zero accounts, and §4.2 `expect.error.group`. The 0.1.0 parsers are reused unchanged; only the script
// reference and dependency parsers are widened, and only for this spec.
import { ManifestError } from "./errors";
import { parseAssertionsV5, parseBuiltinContains, parseCyclesCheck, parseScriptRef, type AssertionParsers, type ScriptRefParser } from "./manifest-v5";
import {
  SYSTEM_SCRIPT_NAMES, type ClaimV5, type ErrorGroupExpectation, type ManifestStepV6, type ManifestV6, type ManifestMeta,
  type ManifestToolchain, type ReplayDependency, type ScriptHashType, type SetupScript, type StepExpectationV6, type SystemScriptName,
} from "./types";

type TomlObject = Record<string, unknown>;

/** OffCKB 0.4.13 deploys from its last development account (index 19), so a manifest that deploys may export at most 19. */
export const OFFCKB_DEPLOYER_ACCOUNT_INDEX = 19;
/** OffCKB 0.4.13 silently skips binaries above this size; the runner refuses them instead. */
export const MAX_DEPLOY_BYTES = 500 * 1024;
export const MAX_SETUP_SCRIPTS = 16;
const SETUP_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

function fail(source: string, message: string): never {
  throw new ManifestError(source, message);
}
function asObject(value: unknown, path: string, source: string): TomlObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(source, `${path} must be a table`);
  return value as TomlObject;
}
function exactKeys(value: TomlObject, allowed: readonly string[], path: string, source: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(source, `${path}.${key} is not supported`);
}
function requiredString(value: unknown, path: string, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(source, `${path} must be a non-empty string`);
  return value;
}

/** A repository-relative path: forward slashes, no absolute root, no `.`/`..`/empty segments, no control characters. */
export function validateRepositoryPath(value: unknown, path: string, source: string): string {
  const text = requiredString(value, path, source);
  // eslint-disable-next-line no-control-regex
  if (text.length > 1024 || /[\u0000-\u001f\\]/.test(text) || text.startsWith("/") || /^[A-Za-z]:/.test(text)) {
    fail(source, `${path} must be a repository-relative path with forward slashes`);
  }
  if (text.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(source, `${path} must not contain empty, "." or ".." segments`);
  }
  return text;
}

function parseSetup(value: unknown, source: string): ManifestV6["setup"] {
  const table = asObject(value, "setup", source);
  exactKeys(table, ["accounts", "scripts"], "setup", source);
  const accounts = table.accounts;
  if (typeof accounts !== "number" || !Number.isInteger(accounts) || accounts < 0 || accounts > 20) {
    fail(source, "setup.accounts must be an integer between 0 and 20");
  }
  const scripts: SetupScript[] = [];
  if (table.scripts !== undefined) {
    const entries = Object.entries(asObject(table.scripts, "setup.scripts", source));
    if (entries.length > MAX_SETUP_SCRIPTS) fail(source, `setup.scripts must declare at most ${MAX_SETUP_SCRIPTS} scripts`);
    for (const [name, raw] of entries) {
      const p = `setup.scripts.${name}`;
      if (!SETUP_NAME.test(name)) fail(source, `${p}: script names must match ${SETUP_NAME.source}`);
      const entry = asObject(raw, p, source);
      exactKeys(entry, ["binary", "hash_type", "builtin"], p, source);
      const hasBinary = Object.hasOwn(entry, "binary"), hasBuiltin = Object.hasOwn(entry, "builtin");
      if (hasBinary === hasBuiltin) fail(source, `${p} must define exactly one of binary or builtin`);
      if (hasBinary) {
        const hashType = entry.hash_type;
        if (hashType !== "type" && hashType !== "data" && hashType !== "data1" && hashType !== "data2") {
          fail(source, `${p}.hash_type must be type, data, data1, or data2`);
        }
        scripts.push({ name, kind: "binary", path: validateRepositoryPath(entry.binary, `${p}.binary`, source), hashType: hashType as ScriptHashType });
      } else {
        if (Object.hasOwn(entry, "hash_type")) fail(source, `${p}.hash_type is not supported with builtin; the built-in's own hash type applies`);
        const builtin = entry.builtin;
        if (typeof builtin !== "string" || !(SYSTEM_SCRIPT_NAMES as readonly string[]).includes(builtin)) {
          fail(source, `${p}.builtin must be one of the OffCKB system scripts: ${SYSTEM_SCRIPT_NAMES.join(", ")}`);
        }
        scripts.push({ name, kind: "builtin", builtin: builtin as SystemScriptName });
      }
    }
  }
  if (scripts.some((script) => script.kind === "binary") && accounts > OFFCKB_DEPLOYER_ACCOUNT_INDEX) {
    fail(source, `setup.accounts must be at most ${OFFCKB_DEPLOYER_ACCOUNT_INDEX} when setup.scripts deploys a binary: OffCKB deploys from development account ${OFFCKB_DEPLOYER_ACCOUNT_INDEX}`);
  }
  return { accounts, scripts };
}

/** Script references for 0.2.0: everything 0.1.0 accepts, plus `"name"` and `{ script = "name"[, args] }`. */
function scriptRefParser(names: ReadonlySet<string>): ScriptRefParser {
  return (value, path, source, options) => {
    if (typeof value === "string") {
      if (!names.has(value)) fail(source, `${path} names an unknown setup script "${value}"`);
      if (!options.allowWildcard) fail(source, `${path} needs exact args here; write { script = "${value}", args = "0x…" }`);
      return { kind: "setup", name: value, args: null };
    }
    const table = asObject(value, path, source);
    if (Object.hasOwn(table, "script")) {
      exactKeys(table, ["script", "args"], path, source);
      const name = table.script;
      if (typeof name !== "string" || !names.has(name)) fail(source, `${path}.script names an unknown setup script "${String(name)}"`);
      if (!Object.hasOwn(table, "args")) {
        if (!options.allowWildcard) fail(source, `${path}.args is required here; wildcard args are not allowed`);
        return { kind: "setup", name, args: null };
      }
      const args = table.args;
      if (typeof args !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(args) || args.length > 2 + 2 * 4096) {
        fail(source, `${path}.args must be lowercase 0x-prefixed even-length hex`);
      }
      return { kind: "setup", name, args };
    }
    return parseScriptRef(value, path, source, options);
  };
}

function parsers(names: ReadonlySet<string>): AssertionParsers {
  return {
    scriptRef: scriptRefParser(names),
    contains(value, path, source) {
      const table = asObject(value, path, source);
      if (Object.hasOwn(table, "script")) {
        exactKeys(table, ["script"], path, source);
        const name = table.script;
        if (typeof name !== "string" || !names.has(name)) fail(source, `${path}.script names an unknown setup script "${String(name)}"`);
        return { kind: "setup", name };
      }
      return parseBuiltinContains(value, path, source);
    },
  };
}

function parseTimeout(value: unknown, path: string, source: string): number {
  let seconds: number;
  if (value === undefined) seconds = 60;
  else if (typeof value === "number" && Number.isInteger(value)) seconds = value;
  else if (typeof value === "string" && /^\d+s$/.test(value)) seconds = Number(value.slice(0, -1));
  else fail(source, `${path} must be an integer number of seconds or an <n>s string`);
  if (seconds < 1 || seconds > 600) fail(source, `${path} must be between 1s and 600s`);
  return seconds * 1_000;
}

function parseExpectation(value: unknown, path: string, source: string, refs: ScriptRefParser, accounts: number): StepExpectationV6 {
  const table = asObject(value, path, source);
  exactKeys(table, ["tx", "error", "cycles"], path, source);
  if (table.tx !== "committed" && table.tx !== "rejected") fail(source, `${path}.tx must be "committed" or "rejected"; a step without expect.tx is a pure step and declares no expect table`);
  const tx = table.tx;
  let error: StepExpectationV6["error"];
  if (table.error !== undefined) {
    if (tx !== "rejected") fail(source, `${path}.error requires tx = "rejected"`);
    const errorTable = asObject(table.error, `${path}.error`, source);
    exactKeys(errorTable, ["code", "group"], `${path}.error`, source);
    error = {};
    if (errorTable.code !== undefined) {
      if (typeof errorTable.code !== "number" || !Number.isSafeInteger(errorTable.code)) fail(source, `${path}.error.code must be a safe integer`);
      error.code = errorTable.code;
    }
    if (errorTable.group !== undefined) {
      const group = asObject(errorTable.group, `${path}.error.group`, source);
      const role = group.role;
      if (role !== "lock" && role !== "type") fail(source, `${path}.error.group.role must be "lock" or "type"`);
      const { role: _role, ...reference } = group;
      void _role;
      if (Object.keys(reference).length === 0) fail(source, `${path}.error.group requires a script reference besides role`);
      const script = refs(reference, `${path}.error.group`, source, { allowAccount: role === "lock", allowWildcard: true });
      if (script.kind === "account" && script.index >= accounts) fail(source, `${path}.error.group.account must be below setup.accounts (${accounts})`);
      error.group = { role, script } satisfies ErrorGroupExpectation;
    }
  }
  const cycles = table.cycles === undefined ? undefined : parseCyclesCheck(table.cycles, `${path}.cycles`, source);
  return { tx, ...(error === undefined ? {} : { error }), ...(cycles === undefined ? {} : { cycles }) };
}

/** Out-point and dependency claims need a transaction; refuse references to pure steps with a precise message. */
function refusePureTargets(raw: unknown, path: string, pure: ReadonlySet<string>, source: string): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const container = raw as TomlObject;
  const check = (items: unknown, kind: "cell" | "cell_deps") => {
    if (!Array.isArray(items)) return;
    items.forEach((item, i) => {
      if (item === null || typeof item !== "object") return;
      const record = item as TomlObject;
      const step = kind === "cell"
        ? (record.out_point !== null && typeof record.out_point === "object" ? (record.out_point as TomlObject).step : undefined)
        : record.step;
      if (typeof step === "string" && pure.has(step)) {
        fail(source, `${path}.${kind}[${i}]${kind === "cell" ? ".out_point" : ""}.step references pure step "${step}", which produces no transaction`);
      }
    });
  };
  check(container.cell, "cell");
  check(container.cell_deps, "cell_deps");
}

export function parseManifestV6(
  root: TomlObject, meta: ManifestMeta<"0.2.0">, toolchain: ManifestToolchain, replay: { dependencies: ReplayDependency[] }, source: string,
): ManifestV6 {
  const setup = parseSetup(root.setup, source);
  const names = new Set(setup.scripts.map((script) => script.name));
  const assertionParsers = parsers(names);
  const refs = assertionParsers.scriptRef;
  const assertions = parseAssertionsV5(setup.accounts, assertionParsers);

  let rawSteps: unknown[] = [];
  if (root.step !== undefined) {
    if (!Array.isArray(root.step)) fail(source, "step must be an array of tables");
    rawSteps = root.step;
  }
  const tables = rawSteps.map((raw, index) => {
    const table = asObject(raw, `step[${index}]`, source);
    exactKeys(table, ["name", "run", "timeout", "expect", "assert"], `step[${index}]`, source);
    return table;
  });
  const stepNames: string[] = [];
  for (const [index, table] of tables.entries()) {
    const name = requiredString(table.name, `step[${index}].name`, source);
    if (stepNames.includes(name)) fail(source, `step name "${name}" is duplicated`);
    stepNames.push(name);
  }
  const pure = new Set(tables.filter((table) => table.expect === undefined).map((table) => table.name as string));
  const steps: ManifestStepV6[] = tables.map((table, index) => {
    const path = `step[${index}]`;
    const name = stepNames[index]!;
    refusePureTargets(table.assert, `${path}.assert`, pure, source);
    // A step's own claims may reference itself only when it is a transaction step.
    const visible = new Set(stepNames.slice(0, index + 1).filter((candidate) => !pure.has(candidate)));
    const claims: ClaimV5[] = assertions(table.assert, `${path}.assert`, visible, source);
    const common = { name, run: requiredString(table.run, `${path}.run`, source), timeoutMs: parseTimeout(table.timeout, `${path}.timeout`, source), assertions: claims };
    if (table.expect === undefined) return { ...common, kind: "pure" as const };
    return { ...common, kind: "transaction" as const, expect: parseExpectation(table.expect, `${path}.expect`, source, refs, setup.accounts) };
  });
  refusePureTargets(root.assert, "assert", pure, source);
  const finalAssertions = assertions(root.assert, "assert", new Set(stepNames.filter((name) => !pure.has(name))), source);

  const claimCount = steps.reduce((count, step) => count + (step.kind === "transaction" ? 1 : 0) + step.assertions.length, finalAssertions.length);
  if (claimCount === 0) fail(source, "manifest must declare at least one expectation or assertion");
  if (steps.some((step) => step.kind === "transaction" && step.expect.tx === "rejected") && toolchain.ckbDebugger === undefined) {
    fail(source, "rejected transactions require toolchain.ckb-debugger");
  }
  return { meta, toolchain, replay, setup, steps, assertions: finalAssertions };
}
