// 0.1.0-draft.5 claims: evaluation inputs are retained raw (get_live_cell and indexer get_cells pages),
// script references are resolved against the recorded environment, and every observation, truth
// value, and the verdict are re-derived from those raw inputs. Same closure rules as cell-claims.ts.
import { hashCkb } from "@ckb-ccc/core";
import { canonicalize } from "json-canonicalize";
import { decodeFullAddress } from "./address";
import { sha256Bytes } from "./canonical";
import {
  bindingDeps, bytes, equalSemantic, exact, hash32, list, object, quantity, retainedMembers, validateBinding,
  validateLiveCellResponse, validateOutput, validateScript, validateTransaction,
  type HashType, type LiveCellResponse, type OutputV4, type ScriptV4,
} from "./cell-claims";
import { INDEXER_PAGE_LIMIT, MAX_SELECTED_CELLS } from "./limits";
import { parseManifestText } from "./manifest";
import type { ResolvedSystemScript } from "./offckb";
import type { CkbJsonRpcTransaction } from "./rpc";
import type { RejectionEvidence, StepEvidence } from "./report";
import { transactionHash } from "./transaction";
import {
  isManifestV5, type V01Spec, type BalanceAssertionV5, type BalanceTarget, type CellAssertionV5, type ClaimV5, type CountRange,
  type CyclesCheck, type ManifestV5, type QuantityRange, type ScriptRef, type ScriptHashType,
} from "./types";

export const OUTCOME_V3 = "ckb-verify-outcome/3" as const;
/** Manifest specs written with the draft.5 grammar: the draft identifier and the frozen `0.1.0`. */
export const SPECS_V5: readonly V01Spec[] = ["0.1.0-draft.5", "0.1.0"];

// ---- raw inputs ----
export interface IndexerSearchKey {
  script: ScriptV4;
  script_type: "lock" | "type";
  script_search_mode: "exact" | "prefix";
  filter?: { script: ScriptV4 };
  with_data: boolean;
}
export interface IndexerCell {
  output: OutputV4;
  output_data: string | null;
  out_point: { tx_hash: string; index: string };
  block_number: string;
  tx_index: string;
}
export interface IndexerPage { after_cursor: string | null; response: { objects: IndexerCell[]; last_cursor: string } }
export interface IndexerInput { kind: "indexer"; search_key: IndexerSearchKey; pages: IndexerPage[] }
export type CellInputV3 =
  | { kind: "missing-output" }
  | { kind: "query"; outPoint: { tx_hash: string; index: string }; response: LiveCellResponse }
  | IndexerInput;

// ---- definitions, observations, outcomes ----
export interface PublicAccount { index: number; address: string; lock: { codeHash: string; hashType: ScriptHashType; args: string } }
export interface CellDefinitionV3 {
  kind: "cell";
  target: { outPoint?: { step: string; index: number }; lock?: ScriptRef; type?: ScriptRef };
  expected: { count: CountRange; data?: { eq?: string; len?: number; minBytes?: number }; capacity?: QuantityRange };
}
export interface CellDepsDefinitionV3 { kind: "cell_deps"; target: { step: string }; expected: { contains: { kind: "builtin"; name: string } } }
export interface BalanceDefinitionV3 { kind: "balance"; target: BalanceTarget; expected: { udt?: { type: ScriptRef }; amount: QuantityRange } }
export type ClaimDefinitionV3 = CellDefinitionV3 | CellDepsDefinitionV3 | BalanceDefinitionV3;
export interface SelectedCell { outPoint: { txHash: string; index: number }; capacity: string; dataBytes: number | null; dataHash: string | null }
export type CellObservationV3 =
  | { state: "missing-output"; count: 0 }
  | { state: "non-live"; status: "dead" | "unknown"; count: 0 }
  | { state: "selected"; count: number; cells: SelectedCell[] };
export interface CellOutcomeV3 extends CellDefinitionV3 { observed: CellObservationV3; observationValid: boolean; ok: boolean }
export interface CellDepsOutcomeV3 extends CellDepsDefinitionV3 { observed: { present: boolean[] }; observationValid: true; ok: boolean }
export interface BalanceOutcomeV3 extends BalanceDefinitionV3 {
  observed: { cells: number; total: string | null; malformed: Array<{ txHash: string; index: number }> };
  observationValid: boolean;
  ok: boolean;
}
export type ClaimOutcomeV3 = CellOutcomeV3 | CellDepsOutcomeV3 | BalanceOutcomeV3;
export type ClaimInputV3 = (CellDefinitionV3 & { input: CellInputV3 }) | CellDepsDefinitionV3 | (BalanceDefinitionV3 & { input: IndexerInput });
export type ClaimEvidenceV3 = (CellOutcomeV3 & { input: CellInputV3 }) | CellDepsOutcomeV3 | (BalanceOutcomeV3 & { input: IndexerInput });
export interface StepOutcomeV3 {
  name: string;
  expectedStatus?: "committed" | "rejected";
  expectedErrorCode?: number;
  expectedCycles?: CyclesCheck;
  observedStatus: "committed" | "rejected";
  cycles?: number;
  rejection?: RejectionEvidence;
  claims: ClaimOutcomeV3[];
}
export type StepInputV3 = Omit<StepEvidence, "claims" | "transactionHash"> & {
  transactionHash: string; transaction: CkbJsonRpcTransaction; claims: ClaimInputV3[];
};
export interface RunInputV3 { name: string; spec: V01Spec; manifestText: string; steps: StepInputV3[]; assertions: ClaimInputV3[] }
export interface RunEvidenceV3 extends Omit<RunInputV3, "steps" | "assertions"> {
  steps: Array<Omit<StepInputV3, "claims"> & { claims: ClaimEvidenceV3[] }>;
  assertions: ClaimEvidenceV3[];
}
export interface OutcomeV3 { schema: typeof OUTCOME_V3; name: string; spec: V01Spec; steps: StepOutcomeV3[]; assertions: ClaimOutcomeV3[] }

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
const EMPTY_HASH = `0x${"00".repeat(32)}`;
const dataHashOf = (content: string): string => (content === "0x" ? EMPTY_HASH : hashCkb(Buffer.from(content.slice(2), "hex")));
const byteLength = (hex: string): number => (hex.length - 2) / 2;
const u32Index = (hex: string): number => Number.parseInt(hex.slice(2), 16);

export function claimDefinitionV3(claim: ClaimV5): ClaimDefinitionV3 {
  if (claim.kind === "cell_deps") return { kind: "cell_deps", target: { step: claim.step }, expected: { contains: claim.contains } };
  if (claim.kind === "balance") return { kind: "balance", target: claim.target, expected: { ...(claim.udt === undefined ? {} : { udt: claim.udt }), amount: claim.amount } };
  return { kind: "cell", target: { ...claim.selector }, expected: { count: claim.count, ...(claim.data === undefined ? {} : { data: claim.data }), ...(claim.capacity === undefined ? {} : { capacity: claim.capacity }) } };
}

/** The environment members a draft.5 claim may resolve references against. */
export interface ResolutionContext {
  systemScript(name: string): ResolvedSystemScript;
  account(index: number): PublicAccount;
}
export interface ResolvedScript { code_hash: string; hash_type: HashType; args: string | null }

export function resolveScriptRef(ref: ScriptRef, context: ResolutionContext): ResolvedScript {
  if (ref.kind === "explicit") return { code_hash: ref.codeHash, hash_type: ref.hashType, args: ref.args };
  if (ref.kind === "builtin") { const b = context.systemScript(ref.name); return { code_hash: b.codeHash, hash_type: b.hashType, args: ref.args }; }
  const lock = context.account(ref.index).lock;
  return { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args };
}
function resolveBalanceLock(target: BalanceTarget, context: ResolutionContext): ScriptV4 {
  if (target.kind === "account") { const lock = context.account(target.index).lock; return { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args }; }
  if (target.kind === "address") {
    const decoded = decodeFullAddress(target.address);
    equalSemantic({ codeHash: decoded.codeHash, hashType: decoded.hashType, args: decoded.args }, target.lock, "balance.target.lock");
    return { code_hash: target.lock.codeHash, hash_type: target.lock.hashType, args: target.lock.args };
  }
  const resolved = resolveScriptRef(target.script, context);
  if (resolved.args === null) fail("balance.target.lock", "wildcard args are not a balance target");
  return { code_hash: resolved.code_hash, hash_type: resolved.hash_type, args: resolved.args };
}
const matches = (actual: ScriptV4 | null | undefined, expected: ResolvedScript): boolean =>
  actual != null && actual.code_hash === expected.code_hash && actual.hash_type === expected.hash_type &&
  (expected.args === null || actual.args === expected.args);

/** The indexer query a script-filtered Cell claim or a balance claim must have issued. */
export function expectedSearchKey(definition: CellDefinitionV3 | BalanceDefinitionV3, context: ResolutionContext): IndexerSearchKey {
  if (definition.kind === "balance") {
    const lock = resolveBalanceLock(definition.target, context);
    const udt = definition.expected.udt;
    const key: IndexerSearchKey = { script: lock, script_type: "lock", script_search_mode: "exact", with_data: udt !== undefined };
    if (udt !== undefined) {
      const type = resolveScriptRef(udt.type, context);
      if (type.args === null) fail("balance.expected.udt.type", "wildcard args are not a UDT identity");
      key.filter = { script: { code_hash: type.code_hash, hash_type: type.hash_type, args: type.args } };
    }
    return key;
  }
  const { lock, type } = definition.target;
  const primaryRef = lock ?? type;
  if (primaryRef === undefined) fail("cell.target", "an indexer query requires a lock or type selector");
  const primary = resolveScriptRef(primaryRef, context);
  const key: IndexerSearchKey = {
    script: { code_hash: primary.code_hash, hash_type: primary.hash_type, args: primary.args ?? "0x" },
    script_type: lock !== undefined ? "lock" : "type",
    script_search_mode: primary.args === null ? "prefix" : "exact",
    with_data: definition.expected.data !== undefined,
  };
  const secondaryRef = lock !== undefined ? type : undefined;
  if (secondaryRef !== undefined) {
    const secondary = resolveScriptRef(secondaryRef, context);
    key.filter = { script: { code_hash: secondary.code_hash, hash_type: secondary.hash_type, args: secondary.args ?? "0x" } };
  }
  return key;
}

// ---- raw input validation ----
function validateSearchKey(value: unknown, path: string): IndexerSearchKey {
  const k = object(value, path); exact(k, ["script", "script_type", "script_search_mode", "with_data"], ["filter"], path);
  if (k.script_type !== "lock" && k.script_type !== "type") fail(`${path}.script_type`, "must be lock or type");
  if (k.script_search_mode !== "exact" && k.script_search_mode !== "prefix") fail(`${path}.script_search_mode`, "must be exact or prefix");
  if (typeof k.with_data !== "boolean") fail(`${path}.with_data`, "must be boolean");
  const key: IndexerSearchKey = { script: validateScript(k.script, `${path}.script`), script_type: k.script_type, script_search_mode: k.script_search_mode, with_data: k.with_data };
  if (Object.hasOwn(k, "filter")) {
    const f = object(k.filter, `${path}.filter`); exact(f, ["script"], [], `${path}.filter`);
    key.filter = { script: validateScript(f.script, `${path}.filter.script`) };
  }
  return key;
}
function validateIndexerCell(value: unknown, path: string, withData: boolean): IndexerCell {
  const c = object(value, path); exact(c, ["output", "output_data", "out_point", "block_number", "tx_index"], [], path);
  const out = object(c.out_point, `${path}.out_point`); exact(out, ["tx_hash", "index"], [], `${path}.out_point`);
  const cell: IndexerCell = {
    output: validateOutput(c.output, `${path}.output`),
    output_data: c.output_data === null ? null : bytes(c.output_data, `${path}.output_data`),
    out_point: { tx_hash: hash32(out.tx_hash, `${path}.out_point.tx_hash`), index: quantity(out.index, 8, `${path}.out_point.index`) },
    block_number: quantity(c.block_number, 16, `${path}.block_number`),
    tx_index: quantity(c.tx_index, 8, `${path}.tx_index`),
  };
  if (withData !== (cell.output_data !== null)) fail(`${path}.output_data`, withData ? "must be present when with_data" : "must be null without with_data");
  return cell;
}
export function validateIndexerInput(value: unknown, path: string): IndexerInput {
  const i = object(value, path); exact(i, ["kind", "search_key", "pages"], [], path);
  if (i.kind !== "indexer") fail(`${path}.kind`, "must be indexer");
  const search_key = validateSearchKey(i.search_key, `${path}.search_key`);
  const pages = list(i.pages, `${path}.pages`).map((raw, n) => {
    const p = `${path}.pages[${n}]`, page = object(raw, p); exact(page, ["after_cursor", "response"], [], p);
    if (page.after_cursor !== null && (typeof page.after_cursor !== "string" || !/^0x[0-9a-f]*$/.test(page.after_cursor))) fail(`${p}.after_cursor`, "must be null or hex");
    const r = object(page.response, `${p}.response`); exact(r, ["objects", "last_cursor"], [], `${p}.response`);
    if (typeof r.last_cursor !== "string" || !/^0x[0-9a-f]*$/.test(r.last_cursor)) fail(`${p}.response.last_cursor`, "must be hex");
    const objects = list(r.objects, `${p}.response.objects`).map((o, j) => validateIndexerCell(o, `${p}.response.objects[${j}]`, search_key.with_data));
    return { after_cursor: page.after_cursor as string | null, response: { objects, last_cursor: r.last_cursor } };
  });
  if (pages.length === 0) fail(`${path}.pages`, "at least one page is required");
  pages.forEach((page, n) => {
    if (n === 0 ? page.after_cursor !== null : page.after_cursor !== pages[n - 1]!.response.last_cursor) fail(`${path}.pages[${n}].after_cursor`, "must continue the previous page");
    const last = n === pages.length - 1;
    if (!last && page.response.objects.length !== INDEXER_PAGE_LIMIT) fail(`${path}.pages[${n}]`, `a non-final page must carry exactly ${INDEXER_PAGE_LIMIT} objects`);
    if (last && page.response.objects.length >= INDEXER_PAGE_LIMIT) fail(`${path}.pages[${n}]`, `the final page must carry fewer than ${INDEXER_PAGE_LIMIT} objects`);
  });
  const all = pages.flatMap((page) => page.response.objects);
  if (all.length > MAX_SELECTED_CELLS) fail(`${path}.pages`, `more than ${MAX_SELECTED_CELLS} selected Cells`);
  if (new Set(all.map((cell) => canonicalize(cell.out_point))).size !== all.length) fail(`${path}.pages`, "duplicate out_point across pages");
  for (const [j, cell] of all.entries()) {
    const primary = search_key.script_type === "lock" ? cell.output.lock : cell.output.type;
    const ok = primary != null && primary.code_hash === search_key.script.code_hash && primary.hash_type === search_key.script.hash_type &&
      (search_key.script_search_mode === "exact" ? primary.args === search_key.script.args : primary.args.startsWith(search_key.script.args));
    if (!ok) fail(`${path}.pages`, `object ${j} does not match the search key`);
    if (search_key.filter !== undefined) {
      const secondary = search_key.script_type === "lock" ? cell.output.type : cell.output.lock;
      if (secondary == null || secondary.code_hash !== search_key.filter.script.code_hash || secondary.hash_type !== search_key.filter.script.hash_type ||
          !secondary.args.startsWith(search_key.filter.script.args)) fail(`${path}.pages`, `object ${j} does not match the filter`);
    }
    if (cell.output_data !== null) {
      const content = cell.output_data; void content; // length and hash are derived at use
    }
  }
  return { kind: "indexer", search_key, pages };
}

// ---- comparators ----
const inRange = (value: bigint, range: QuantityRange | CountRange): boolean =>
  (range.eq === undefined || value === BigInt(range.eq)) && (range.gte === undefined || value >= BigInt(range.gte)) && (range.lte === undefined || value <= BigInt(range.lte));
export function cyclesSatisfy(check: CyclesCheck, cycles: number | undefined): boolean {
  if (cycles === undefined) return false;
  return (check.eq === undefined || cycles === check.eq) && (check.lt === undefined || cycles < check.lt) &&
    (check.lte === undefined || cycles <= check.lte) && (check.gte === undefined || cycles >= check.gte);
}

// ---- manifest binding ----
export function bindManifestV3(evidence: unknown, environment: unknown): ManifestV5 {
  const e = object(evidence, "evidence"), env = object(environment, "environment");
  retainedMembers(e, ["manifestText", "name", "spec", "steps", "assertions"], "evidence");
  retainedMembers(env, ["provenance", "toolchain"], "environment");
  if (typeof e.manifestText !== "string") fail("evidence.manifestText", "required UTF-8 text");
  const encoded = new TextEncoder().encode(e.manifestText);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== e.manifestText) fail("evidence.manifestText", "not UTF-8 roundtrip");
  const prov = object(env.provenance, "environment.provenance");
  retainedMembers(prov, ["manifest", "replay"], "environment.provenance");
  retainedMembers(object(prov.manifest, "provenance.manifest"), ["sha256"], "provenance.manifest");
  equalSemantic(sha256Bytes(encoded), object(prov.manifest, "provenance.manifest").sha256, "evidence.manifestText hash");
  const m = parseManifestText(e.manifestText, "evidence.manifestText");
  if (!isManifestV5(m)) fail("evidence.manifestText.meta.spec", "requires the draft.5 grammar (0.1.0-draft.5 or 0.1.0)");
  equalSemantic(e.name, m.meta.name, "evidence.name"); equalSemantic(e.spec, m.meta.spec, "evidence.spec");
  const toolchain = object(env.toolchain, "environment.toolchain"), replay = object(prov.replay, "provenance.replay");
  retainedMembers(toolchain, ["requested"], "environment.toolchain");
  retainedMembers(replay, ["declaredDependencies"], "provenance.replay");
  equalSemantic(toolchain.requested, m.toolchain, "environment.toolchain.requested");
  equalSemantic(replay.declaredDependencies, m.replay.dependencies, "provenance.replay.declaredDependencies");
  const steps = list(e.steps, "evidence.steps");
  equalSemantic(steps.map((s, i) => { const step = object(s, `evidence.steps[${i}]`); retainedMembers(step, ["name", "claims"], `evidence.steps[${i}]`); return step.name; }),
    m.steps.map((s) => s.name), "evidence.steps names/order");
  const claims = (value: unknown, definitions: ClaimV5[], path: string) => {
    const actual = list(value, path);
    if (actual.length !== definitions.length) fail(path, "claim count mismatch");
    actual.forEach((raw, i) => {
      const c = object(raw, `${path}[${i}]`);
      retainedMembers(c, ["kind", "target", "expected"], `${path}[${i}]`);
      equalSemantic({ kind: c.kind, target: c.target, expected: c.expected }, claimDefinitionV3(definitions[i]!), `${path}[${i}] definition`);
    });
  };
  steps.forEach((raw, i) => {
    const s = object(raw, `evidence.steps[${i}]`), declared = m.steps[i]!;
    for (const key of ["expectedStatus", "expectedErrorCode", "expectedCycles", "cycles", "rejection"]) if (key in s) retainedMembers(s, [key], `evidence.steps[${i}]`);
    if (Object.hasOwn(s, "expectedStatus") !== (declared.expect !== undefined) ||
        Object.hasOwn(s, "expectedErrorCode") !== (declared.expect?.error?.code !== undefined) ||
        Object.hasOwn(s, "expectedCycles") !== (declared.expect?.cycles !== undefined)) fail(`evidence.steps[${i}]`, "expectation field presence mismatch");
    equalSemantic(s.expectedStatus, declared.expect?.tx, `evidence.steps[${i}].expectedStatus`);
    equalSemantic(s.expectedErrorCode, declared.expect?.error?.code, `evidence.steps[${i}].expectedErrorCode`);
    equalSemantic(s.expectedCycles, declared.expect?.cycles, `evidence.steps[${i}].expectedCycles`);
    claims(s.claims, declared.assertions, `evidence.steps[${i}].claims`);
  });
  claims(e.assertions, m.assertions, "evidence.assertions");
  return m;
}

export function resolutionContextFromEnvironment(environment: unknown): ResolutionContext {
  const env = object(environment, "environment");
  retainedMembers(env, ["devnet"], "environment");
  const devnet = object(env.devnet, "environment.devnet");
  retainedMembers(devnet, ["systemScripts", "accounts"], "environment.devnet");
  const scripts = object(devnet.systemScripts, "environment.devnet.systemScripts");
  const accounts = list(devnet.accounts, "environment.devnet.accounts").map((raw, i) => {
    const p = `environment.devnet.accounts[${i}]`, a = object(raw, p); exact(a, ["index", "address", "lock"], [], p);
    if (a.index !== i) fail(`${p}.index`, "must equal its position");
    if (typeof a.address !== "string") fail(`${p}.address`, "must be a string");
    const lock = object(a.lock, `${p}.lock`); exact(lock, ["codeHash", "hashType", "args"], [], `${p}.lock`);
    const hashType = lock.hashType;
    if (hashType !== "data" && hashType !== "type" && hashType !== "data1" && hashType !== "data2") fail(`${p}.lock.hashType`, "invalid hash type");
    const account: PublicAccount = { index: i, address: a.address, lock: { codeHash: hash32(lock.codeHash, `${p}.lock.codeHash`), hashType, args: bytes(lock.args, `${p}.lock.args`) } };
    const decoded = decodeFullAddress(account.address);
    equalSemantic({ codeHash: decoded.codeHash, hashType: decoded.hashType, args: decoded.args }, account.lock, `${p}.address`);
    return account;
  });
  return {
    systemScript(name) {
      retainedMembers(scripts, [name], "environment.devnet.systemScripts");
      return validateBinding(scripts[name], `environment.devnet.systemScripts.${name}`);
    },
    account(index) {
      const account = accounts[index];
      if (account === undefined) fail(`environment.devnet.accounts[${index}]`, "not exported");
      return account;
    },
  };
}

// ---- derivation ----
export function deriveOutcomeV3(evidence: unknown, environment: unknown): OutcomeV3 {
  const m = bindManifestV3(evidence, environment), e = object(evidence, "evidence");
  const context = resolutionContextFromEnvironment(environment);
  const rawSteps = list(e.steps, "evidence.steps").map((s, i) => object(s, `evidence.steps[${i}]`));
  const transactions = rawSteps.map((s, i) => {
    retainedMembers(s, ["transaction", "transactionHash", "observedStatus"], `evidence.steps[${i}]`);
    const tx = validateTransaction(s.transaction, `evidence.steps[${i}].transaction`);
    equalSemantic(transactionHash(tx), hash32(s.transactionHash, `evidence.steps[${i}].transactionHash`), `evidence.steps[${i}].transactionHash`);
    if (s.observedStatus !== "committed" && s.observedStatus !== "rejected") fail(`evidence.steps[${i}].observedStatus`, "terminal status required");
    return tx;
  });
  const stepIndex = (name: string): number => m.steps.findIndex((s) => s.name === name);

  function selectedFromIndexer(input: IndexerInput, definition: CellDefinitionV3): SelectedCell[] {
    const { lock, type } = definition.target;
    const lockScript = lock === undefined ? undefined : resolveScriptRef(lock, context);
    const typeScript = type === undefined ? undefined : resolveScriptRef(type, context);
    return input.pages.flatMap((page) => page.response.objects)
      .filter((cell) => (lockScript === undefined || matches(cell.output.lock, lockScript)) && (typeScript === undefined || matches(cell.output.type, typeScript)))
      .map((cell) => ({ outPoint: { txHash: cell.out_point.tx_hash, index: u32Index(cell.out_point.index) }, capacity: BigInt(cell.output.capacity).toString(),
        dataBytes: cell.output_data === null ? null : byteLength(cell.output_data), dataHash: cell.output_data === null ? null : dataHashOf(cell.output_data) }));
  }
  function cellOk(definition: CellDefinitionV3, cells: SelectedCell[], rawData: Map<string, string | null>): boolean {
    const { count, data, capacity } = definition.expected;
    if (!inRange(BigInt(cells.length), count)) return false;
    return cells.every((cell) => {
      if (capacity !== undefined && !inRange(BigInt(cell.capacity), capacity)) return false;
      if (data !== undefined) {
        const content = rawData.get(canonicalize(cell.outPoint));
        if (content == null) return false;
        if (data.eq !== undefined && content !== data.eq) return false;
        if (data.len !== undefined && byteLength(content) !== data.len) return false;
        if (data.minBytes !== undefined && byteLength(content) < data.minBytes) return false;
      }
      return true;
    });
  }

  function phase(definitions: ClaimV5[], raw: unknown, path: string): ClaimOutcomeV3[] {
    const snapshots = new Map<string, unknown>();
    return definitions.map((claim, i) => {
      const p = `${path}[${i}]`, c = object(list(raw, path)[i], p);
      const definition = claimDefinitionV3(claim);
      if (definition.kind === "cell_deps") {
        if (Object.hasOwn(c, "input")) fail(`${p}.input`, "not supported for dependency claims");
        const tx = transactions[stepIndex(definition.target.step)]!;
        const binding = context.systemScript(definition.expected.contains.name);
        const members = new Set(tx.cell_deps.map((d) => canonicalize(d)));
        const present = bindingDeps(binding).map((d) => members.has(canonicalize(d)));
        return { ...definition, observed: { present }, observationValid: true, ok: present.every(Boolean) };
      }
      retainedMembers(c, ["input"], p);
      const inputRecord = object(c.input, `${p}.input`);
      if (definition.kind === "balance") {
        const input = validateIndexerInput(inputRecord, `${p}.input`);
        equalSemantic(input.search_key, expectedSearchKey(definition, context), `${p}.input.search_key`);
        const key = canonicalize(input.search_key);
        if (snapshots.has(key)) equalSemantic(input.pages, snapshots.get(key), `${p}.input phase snapshot`); else snapshots.set(key, input.pages);
        const lock = input.search_key.script;
        const cells = input.pages.flatMap((page) => page.response.objects).filter((cell) =>
          cell.output.lock.code_hash === lock.code_hash && cell.output.lock.hash_type === lock.hash_type && cell.output.lock.args === lock.args &&
          (input.search_key.filter === undefined || (cell.output.type != null && cell.output.type.code_hash === input.search_key.filter.script.code_hash &&
            cell.output.type.hash_type === input.search_key.filter.script.hash_type && cell.output.type.args === input.search_key.filter.script.args)));
        const malformed: Array<{ txHash: string; index: number }> = [];
        let total = 0n;
        for (const cell of cells) {
          if (definition.expected.udt === undefined) { total += BigInt(cell.output.capacity); continue; }
          const data = cell.output_data ?? "0x";
          if (byteLength(data) < 16) { malformed.push({ txHash: cell.out_point.tx_hash, index: u32Index(cell.out_point.index) }); continue; }
          total += BigInt(`0x${Buffer.from(data.slice(2, 34), "hex").reverse().toString("hex")}`);
        }
        const valid = malformed.length === 0;
        return { ...definition, observed: { cells: cells.length, total: valid ? total.toString() : null, malformed }, observationValid: valid, ok: valid && inRange(total, definition.expected.amount) };
      }
      // cell
      if (definition.target.outPoint !== undefined) {
        const index = stepIndex(definition.target.outPoint.step), tx = transactions[index]!;
        if (definition.target.outPoint.index >= tx.outputs.length) {
          exact(inputRecord, ["kind"], [], `${p}.input`);
          if (inputRecord.kind !== "missing-output") fail(`${p}.input.kind`, "must be missing-output");
          return { ...definition, observed: { state: "missing-output", count: 0 }, observationValid: false, ok: false };
        }
        exact(inputRecord, ["kind", "outPoint", "response"], [], `${p}.input`);
        if (inputRecord.kind !== "query") fail(`${p}.input.kind`, "must be query");
        const out = object(inputRecord.outPoint, `${p}.input.outPoint`); exact(out, ["tx_hash", "index"], [], `${p}.input.outPoint`);
        equalSemantic({ tx_hash: hash32(out.tx_hash, `${p}.input.outPoint.tx_hash`), index: quantity(out.index, 8, `${p}.input.outPoint.index`) },
          { tx_hash: rawSteps[index]!.transactionHash, index: `0x${definition.target.outPoint.index.toString(16)}` }, `${p}.input.outPoint`);
        const response = validateLiveCellResponse(inputRecord.response, `${p}.input.response`);
        const key = JSON.stringify(definition.target.outPoint);
        if (snapshots.has(key)) equalSemantic(inputRecord.response, snapshots.get(key), `${p}.input phase snapshot`); else snapshots.set(key, inputRecord.response);
        if (response.status !== "live") {
          return { ...definition, observed: { state: "non-live", status: response.status, count: 0 }, observationValid: true, ok: inRange(0n, definition.expected.count) && definition.expected.data === undefined && definition.expected.capacity === undefined };
        }
        if (rawSteps[index]!.observedStatus !== "committed") fail(p, "live Cell requires committed target step");
        const selected = tx.outputs[definition.target.outPoint.index]!;
        equalSemantic({ ...response.cell.output, type: response.cell.output.type ?? null }, { ...selected, type: selected.type ?? null }, `${p}.input.response.cell.output`);
        equalSemantic(response.cell.data.content, tx.outputs_data[definition.target.outPoint.index], `${p}.input.response.cell.data.content`);
        const lockOk = definition.target.lock === undefined || matches(response.cell.output.lock, resolveScriptRef(definition.target.lock, context));
        const typeOk = definition.target.type === undefined || matches(response.cell.output.type, resolveScriptRef(definition.target.type, context));
        const cells: SelectedCell[] = lockOk && typeOk ? [{ outPoint: { txHash: rawSteps[index]!.transactionHash as string, index: definition.target.outPoint.index },
          capacity: BigInt(response.cell.output.capacity).toString(), dataBytes: byteLength(response.cell.data.content), dataHash: response.cell.data.hash }] : [];
        const rawData = new Map(cells.map((cell) => [canonicalize(cell.outPoint), response.cell.data.content]));
        return { ...definition, observed: { state: "selected", count: cells.length, cells }, observationValid: true, ok: cellOk(definition, cells, rawData) };
      }
      const input = validateIndexerInput(inputRecord, `${p}.input`);
      equalSemantic(input.search_key, expectedSearchKey(definition, context), `${p}.input.search_key`);
      const key = canonicalize(input.search_key);
      if (snapshots.has(key)) equalSemantic(input.pages, snapshots.get(key), `${p}.input phase snapshot`); else snapshots.set(key, input.pages);
      const cells = selectedFromIndexer(input, definition);
      const rawData = new Map(input.pages.flatMap((page) => page.response.objects).map((cell) => [canonicalize({ txHash: cell.out_point.tx_hash, index: u32Index(cell.out_point.index) }), cell.output_data] as const));
      return { ...definition, observed: { state: "selected", count: cells.length, cells }, observationValid: true, ok: cellOk(definition, cells, rawData) };
    });
  }
  return { schema: OUTCOME_V3, name: m.meta.name, spec: m.meta.spec,
    steps: rawSteps.map((s, i) => ({ name: m.steps[i]!.name,
      ...(m.steps[i]!.expect === undefined ? {} : { expectedStatus: m.steps[i]!.expect!.tx }),
      ...(m.steps[i]!.expect?.error?.code === undefined ? {} : { expectedErrorCode: m.steps[i]!.expect!.error!.code! }),
      ...(m.steps[i]!.expect?.cycles === undefined ? {} : { expectedCycles: m.steps[i]!.expect!.cycles! }),
      observedStatus: s.observedStatus as "committed" | "rejected",
      ...(s.cycles === undefined ? {} : { cycles: s.cycles as number }),
      ...(s.rejection === undefined ? {} : { rejection: s.rejection as RejectionEvidence }),
      claims: phase(m.steps[i]!.assertions, s.claims, `evidence.steps[${i}].claims`) })),
    assertions: phase(m.assertions, e.assertions, "evidence.assertions") };
}

export function verdictForOutcomeV3(outcome: OutcomeV3): "PASS" | "FAIL" {
  return outcome.steps.every((s) => (s.expectedStatus === undefined || s.expectedStatus === s.observedStatus) &&
    (s.expectedErrorCode === undefined || s.expectedErrorCode === s.rejection?.code) &&
    (s.expectedCycles === undefined || cyclesSatisfy(s.expectedCycles, s.cycles)) && s.claims.every((c) => c.ok)) &&
    outcome.assertions.every((c) => c.ok) ? "PASS" : "FAIL";
}
export function populateEvidenceV3(input: RunInputV3, outcome: OutcomeV3): RunEvidenceV3 {
  const claims = (raw: ClaimInputV3[], derived: ClaimOutcomeV3[]): ClaimEvidenceV3[] => list(raw, "claims").map((c, i) => {
    const d = derived[i]!;
    if (d.kind === "cell_deps" && c.kind === "cell_deps") return d;
    if (d.kind === "cell" && c.kind === "cell") return { ...d, input: c.input };
    if (d.kind === "balance" && c.kind === "balance") return { ...d, input: c.input };
    throw new Error("claim kind mismatch during population");
  });
  return { ...input, steps: list(input.steps, "evidence.steps").map((s, i) => ({ ...s, claims: claims(s.claims, outcome.steps[i]!.claims) })), assertions: claims(input.assertions, outcome.assertions) };
}
export function verifyStoredClaimsV3(evidence: unknown, outcome: OutcomeV3): void {
  const e = object(evidence, "evidence");
  const claims = (raw: unknown, derived: ClaimOutcomeV3[], path: string) => list(raw, path).forEach((v, i) => {
    const c = object(v, `${path}[${i}]`);
    exact(c, ["kind", "target", "expected", "observed", "observationValid", "ok", ...(derived[i]!.kind === "cell_deps" ? [] : ["input"])], [], `${path}[${i}]`);
    const { input, ...stored } = c;
    equalSemantic(stored, derived[i], `${path}[${i}] stored derivation`);
  });
  list(e.steps, "evidence.steps").forEach((s, i) => claims(object(s, "step").claims, outcome.steps[i]!.claims, `evidence.steps[${i}].claims`));
  claims(e.assertions, outcome.assertions, "evidence.assertions");
}
