// The 0.1.0-draft.5 grammar: RFC §4.2 cycles comparators, §5.1 Cell selectors and property checks,
// §5.2 balance claims, and §5.3 script references. Strict: unknown keys fail, quantities are strings.
import { ManifestError } from "./errors";
import { decodeFullAddress } from "./address";
import { MAX_BYTES } from "./limits";
import {
  SYSTEM_SCRIPT_NAMES, type BalanceAssertionV5, type CellAssertionV5, type ClaimV5, type CountRange, type CyclesCheck,
  type QuantityRange, type ScriptRef, type StepExpectation, type SystemScriptName, type TransactionExpectation,
} from "./types";

type TomlObject = Record<string, unknown>;
const U32 = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function fail(source: string, message: string, cause?: unknown): never {
  throw new ManifestError(source, message, cause instanceof Error ? { cause } : undefined);
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
function integer(value: unknown, min: number, max: number, path: string, source: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(source, `${path} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}
function hexBytes(value: unknown, path: string, source: string): string {
  if (typeof value !== "string" || value.length > 2 + MAX_BYTES * 2 || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    fail(source, `${path} must be lowercase 0x-prefixed even-length hex of at most ${MAX_BYTES} bytes`);
  }
  return value;
}
function hash32(value: unknown, path: string, source: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) fail(source, `${path} must be a lowercase 32-byte 0x hash`);
  return value;
}
const byteLength = (hex: string): number => (hex.length - 2) / 2;

/** Explicit `{ code_hash, hash_type, args }`, builtin `{ builtin[, args] }`, or `{ account }`; a bare name is refused. */
export function parseScriptRef(value: unknown, path: string, source: string, options: { allowAccount: boolean; allowWildcard: boolean }): ScriptRef {
  if (typeof value === "string") {
    fail(source, `${path} must be a table; named setup scripts are not supported, use { builtin = "<name>" } or an explicit { code_hash, hash_type, args }`);
  }
  const table = asObject(value, path, source);
  exactKeys(table, ["code_hash", "hash_type", "args", "builtin", "account"], path, source);
  const has = (key: string) => Object.hasOwn(table, key);
  if (has("code_hash") || has("hash_type")) {
    if (has("builtin") || has("account")) fail(source, `${path} must be exactly one of an explicit script, a builtin reference, or an account`);
    if (!has("code_hash") || !has("hash_type") || !has("args")) fail(source, `${path} explicit script requires code_hash, hash_type, and args`);
    const hashType = table.hash_type;
    if (hashType !== "data" && hashType !== "type" && hashType !== "data1" && hashType !== "data2") fail(source, `${path}.hash_type must be data, type, data1, or data2`);
    return { kind: "explicit", codeHash: hash32(table.code_hash, `${path}.code_hash`, source), hashType, args: hexBytes(table.args, `${path}.args`, source) };
  }
  if (has("builtin")) {
    if (has("account")) fail(source, `${path} must be exactly one of an explicit script, a builtin reference, or an account`);
    const name = table.builtin;
    if (typeof name !== "string" || !(SYSTEM_SCRIPT_NAMES as readonly string[]).includes(name)) {
      fail(source, `${path}.builtin must be one of the OffCKB system scripts: ${SYSTEM_SCRIPT_NAMES.join(", ")}`);
    }
    if (!has("args")) {
      if (!options.allowWildcard) fail(source, `${path}.args is required here; wildcard args are not allowed`);
      return { kind: "builtin", name: name as SystemScriptName, args: null };
    }
    return { kind: "builtin", name: name as SystemScriptName, args: hexBytes(table.args, `${path}.args`, source) };
  }
  if (has("account")) {
    if (has("args")) fail(source, `${path}.args is not supported with account`);
    if (!options.allowAccount) fail(source, `${path}.account is only valid for lock references`);
    return { kind: "account", index: integer(table.account, 0, 19, `${path}.account`, source) };
  }
  fail(source, `${path} must be an explicit script { code_hash, hash_type, args }, a builtin reference { builtin }, or an account { account }`);
}

export function parseCountRange(value: unknown, path: string, source: string): CountRange {
  if (typeof value === "number") return { eq: integer(value, 0, U32, path, source) };
  const table = asObject(value, path, source);
  exactKeys(table, ["eq", "gte", "lte"], path, source);
  const range: CountRange = {};
  for (const key of ["eq", "gte", "lte"] as const) if (Object.hasOwn(table, key)) range[key] = integer(table[key], 0, U32, `${path}.${key}`, source);
  if (Object.keys(range).length === 0) fail(source, `${path} requires at least one of eq, gte, lte`);
  if (range.eq !== undefined && (range.gte !== undefined || range.lte !== undefined)) fail(source, `${path}.eq cannot be combined with gte or lte`);
  if (range.gte !== undefined && range.lte !== undefined && range.gte > range.lte) fail(source, `${path}.gte must not exceed lte`);
  return range;
}

/** `"1000 CKB"` (up to eight decimals), `"100000000000 shannon"`, or for UDT `"1000"`; normalized to a decimal base-unit string. */
export function parseQuantity(value: unknown, path: string, source: string, unit: "ckb" | "udt"): string {
  if (typeof value === "number") fail(source, `${path} must be a quantity string; bare numbers are rejected for asset amounts`);
  if (typeof value !== "string") fail(source, `${path} must be a quantity string`);
  let amount: bigint;
  if (unit === "udt") {
    if (!/^\d+$/.test(value)) fail(source, `${path} must be a base-unit integer string such as "1000"`);
    amount = BigInt(value);
    if (amount > U128_MAX) fail(source, `${path} exceeds the 128-bit UDT amount range`);
  } else {
    const ckb = /^(\d+)(?:\.(\d{1,8}))? CKB$/.exec(value);
    const shannon = /^(\d+) shannon$/.exec(value);
    if (ckb !== null) amount = BigInt(ckb[1]!) * 100_000_000n + BigInt((ckb[2] ?? "").padEnd(8, "0"));
    else if (shannon !== null) amount = BigInt(shannon[1]!);
    else fail(source, `${path} must be a quantity string such as "1000 CKB", "0.5 CKB", or "100000000000 shannon"`);
    if (amount > U64_MAX) fail(source, `${path} exceeds the 64-bit capacity range`);
  }
  return amount.toString();
}

function quantityRange(table: TomlObject, path: string, source: string, unit: "ckb" | "udt"): QuantityRange {
  const range: QuantityRange = {};
  for (const key of ["eq", "gte", "lte"] as const) if (Object.hasOwn(table, key)) range[key] = parseQuantity(table[key], `${path}.${key}`, source, unit);
  if (Object.keys(range).length === 0) fail(source, `${path} requires at least one of eq, gte, lte`);
  if (range.eq !== undefined && (range.gte !== undefined || range.lte !== undefined)) fail(source, `${path}.eq cannot be combined with gte or lte`);
  if (range.gte !== undefined && range.lte !== undefined && BigInt(range.gte) > BigInt(range.lte)) fail(source, `${path}.gte must not exceed lte`);
  return range;
}

export function parseCyclesCheck(value: unknown, path: string, source: string): CyclesCheck {
  const table = asObject(value, path, source);
  exactKeys(table, ["lt", "lte", "eq", "gte"], path, source);
  const check: CyclesCheck = {};
  for (const key of ["lt", "lte", "eq", "gte"] as const) {
    if (Object.hasOwn(table, key)) check[key] = integer(table[key], 0, Number.MAX_SAFE_INTEGER, `${path}.${key}`, source);
  }
  if (Object.keys(check).length === 0) fail(source, `${path} requires at least one of lt, lte, eq, gte`);
  if (check.eq !== undefined && Object.keys(check).length > 1) fail(source, `${path}.eq cannot be combined with other comparators`);
  if (check.lt !== undefined && check.lte !== undefined) fail(source, `${path}.lt and lte are mutually exclusive`);
  if (check.gte !== undefined && check.lt !== undefined && check.gte >= check.lt) fail(source, `${path}.gte must be below lt`);
  if (check.gte !== undefined && check.lte !== undefined && check.gte > check.lte) fail(source, `${path}.gte must not exceed lte`);
  return check;
}

export function parseExpectationV5(value: unknown, path: string, source: string): StepExpectation | undefined {
  if (value === undefined) return undefined;
  const table = asObject(value, path, source);
  exactKeys(table, ["tx", "error", "cycles"], path, source);
  if (table.tx !== "committed" && table.tx !== "rejected") fail(source, `${path}.tx must be "committed" or "rejected"`);
  const tx = table.tx as TransactionExpectation;
  let error: StepExpectation["error"];
  if (table.error !== undefined) {
    if (tx !== "rejected") fail(source, `${path}.error requires tx = "rejected"`);
    const errorTable = asObject(table.error, `${path}.error`, source);
    exactKeys(errorTable, ["code"], `${path}.error`, source);
    if (errorTable.code !== undefined && !Number.isSafeInteger(errorTable.code)) fail(source, `${path}.error.code must be a safe integer`);
    error = errorTable.code === undefined ? {} : { code: errorTable.code as number };
  }
  const cycles = table.cycles === undefined ? undefined : parseCyclesCheck(table.cycles, `${path}.cycles`, source);
  return { tx, ...(error === undefined ? {} : { error }), ...(cycles === undefined ? {} : { cycles }) };
}

function parseCell(raw: unknown, p: string, names: ReadonlySet<string>, accounts: number, source: string): CellAssertionV5 {
  const item = asObject(raw, p, source);
  exactKeys(item, ["out_point", "lock", "type", "count", "data", "capacity"], p, source);
  const selector: CellAssertionV5["selector"] = {};
  if (Object.hasOwn(item, "out_point")) {
    const out = asObject(item.out_point, `${p}.out_point`, source);
    exactKeys(out, ["step", "index"], `${p}.out_point`, source);
    const step = requiredString(out.step, `${p}.out_point.step`, source);
    if (!names.has(step)) fail(source, `${p}.out_point.step must reference this or an earlier step`);
    selector.outPoint = { step, index: integer(out.index, 0, U32, `${p}.out_point.index`, source) };
  }
  if (Object.hasOwn(item, "lock")) {
    const lock = parseScriptRef(item.lock, `${p}.lock`, source, { allowAccount: true, allowWildcard: true });
    if (lock.kind === "account" && lock.index >= accounts) fail(source, `${p}.lock.account must be below setup.accounts (${accounts})`);
    selector.lock = lock;
  }
  if (Object.hasOwn(item, "type")) selector.type = parseScriptRef(item.type, `${p}.type`, source, { allowAccount: false, allowWildcard: true });
  if (selector.outPoint === undefined && selector.lock === undefined && selector.type === undefined) {
    fail(source, `${p} requires a selector: out_point, lock, or type`);
  }
  let data: CellAssertionV5["data"];
  if (Object.hasOwn(item, "data")) {
    const table = asObject(item.data, `${p}.data`, source);
    exactKeys(table, ["eq", "len", "min_bytes"], `${p}.data`, source);
    data = {};
    if (Object.hasOwn(table, "eq")) data.eq = hexBytes(table.eq, `${p}.data.eq`, source);
    if (Object.hasOwn(table, "len")) data.len = integer(table.len, 0, MAX_BYTES, `${p}.data.len`, source);
    if (Object.hasOwn(table, "min_bytes")) data.minBytes = integer(table.min_bytes, 1, MAX_BYTES, `${p}.data.min_bytes`, source);
    if (Object.keys(data).length === 0) fail(source, `${p}.data requires at least one of eq, len, min_bytes`);
    if (data.eq !== undefined && data.len !== undefined && data.len !== byteLength(data.eq)) fail(source, `${p}.data.len contradicts the length of data.eq`);
    if (data.eq !== undefined && data.minBytes !== undefined && data.minBytes > byteLength(data.eq)) fail(source, `${p}.data.min_bytes exceeds the length of data.eq`);
    if (data.len !== undefined && data.minBytes !== undefined && data.minBytes > data.len) fail(source, `${p}.data.min_bytes exceeds data.len`);
  }
  let capacity: QuantityRange | undefined;
  if (Object.hasOwn(item, "capacity")) {
    const table = asObject(item.capacity, `${p}.capacity`, source);
    exactKeys(table, ["eq", "gte", "lte"], `${p}.capacity`, source);
    capacity = quantityRange(table, `${p}.capacity`, source, "ckb");
  }
  const properties = data !== undefined || capacity !== undefined;
  let count: CountRange;
  if (Object.hasOwn(item, "count")) {
    count = parseCountRange(item.count, `${p}.count`, source);
    if (properties && (count.eq === 0 || count.lte === 0)) {
      fail(source, `${p}.count zero is incompatible with per-Cell property checks; assert absence in a separate claim`);
    }
    if (properties && count.eq === undefined && count.gte === undefined) count = { ...count, gte: 1 }; // no vacuous success
  } else if (properties) {
    count = { gte: 1 };
  } else {
    fail(source, `${p} requires at least one of count, data, capacity`);
  }
  if (selector.outPoint !== undefined && ((count.eq ?? 0) > 1 || (count.gte ?? 0) > 1)) fail(source, `${p}.count: an out_point selects at most one Cell`);
  return { kind: "cell", selector, count, ...(data === undefined ? {} : { data }), ...(capacity === undefined ? {} : { capacity }) };
}

function parseBalance(raw: unknown, p: string, accounts: number, source: string): BalanceAssertionV5 {
  const item = asObject(raw, p, source);
  exactKeys(item, ["account", "address", "lock", "udt", "eq", "gte", "lte"], p, source);
  const targets = ["account", "address", "lock"].filter((key) => Object.hasOwn(item, key));
  if (targets.length !== 1) fail(source, `${p} requires exactly one target: account, address, or lock`);
  let target: BalanceAssertionV5["target"];
  if (targets[0] === "account") {
    const index = integer(item.account, 0, 19, `${p}.account`, source);
    if (index >= accounts) fail(source, `${p}.account must be below setup.accounts (${accounts})`);
    target = { kind: "account", index };
  } else if (targets[0] === "address") {
    const address = requiredString(item.address, `${p}.address`, source);
    try {
      const decoded = decodeFullAddress(address);
      target = { kind: "address", address, lock: { codeHash: decoded.codeHash, hashType: decoded.hashType, args: decoded.args } };
    } catch (error) { fail(source, `${p}.address is not a full-format bech32m CKB address: ${error instanceof Error ? error.message : String(error)}`); }
  } else {
    const script = parseScriptRef(item.lock, `${p}.lock`, source, { allowAccount: true, allowWildcard: false });
    if (script.kind === "account" && script.index >= accounts) fail(source, `${p}.lock.account must be below setup.accounts (${accounts})`);
    target = { kind: "lock", script };
  }
  let udt: BalanceAssertionV5["udt"];
  if (Object.hasOwn(item, "udt")) {
    const table = asObject(item.udt, `${p}.udt`, source);
    exactKeys(table, ["type"], `${p}.udt`, source);
    udt = { type: parseScriptRef(table.type, `${p}.udt.type`, source, { allowAccount: false, allowWildcard: false }) };
  }
  const amounts: TomlObject = {};
  for (const key of ["eq", "gte", "lte"]) if (Object.hasOwn(item, key)) amounts[key] = item[key];
  const amount = quantityRange(amounts, p, source, udt === undefined ? "ckb" : "udt");
  return { kind: "balance", target, ...(udt === undefined ? {} : { udt }), amount };
}

export function parseAssertionsV5(accounts: number): (value: unknown, path: string, names: ReadonlySet<string>, source: string) => ClaimV5[] {
  return (value, path, names, source) => {
    if (value === undefined) return [];
    const container = asObject(value, path, source);
    exactKeys(container, ["cell", "cell_deps", "balance"], path, source);
    const claims: ClaimV5[] = [];
    const cells = container.cell ?? [];
    if (!Array.isArray(cells)) fail(source, `${path}.cell must be an array of tables`);
    cells.forEach((raw, i) => claims.push(parseCell(raw, `${path}.cell[${i}]`, names, accounts, source)));
    const deps = container.cell_deps ?? [];
    if (!Array.isArray(deps)) fail(source, `${path}.cell_deps must be an array of tables`);
    deps.forEach((raw, i) => {
      const p = `${path}.cell_deps[${i}]`, d = asObject(raw, p, source);
      exactKeys(d, ["step", "contains"], p, source);
      const step = requiredString(d.step, `${p}.step`, source);
      if (!names.has(step)) fail(source, `${p}.step must reference this or an earlier step`);
      const contains = asObject(d.contains, `${p}.contains`, source);
      exactKeys(contains, ["builtin"], `${p}.contains`, source);
      const name = contains.builtin;
      if (typeof name !== "string" || !(SYSTEM_SCRIPT_NAMES as readonly string[]).includes(name)) {
        fail(source, `${p}.contains.builtin must be one of the OffCKB system scripts: ${SYSTEM_SCRIPT_NAMES.join(", ")}`);
      }
      claims.push({ kind: "cell_deps", step, contains: { kind: "builtin", name: name as SystemScriptName } });
    });
    const balances = container.balance ?? [];
    if (!Array.isArray(balances)) fail(source, `${path}.balance must be an array of tables`);
    balances.forEach((raw, i) => claims.push(parseBalance(raw, `${path}.balance[${i}]`, accounts, source)));
    return claims;
  };
}
