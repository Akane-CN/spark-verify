import { hashCkb } from "@ckb-ccc/core";
import { canonicalize } from "json-canonicalize";
import { sha256Bytes } from "./canonical";
import { MAX_BYTES, parseManifestText } from "./manifest";
import { isManifestV4, type BuiltinRef, type ClaimV4, type CellAssertionV4, type CellDepsAssertionV4, type TypeCheck, type ManifestV4 } from "./types";
import type { ResolvedSystemScript } from "./offckb";
import type { CkbJsonRpcTransaction } from "./rpc";
import type { RejectionEvidence, StepEvidence } from "./report";
import { transactionHash } from "./transaction";

export type HashType = "data" | "type" | "data1" | "data2";
export interface ScriptV4 { code_hash: string; hash_type: HashType; args: string }
export interface OutputV4 { capacity: string; lock: ScriptV4; type?: ScriptV4 | null }
export interface DepV4 { out_point: { tx_hash: string; index: string }; dep_type: "code" | "dep_group" }
export type LiveCellResponse =
  | { status: "live"; cell: { output: OutputV4; data: { content: string; hash: string } }; block_hash?: string | null }
  | { status: "dead" | "unknown"; cell: null; block_hash?: null };
export type CellInput = { kind: "missing-output" } |
  { kind: "query"; outPoint: { tx_hash: string; index: string }; response: LiveCellResponse };
export type TypeObservation = {
  identity: BuiltinRef | { kind: "raw"; codeHash: string; hashType: HashType };
  argsBytes: number;
};
export type CellObservation =
  | { state: "missing-output"; count: 0 }
  | { state: "non-live"; status: "dead" | "unknown"; count: 0 }
  | { state: "live"; count: 1; type?: TypeObservation | null; dataBytes?: number };
export interface CellOutcomeV2 {
  kind: "cell";
  target: { step: string; index: number };
  expected: { count: 0 | 1; type?: TypeCheck; data?: { minBytes: number } };
  observed: CellObservation;
  observationValid: boolean;
  ok: boolean;
}
export interface CellDepsOutcomeV2 {
  kind: "cell_deps"; target: { step: string }; expected: { contains: BuiltinRef };
  observed: { present: boolean[] }; observationValid: true; ok: boolean;
}
export type ClaimOutcomeV2 = CellOutcomeV2 | CellDepsOutcomeV2;
export type CellDefinitionV2 = Pick<CellOutcomeV2, "kind" | "target" | "expected">;
export type CellDepsDefinitionV2 = Pick<CellDepsOutcomeV2, "kind" | "target" | "expected">;
export type ClaimInputV2 = (CellDefinitionV2 & { input: CellInput }) | CellDepsDefinitionV2;
export type ClaimEvidenceV2 = (CellOutcomeV2 & { input: CellInput }) | CellDepsOutcomeV2;
export type StepInputV2 = Omit<StepEvidence, "claims" | "transactionHash"> & {
  transactionHash: string; transaction: CkbJsonRpcTransaction; claims: ClaimInputV2[];
};
export interface RunInputV2 { name: string; spec: "0.1.0-draft.4"; manifestText: string; steps: StepInputV2[]; assertions: ClaimInputV2[] }
export interface RunEvidenceV2 extends Omit<RunInputV2, "steps" | "assertions"> {
  steps: Array<Omit<StepInputV2, "claims"> & { claims: ClaimEvidenceV2[] }>;
  assertions: ClaimEvidenceV2[];
}
export interface OutcomeV2 {
  schema: "ckb-verify-outcome/2"; name: string; spec: "0.1.0-draft.4";
  steps: Array<Omit<StepEvidence, "claims" | "durationMs" | "transactionHash"> & { claims: ClaimOutcomeV2[] }>;
  assertions: ClaimOutcomeV2[];
}

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
// JSON consults inherited toJSON too. Inspect descriptors, never invoke a hook
// or accessor to decide whether these consumed semantic values are retained.
function retainedSerialization(value: object, path: string): void {
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
    if (descriptor === undefined) continue;
    // The pinned canonicalizer also dispatches non-callable, non-null toJSON
    // values through JSON.stringify rather than sorted canonical members.
    if (!Object.hasOwn(descriptor, "value") || descriptor.value != null) fail(`${path}.toJSON`, "serialization hook not supported");
    return; // Null/undefined data shadows any more distant hook in both serializers.
  }
}
export function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  retainedSerialization(value, path);
  return value as Record<string, unknown>;
}
// Only consumed v2 semantic members are checked here, not legacy diagnostics or
// an arbitrary report object graph. Accessors cannot bind a stable retained value.
export function retainedMembers(value: object, keys: readonly string[], path: string): void {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(`${path}.${key}`, "required own enumerable data member");
    }
  }
}
export function exact(value: Record<string, unknown>, required: string[], optional: string[], path: string): void {
  retainedMembers(value, required, path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) fail(`${path}.${String(key)}`, "not supported");
    retainedMembers(value, [key], path);
  }
}
export function list<T>(value: readonly T[], path: string): T[];
export function list(value: unknown, path: string): unknown[];
export function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  retainedSerialization(value, path);
  // Retained arrays are later hashed by the pinned canonicalizer via forEach.
  // Refuse that dispatch override without reading a getter or invoking a method.
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "forEach");
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value") || descriptor.value !== Array.prototype.forEach) fail(`${path}.forEach`, "canonical iteration override not supported");
    break;
  }
  // map/every skip holes and visit inherited slots. Neither is retained own
  // semantic evidence. Index enumerability is irrelevant to JSON arrays.
  const slots: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) fail(`${path}[${i}]`, "required own data slot");
    slots.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      fail(`${path}.${String(key)}`, "non-index array member not supported");
    }
  }
  // Consume exactly the checked slots, never input map/forEach/iterator/species.
  // No holes are filled and no member is normalized or removed from retained input.
  return slots;
}
function sameShape(actual: unknown, expected: unknown, path: string): boolean {
  // Permitted semantic numeric zeros have the same JSON/RFC 8785 value.
  if (actual === 0 && expected === 0) return true;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return Object.is(actual, expected);
  retainedSerialization(actual, path); retainedSerialization(expected, path);
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual)) { list(actual, path); list(expected, path); }
  const keys = Reflect.ownKeys(actual);
  return keys.length === Reflect.ownKeys(expected).length && keys.every(key => {
    if (typeof key !== "string") return false;
    const a = Object.getOwnPropertyDescriptor(actual, key), b = Object.getOwnPropertyDescriptor(expected, key);
    // JSON retains array indices even when non-enumerable; object members differ.
    return a !== undefined && b !== undefined && Object.hasOwn(a, "value") && Object.hasOwn(b, "value") &&
      (Array.isArray(actual) || (a.enumerable && b.enumerable)) && sameShape(a.value, b.value, `${path}.${key}`);
  });
}
export function equalSemantic(actual: unknown, expected: unknown, path: string): void {
  // Canonical JSON alone drops undefined object members. The in-memory API also
  // preserves exact field presence rather than accepting non-JSON extensions.
  if (!sameShape(actual, expected, path) || canonicalize(actual) !== canonicalize(expected)) fail(path, "semantic mismatch");
}
export function hash32(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) fail(path, "must be lowercase hex32");
  return value;
}
export function bytes(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 2 + MAX_BYTES * 2 || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    fail(path, `must be lowercase even hex bytes bounded by ${MAX_BYTES}`);
  }
  return value;
}
function hashType(value: unknown, path: string): HashType {
  if (value !== "data" && value !== "type" && value !== "data1" && value !== "data2") fail(path, "invalid hash type");
  return value;
}
export function quantity(value: unknown, digits: number, path: string): string {
  if (typeof value !== "string" || value.length > digits + 2 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) fail(path, `must be canonical u${digits * 4} hex quantity`);
  return value;
}
export function validateScript(value: unknown, path = "script"): ScriptV4 {
  const s = object(value, path); exact(s, ["code_hash", "hash_type", "args"], [], path);
  return { code_hash: hash32(s.code_hash, `${path}.code_hash`), hash_type: hashType(s.hash_type, `${path}.hash_type`), args: bytes(s.args, `${path}.args`) };
}
export function validateOutput(value: unknown, path = "output"): OutputV4 {
  const o = object(value, path); exact(o, ["capacity", "lock"], ["type"], path);
  return { capacity: quantity(o.capacity, 16, `${path}.capacity`), lock: validateScript(o.lock, `${path}.lock`),
    ...(Object.hasOwn(o, "type") ? { type: o.type === null ? null : validateScript(o.type, `${path}.type`) } : {}) };
}
function outPoint(value: unknown, path: string): DepV4["out_point"] {
  const p = object(value, path); exact(p, ["tx_hash", "index"], [], path);
  return { tx_hash: hash32(p.tx_hash, `${path}.tx_hash`), index: quantity(p.index, 8, `${path}.index`) };
}
export function validateDep(value: unknown, path = "cell_dep"): DepV4 {
  const d = object(value, path); exact(d, ["out_point", "dep_type"], [], path);
  if (d.dep_type !== "code" && d.dep_type !== "dep_group") fail(`${path}.dep_type`, "must be code or dep_group");
  return { out_point: outPoint(d.out_point, `${path}.out_point`), dep_type: d.dep_type };
}
function uniqueDeps(deps: DepV4[], path: string): void {
  if (new Set(deps.map(d => canonicalize(d))).size !== deps.length) fail(path, "duplicate concrete dependency");
}
export function validateBinding(value: unknown, path = "binding"): ResolvedSystemScript {
  const b = object(value, path); exact(b, ["codeHash", "hashType", "cellDeps"], [], path);
  const cellDeps: ResolvedSystemScript["cellDeps"] = list(b.cellDeps, `${path}.cellDeps`).map((raw, i) => {
    const p = `${path}.cellDeps[${i}]`; const d = object(raw, p); exact(d, ["outPoint", "depType"], [], p);
    const o = object(d.outPoint, `${p}.outPoint`); exact(o, ["txHash", "index"], [], `${p}.outPoint`);
    if (typeof o.index !== "number" || !Number.isSafeInteger(o.index) || o.index < 0 || o.index > 0xffff_ffff) fail(`${p}.outPoint.index`, "must be safe u32");
    if (d.depType !== "code" && d.depType !== "depGroup") fail(`${p}.depType`, "must be code or depGroup");
    return { outPoint: { txHash: hash32(o.txHash, `${p}.outPoint.txHash`), index: o.index }, depType: d.depType };
  });
  if (cellDeps.length === 0) fail(`${path}.cellDeps`, "must be nonempty");
  const binding: ResolvedSystemScript = { codeHash: hash32(b.codeHash, `${path}.codeHash`), hashType: hashType(b.hashType, `${path}.hashType`), cellDeps };
  uniqueDeps(bindingDeps(binding), `${path}.cellDeps`);
  return binding;
}
export function bindingDeps(binding: ResolvedSystemScript): DepV4[] {
  return binding.cellDeps.map(d => ({ out_point: { tx_hash: d.outPoint.txHash, index: `0x${d.outPoint.index.toString(16)}` }, dep_type: d.depType === "depGroup" ? "dep_group" : "code" }));
}
export function validateTransaction(value: unknown, path = "transaction"): CkbJsonRpcTransaction & { outputs: OutputV4[]; outputs_data: string[]; cell_deps: DepV4[] } {
  const t = object(value, path);
  exact(t, ["version", "cell_deps", "header_deps", "inputs", "outputs", "outputs_data", "witnesses"], [], path);
  if (typeof t.version !== "string" || !/^0x[0-9a-f]+$/.test(t.version)) fail(`${path}.version`, "must be hex integer");
  const outputs = list(t.outputs, `${path}.outputs`).map((o, i) => validateOutput(o, `${path}.outputs[${i}]`));
  const data = list(t.outputs_data, `${path}.outputs_data`).map((d, i) => bytes(d, `${path}.outputs_data[${i}]`));
  if (outputs.length !== data.length) fail(path, "outputs/outputs_data alignment mismatch");
  const cell_deps = list(t.cell_deps, `${path}.cell_deps`).map((d, i) => validateDep(d, `${path}.cell_deps[${i}]`));
  uniqueDeps(cell_deps, `${path}.cell_deps`);
  return { version: t.version, outputs, outputs_data: data, cell_deps,
    inputs: list(t.inputs, `${path}.inputs`), header_deps: list(t.header_deps, `${path}.header_deps`), witnesses: list(t.witnesses, `${path}.witnesses`) };
}
export function validateLiveCellResponse(value: unknown, path = "get_live_cell"): LiveCellResponse {
  const r = object(value, path); exact(r, ["status", "cell"], ["block_hash"], path);
  if (r.status === "dead" || r.status === "unknown") {
    if (r.cell !== null) fail(`${path}.cell`, "non-live cell must be null");
    if (Object.hasOwn(r, "block_hash") && r.block_hash !== null) fail(`${path}.block_hash`, "non-live block hash must be null");
    return { status: r.status, cell: null, ...(Object.hasOwn(r, "block_hash") ? { block_hash: null } : {}) };
  }
  if (r.status !== "live") fail(`${path}.status`, "must be live, dead or unknown");
  const c = object(r.cell, `${path}.cell`); exact(c, ["output", "data"], [], `${path}.cell`);
  const d = object(c.data, `${path}.cell.data`); exact(d, ["content", "hash"], [], `${path}.cell.data`);
  const content = bytes(d.content, `${path}.cell.data.content`), hash = hash32(d.hash, `${path}.cell.data.hash`);
  const computed = content === "0x" ? `0x${"00".repeat(32)}` : hashCkb(Buffer.from(content.slice(2), "hex"));
  if (hash !== computed) fail(`${path}.cell.data.hash`, "content hash mismatch");
  return { status: "live", cell: { output: validateOutput(c.output, `${path}.cell.output`), data: { content, hash } },
    ...(Object.hasOwn(r, "block_hash") ? { block_hash: r.block_hash === null ? null : hash32(r.block_hash, `${path}.block_hash`) } : {}) };
}
export function claimDefinition(claim: CellAssertionV4): CellDefinitionV2;
export function claimDefinition(claim: CellDepsAssertionV4): CellDepsDefinitionV2;
export function claimDefinition(claim: ClaimV4): CellDefinitionV2 | CellDepsDefinitionV2;
export function claimDefinition(claim: ClaimV4): CellDefinitionV2 | CellDepsDefinitionV2 {
  if (claim.kind === "cell_deps") return { kind: "cell_deps", target: { step: claim.step }, expected: { contains: claim.contains } };
  return { kind: "cell", target: claim.outPoint, expected: { count: claim.count, ...(claim.type === undefined ? {} : { type: claim.type }), ...(claim.data === undefined ? {} : { data: claim.data }) } };
}

/** Bind duplicated declarations before any provenance/replay interpretation. */
export function bindManifestV2(evidence: unknown, environment: unknown): ManifestV4 {
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
  if (!isManifestV4(m)) fail("evidence.manifestText.meta.spec", "requires draft.4");
  equalSemantic(e.name, m.meta.name, "evidence.name"); equalSemantic(e.spec, m.meta.spec, "evidence.spec");
  const toolchain = object(env.toolchain, "environment.toolchain"), replay = object(prov.replay, "provenance.replay");
  retainedMembers(toolchain, ["requested"], "environment.toolchain");
  retainedMembers(replay, ["declaredDependencies"], "provenance.replay");
  equalSemantic(toolchain.requested, m.toolchain, "environment.toolchain.requested");
  equalSemantic(replay.declaredDependencies, m.replay.dependencies, "provenance.replay.declaredDependencies");
  const steps = list(e.steps, "evidence.steps");
  equalSemantic(steps.map((s, i) => {
    const step = object(s, `evidence.steps[${i}]`);
    retainedMembers(step, ["name", "claims"], `evidence.steps[${i}]`);
    return step.name;
  }), m.steps.map(s => s.name), "evidence.steps names/order");
  const claims = (value: unknown, definitions: ClaimV4[], path: string) => {
    const actual = list(value, path);
    if (actual.length !== definitions.length) fail(path, "claim count mismatch");
    actual.forEach((raw, i) => {
      const c = object(raw, `${path}[${i}]`);
      retainedMembers(c, ["kind", "target", "expected"], `${path}[${i}]`);
      equalSemantic({ kind: c.kind, target: c.target, expected: c.expected }, claimDefinition(definitions[i]!), `${path}[${i}] definition`);
    });
  };
  steps.forEach((raw, i) => {
    const s = object(raw, `evidence.steps[${i}]`), declared = m.steps[i]!;
    for (const key of ["expectedStatus", "expectedErrorCode", "cycles", "rejection"]) {
      if (key in s) retainedMembers(s, [key], `evidence.steps[${i}]`);
    }
    if (Object.hasOwn(s, "expectedStatus") !== (declared.expect !== undefined) ||
        Object.hasOwn(s, "expectedErrorCode") !== (declared.expect?.error?.code !== undefined)) fail(`evidence.steps[${i}]`, "expectation field presence mismatch");
    equalSemantic(s.expectedStatus, declared.expect?.tx, `evidence.steps[${i}].expectedStatus`);
    equalSemantic(s.expectedErrorCode, declared.expect?.error?.code, `evidence.steps[${i}].expectedErrorCode`);
    claims(s.claims, declared.assertions, `evidence.steps[${i}].claims`);
  });
  claims(e.assertions, m.assertions, "evidence.assertions");
  return m;
}

/** Pure raw-input derivation. Stored observations and booleans are never inputs. */
export function deriveOutcomeV2(evidence: unknown, environment: unknown): OutcomeV2 {
  const m = bindManifestV2(evidence, environment), e = object(evidence, "evidence");
  const env = object(environment, "environment");
  retainedMembers(env, ["devnet"], "environment");
  const devnet = object(env.devnet, "environment.devnet");
  retainedMembers(devnet, ["systemScripts"], "environment.devnet");
  const scripts = object(devnet.systemScripts, "environment.devnet.systemScripts");
  const resolveBinding = (name: BuiltinRef["name"]): ResolvedSystemScript => {
    const path = `environment.devnet.systemScripts.${name}`;
    retainedMembers(scripts, [name], "environment.devnet.systemScripts");
    return validateBinding(scripts[name], path);
  };
  const rawSteps = list(e.steps, "evidence.steps").map((s, i) => object(s, `evidence.steps[${i}]`));
  const transactions = rawSteps.map((s, i) => {
    retainedMembers(s, ["transaction", "transactionHash", "observedStatus"], `evidence.steps[${i}]`);
    const tx = validateTransaction(s.transaction, `evidence.steps[${i}].transaction`);
    equalSemantic(transactionHash(tx), hash32(s.transactionHash, `evidence.steps[${i}].transactionHash`), `evidence.steps[${i}].transactionHash`);
    if (s.observedStatus !== "committed" && s.observedStatus !== "rejected") fail(`evidence.steps[${i}].observedStatus`, "terminal status required");
    return tx;
  });
  function phase(definitions: ClaimV4[], raw: unknown, path: string): ClaimOutcomeV2[] {
    const snapshots = new Map<string, unknown>();
    return definitions.map((claim, i) => {
      const p = `${path}[${i}]`, c = object(list(raw, path)[i], p);
      if (claim.kind === "cell_deps") {
        if (Object.hasOwn(c, "input")) fail(`${p}.input`, "not supported for dependency claims");
        const tx = transactions[m.steps.findIndex(s => s.name === claim.step)]!;
        const binding = resolveBinding(claim.contains.name);
        const members = new Set(tx.cell_deps.map(d => canonicalize(d)));
        const present = bindingDeps(binding).map(d => members.has(canonicalize(d)));
        return { ...claimDefinition(claim), observed: { present }, observationValid: true, ok: present.every(Boolean) };
      }
      const definition = claimDefinition(claim);
      const stepIndex = m.steps.findIndex(s => s.name === claim.outPoint.step), tx = transactions[stepIndex]!;
      const binding = claim.type === undefined ? undefined : resolveBinding(claim.type.name);
      retainedMembers(c, ["input"], p);
      const input = object(c.input, `${p}.input`);
      if (claim.outPoint.index >= tx.outputs.length) {
        exact(input, ["kind"], [], `${p}.input`);
        if (input.kind !== "missing-output") fail(`${p}.input.kind`, "must be missing-output");
        return { ...definition, observed: { state: "missing-output", count: 0 }, observationValid: false, ok: false };
      }
      exact(input, ["kind", "outPoint", "response"], [], `${p}.input`);
      if (input.kind !== "query") fail(`${p}.input.kind`, "must be query");
      equalSemantic(outPoint(input.outPoint, `${p}.input.outPoint`), { tx_hash: rawSteps[stepIndex]!.transactionHash, index: `0x${claim.outPoint.index.toString(16)}` }, `${p}.input.outPoint`);
      const response = validateLiveCellResponse(input.response, `${p}.input.response`);
      const key = JSON.stringify(claim.outPoint);
      if (snapshots.has(key)) equalSemantic(input.response, snapshots.get(key), `${p}.input phase snapshot`);
      snapshots.set(key, input.response);
      if (response.status !== "live") {
        return { ...definition, observed: { state: "non-live", status: response.status, count: 0 }, observationValid: true, ok: claim.count === 0 && claim.type === undefined && claim.data === undefined };
      }
      if (rawSteps[stepIndex]!.observedStatus !== "committed") fail(p, "live Cell requires committed target step");
      const selected = tx.outputs[claim.outPoint.index]!;
      equalSemantic({ ...response.cell.output, type: response.cell.output.type ?? null }, { ...selected, type: selected.type ?? null }, `${p}.input.response.cell.output`);
      equalSemantic(response.cell.data.content, tx.outputs_data[claim.outPoint.index], `${p}.input.response.cell.data.content`);
      let type: TypeObservation | null | undefined;
      let typeMatches = true;
      if (claim.type !== undefined && binding !== undefined) {
        const actual = response.cell.output.type;
        if (actual == null) { type = null; typeMatches = false; }
        else {
          const matches = actual.code_hash === binding.codeHash && actual.hash_type === binding.hashType;
          type = { identity: matches ? { kind: "builtin", name: claim.type.name } : { kind: "raw", codeHash: actual.code_hash, hashType: actual.hash_type }, argsBytes: (actual.args.length - 2) / 2 };
          typeMatches = matches && type.argsBytes === claim.type.argsBytes;
        }
      }
      const dataBytes = (response.cell.data.content.length - 2) / 2;
      return { ...definition, observed: { state: "live", count: 1, ...(type === undefined ? {} : { type }), ...(claim.data === undefined ? {} : { dataBytes }) },
        observationValid: true, ok: claim.count === 1 && typeMatches && (claim.data === undefined || dataBytes >= claim.data.minBytes) };
    });
  }
  return { schema: "ckb-verify-outcome/2", name: m.meta.name, spec: m.meta.spec,
    steps: rawSteps.map((s, i) => ({ name: m.steps[i]!.name,
      ...(m.steps[i]!.expect === undefined ? {} : { expectedStatus: m.steps[i]!.expect!.tx }),
      ...(m.steps[i]!.expect?.error?.code === undefined ? {} : { expectedErrorCode: m.steps[i]!.expect!.error!.code! }),
      observedStatus: s.observedStatus as "committed" | "rejected",
      ...(s.cycles === undefined ? {} : { cycles: s.cycles as number }),
      ...(s.rejection === undefined ? {} : { rejection: s.rejection as RejectionEvidence }),
      claims: phase(m.steps[i]!.assertions, s.claims, `evidence.steps[${i}].claims`) })),
    assertions: phase(m.assertions, e.assertions, "evidence.assertions") };
}
export function verdictForOutcomeV2(outcome: OutcomeV2): "PASS" | "FAIL" {
  return outcome.steps.every(s => (s.expectedStatus === undefined || s.expectedStatus === s.observedStatus) &&
    (s.expectedErrorCode === undefined || s.expectedErrorCode === s.rejection?.code) && s.claims.every(c => c.ok)) && outcome.assertions.every(c => c.ok) ? "PASS" : "FAIL";
}
export function populateEvidenceV2(input: RunInputV2, outcome: OutcomeV2): RunEvidenceV2 {
  const claims = (raw: ClaimInputV2[], derived: ClaimOutcomeV2[]): ClaimEvidenceV2[] => list(raw, "claims").map((c, i) => {
    const d = derived[i]!;
    if (d.kind === "cell_deps" && c.kind === "cell_deps") return d;
    if (d.kind === "cell" && c.kind === "cell") return { ...d, input: c.input };
    throw new Error("claim kind mismatch during population");
  });
  return { ...input, steps: list(input.steps, "evidence.steps").map((s, i) => ({ ...s, claims: claims(s.claims, outcome.steps[i]!.claims) })), assertions: claims(input.assertions, outcome.assertions) };
}
export function verifyStoredClaimsV2(evidence: unknown, outcome: OutcomeV2): void {
  const e = object(evidence, "evidence");
  const claims = (raw: unknown, derived: ClaimOutcomeV2[], path: string) => list(raw, path).forEach((v, i) => {
    const c = object(v, `${path}[${i}]`);
    exact(c, ["kind", "target", "expected", "observed", "observationValid", "ok", ...(derived[i]!.kind === "cell" ? ["input"] : [])], [], `${path}[${i}]`);
    const { input, ...stored } = c;
    equalSemantic(stored, derived[i], `${path}[${i}] stored derivation`);
  });
  list(e.steps, "evidence.steps").forEach((s, i) => claims(object(s, "step").claims, outcome.steps[i]!.claims, `evidence.steps[${i}].claims`));
  claims(e.assertions, outcome.assertions, "evidence.assertions");
}
