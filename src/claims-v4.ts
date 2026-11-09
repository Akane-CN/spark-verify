// Spec 0.2.0 claims (outcome/4 inside report/4 + environment/5). Everything is re-derived from retained
// raw inputs exactly as for 0.1.0 (the per-phase claim derivation is shared with claims-v3), plus:
// - setup: repository binaries deployed by the runner and built-in aliases, with each deployed binary's
//   hash in the outcome and its code Cell checked against the recorded deployment;
// - pure steps, which produce no transaction and only check state;
// - `expect.error.group`, satisfied only by script evidence from the named lock/type group, and refused
//   when the retained transaction shows that the reference matches more than one group;
// - terminal node rejections from `send_transaction`, recorded with their RPC code.
import { canonicalize } from "json-canonicalize";
import { sha256Bytes } from "./canonical";
import {
  equalSemantic, exact, hash32, list, object, quantity, retainedMembers, validateBinding, validateLiveCellResponse, validateScript,
  validateTransaction, type LiveCellResponse, type ScriptV4,
} from "./cell-claims";
import {
  claimDefinitionV3, cyclesSatisfy, derivePhaseV3, resolutionContextFromEnvironment, resolveScriptRef,
  type ClaimEvidenceV3, type ClaimInputV3, type ClaimOutcomeV3, type PhaseContext, type ResolutionContext,
} from "./claims-v3";
import { parseManifestText } from "./manifest";
import type { ResolvedSystemScript } from "./offckb";
import type { CkbJsonRpcTransaction } from "./rpc";
import type { RejectionEvidence } from "./report";
import { assertRejectionEvidence, errorCodeSatisfied } from "./rejection";
import { scriptHash, transactionHash } from "./transaction";
import {
  isManifestV6, type ClaimV5, type CyclesCheck, type ErrorGroupExpectation, type ManifestV6, type ScriptHashType, type SetupScript, type SystemScriptName,
} from "./types";

export const OUTCOME_V4 = "ckb-verify-outcome/4" as const;
export const SPEC_V6 = "0.2.0" as const;
/** The CKB Type ID system script (RFC 0022): `code_hash` is "TYPE_ID" right-aligned, `hash_type = type`. */
export const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";
/**
 * `send_transaction` RPC errors that are terminal node rejections of the transaction itself (CKB 0.209
 * `rpc/src/error.rs`): failed to resolve (dead/unknown inputs or deps), failed to verify, outputs validator,
 * ill-formed transaction, minimum fee rate, malformed, size limit. Pool state and transport errors
 * (pool full, duplicate, expired, RBF, ancestors limit, invalidated, internal) are never a verdict.
 */
export const TERMINAL_NODE_REJECTION_CODES: readonly number[] = [-301, -302, -1102, -1103, -1104, -1108, -1110];

// ---- environment/5 deployment records ----
export interface DeployedBinaryScript {
  name: string; kind: "binary"; path: string; size: number; binarySha256: string; dataHash: string;
  hashType: ScriptHashType; codeHash: string;
  cellDep: { outPoint: { txHash: string; index: number }; depType: "code" };
  typeId: { script: { codeHash: string; hashType: "type"; args: string }; scriptHash: string } | null;
  /** The code Cell as the node returned it after deployment (data content omitted, its hash kept). */
  deployment: { output: { capacity: string; lock: ScriptV4; type: ScriptV4 | null }; dataHash: string };
}
export interface BuiltinAliasScript { name: string; kind: "builtin"; builtin: SystemScriptName; codeHash: string; hashType: ScriptHashType; cellDeps: ResolvedSystemScript["cellDeps"] }
export type SetupScriptRecord = DeployedBinaryScript | BuiltinAliasScript;

// ---- outcome/4 ----
export type SetupScriptOutcome =
  | { name: string; kind: "binary"; hashType: ScriptHashType; codeHash: string; binarySha256: string; dataHash: string }
  | { name: string; kind: "builtin"; builtin: SystemScriptName; hashType: ScriptHashType; codeHash: string };
export interface TransactionStepOutcomeV4 {
  name: string; kind: "transaction";
  expectedStatus: "committed" | "rejected";
  expectedErrorCode?: number;
  /** The declared group plus its resolved script, so the verdict is a function of the outcome alone. */
  expectedErrorGroup?: ErrorGroupExpectation & { resolved: { codeHash: string; hashType: ScriptHashType; args: string | null } };
  expectedCycles?: CyclesCheck;
  observedStatus: "committed" | "rejected";
  cycles?: number;
  rejection?: RejectionEvidence;
  claims: ClaimOutcomeV3[];
}
export interface PureStepOutcomeV4 { name: string; kind: "pure"; claims: ClaimOutcomeV3[] }
export type StepOutcomeV4 = TransactionStepOutcomeV4 | PureStepOutcomeV4;
export interface OutcomeV4 {
  schema: typeof OUTCOME_V4; name: string; spec: typeof SPEC_V6;
  setup: { accounts: number; scripts: SetupScriptOutcome[] };
  steps: StepOutcomeV4[]; assertions: ClaimOutcomeV3[];
}

// ---- run input / evidence ----
export interface InputCellRecord { outPoint: { tx_hash: string; index: string }; response: LiveCellResponse }
export interface TransactionStepInputV4 {
  name: string; kind: "transaction";
  expectedStatus: "committed" | "rejected"; expectedErrorCode?: number; expectedErrorGroup?: ErrorGroupExpectation; expectedCycles?: CyclesCheck;
  observedStatus: "committed" | "rejected"; cycles?: number; rejection?: RejectionEvidence;
  /** Every consumed Cell, retained for a script rejection: the group check and the input script need them. */
  inputCells?: InputCellRecord[];
  transactionHash: string; transaction: CkbJsonRpcTransaction; durationMs: number; claims: ClaimInputV3[];
}
export interface PureStepInputV4 { name: string; kind: "pure"; durationMs: number; claims: ClaimInputV3[] }
export type StepInputV4 = TransactionStepInputV4 | PureStepInputV4;
export interface RunInputV4 { name: string; spec: typeof SPEC_V6; manifestText: string; steps: StepInputV4[]; assertions: ClaimInputV3[] }
export interface RunEvidenceV4 extends Omit<RunInputV4, "steps" | "assertions"> {
  steps: Array<(Omit<TransactionStepInputV4, "claims"> | Omit<PureStepInputV4, "claims">) & { claims: ClaimEvidenceV3[] }>;
  assertions: ClaimEvidenceV3[];
}

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
const toRpc = (script: { codeHash: string; hashType: string; args: string }): ScriptV4 =>
  ({ code_hash: script.codeHash, hash_type: script.hashType as ScriptV4["hash_type"], args: script.args });

/** Resolves the named setup scripts of a 0.2.0 run against its recorded environment/5. */
export function validateSetupScripts(environment: unknown, manifest: ManifestV6): SetupScriptRecord[] {
  const devnet = object(object(environment, "environment").devnet, "environment.devnet");
  retainedMembers(devnet, ["scripts", "systemScripts"], "environment.devnet");
  const raw = list(devnet.scripts, "environment.devnet.scripts");
  if (raw.length !== manifest.setup.scripts.length) fail("environment.devnet.scripts", `records ${raw.length} scripts; the manifest declares ${manifest.setup.scripts.length}`);
  const systemScripts = object(devnet.systemScripts, "environment.devnet.systemScripts");
  return raw.map((value, i): SetupScriptRecord => {
    const p = `environment.devnet.scripts[${i}]`, r = object(value, p), declared: SetupScript = manifest.setup.scripts[i]!;
    if (r.name !== declared.name || r.kind !== declared.kind) fail(p, `must record setup script ${declared.name} (${declared.kind}) in declaration order`);
    if (declared.kind === "builtin") {
      exact(r, ["name", "kind", "builtin", "codeHash", "hashType", "cellDeps"], [], p);
      equalSemantic(r.builtin, declared.builtin, `${p}.builtin`);
      retainedMembers(systemScripts, [declared.builtin], "environment.devnet.systemScripts");
      const binding = validateBinding(systemScripts[declared.builtin], `environment.devnet.systemScripts.${declared.builtin}`);
      equalSemantic({ codeHash: r.codeHash, hashType: r.hashType, cellDeps: r.cellDeps }, binding, `${p} alias of ${declared.builtin}`);
      return { name: declared.name, kind: "builtin", builtin: declared.builtin, codeHash: binding.codeHash, hashType: binding.hashType, cellDeps: binding.cellDeps };
    }
    exact(r, ["name", "kind", "path", "size", "binarySha256", "dataHash", "hashType", "codeHash", "cellDep", "typeId", "deployment"], [], p);
    equalSemantic(r.path, declared.path, `${p}.path`);
    equalSemantic(r.hashType, declared.hashType, `${p}.hashType`);
    if (typeof r.size !== "number" || !Number.isSafeInteger(r.size) || r.size < 1 || r.size > 500 * 1024) fail(`${p}.size`, "must be 1..512000 bytes");
    if (typeof r.binarySha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r.binarySha256)) fail(`${p}.binarySha256`, "must be a sha256 digest");
    const dataHash = hash32(r.dataHash, `${p}.dataHash`), codeHash = hash32(r.codeHash, `${p}.codeHash`);
    const dep = object(r.cellDep, `${p}.cellDep`); exact(dep, ["outPoint", "depType"], [], `${p}.cellDep`);
    const out = object(dep.outPoint, `${p}.cellDep.outPoint`); exact(out, ["txHash", "index"], [], `${p}.cellDep.outPoint`);
    if (dep.depType !== "code") fail(`${p}.cellDep.depType`, "must be code");
    if (typeof out.index !== "number" || !Number.isSafeInteger(out.index) || out.index < 0) fail(`${p}.cellDep.outPoint.index`, "must be a non-negative integer");
    const cellDep = { outPoint: { txHash: hash32(out.txHash, `${p}.cellDep.outPoint.txHash`), index: out.index }, depType: "code" as const };
    const deployment = object(r.deployment, `${p}.deployment`); exact(deployment, ["output", "dataHash"], [], `${p}.deployment`);
    const output = object(deployment.output, `${p}.deployment.output`); exact(output, ["capacity", "lock", "type"], [], `${p}.deployment.output`);
    const deployed = { capacity: quantity(output.capacity, 16, `${p}.deployment.output.capacity`), lock: validateScript(output.lock, `${p}.deployment.output.lock`),
      type: output.type === null ? null : validateScript(output.type, `${p}.deployment.output.type`) };
    // The code Cell must hold exactly the recorded binary: its data hash is the binary's blake2b data hash.
    equalSemantic(hash32(deployment.dataHash, `${p}.deployment.dataHash`), dataHash, `${p}.deployment.dataHash`);
    if (BigInt(deployed.capacity) < BigInt(r.size) * 100_000_000n) fail(`${p}.deployment.output.capacity`, "cannot hold the recorded binary");
    let typeId: DeployedBinaryScript["typeId"] = null;
    if (declared.hashType === "type") {
      const t = object(r.typeId, `${p}.typeId`); exact(t, ["script", "scriptHash"], [], `${p}.typeId`);
      const s = object(t.script, `${p}.typeId.script`); exact(s, ["codeHash", "hashType", "args"], [], `${p}.typeId.script`);
      if (s.codeHash !== TYPE_ID_CODE_HASH || s.hashType !== "type") fail(`${p}.typeId.script`, "must be the Type ID system script");
      const script = { codeHash: TYPE_ID_CODE_HASH, hashType: "type" as const, args: hash32(s.args, `${p}.typeId.script.args`) };
      const hash = scriptHash(script);
      equalSemantic(t.scriptHash, hash, `${p}.typeId.scriptHash`);
      equalSemantic(codeHash, hash, `${p}.codeHash (a type deployment resolves to its Type ID script hash)`);
      equalSemantic(deployed.type, toRpc(script), `${p}.deployment.output.type`);
      typeId = { script, scriptHash: hash };
    } else {
      if (r.typeId !== null) fail(`${p}.typeId`, "must be null for a data hash type");
      equalSemantic(codeHash, dataHash, `${p}.codeHash (a data deployment resolves to its data hash)`);
    }
    return { name: declared.name, kind: "binary", path: declared.path, size: r.size, binarySha256: r.binarySha256, dataHash, hashType: declared.hashType, codeHash, cellDep, typeId,
      deployment: { output: deployed, dataHash } };
  });
}

export function resolutionContextV4(environment: unknown, scripts: readonly SetupScriptRecord[]): ResolutionContext {
  const base = resolutionContextFromEnvironment(environment);
  const byName = new Map(scripts.map((script) => [script.name, script]));
  return {
    ...base,
    setupScript(name) {
      const script = byName.get(name);
      if (script === undefined) fail(`setup script ${name}`, "not declared");
      return script.kind === "builtin"
        ? { codeHash: script.codeHash, hashType: script.hashType, cellDeps: script.cellDeps }
        : { codeHash: script.codeHash, hashType: script.hashType, cellDeps: [{ outPoint: script.cellDep.outPoint, depType: "code" }] };
    },
  };
}

/** Binds the retained manifest text to every duplicated declaration in the evidence and environment. */
export function bindManifestV4(evidence: unknown, environment: unknown): ManifestV6 {
  const e = object(evidence, "evidence"), env = object(environment, "environment");
  retainedMembers(e, ["manifestText", "name", "spec", "steps", "assertions"], "evidence");
  retainedMembers(env, ["provenance", "toolchain"], "environment");
  if (typeof e.manifestText !== "string") fail("evidence.manifestText", "required UTF-8 text");
  const encoded = new TextEncoder().encode(e.manifestText);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== e.manifestText) fail("evidence.manifestText", "not UTF-8 roundtrip");
  const prov = object(env.provenance, "environment.provenance");
  retainedMembers(prov, ["manifest", "replay"], "environment.provenance");
  const manifestRecord = object(prov.manifest, "provenance.manifest"); retainedMembers(manifestRecord, ["sha256"], "provenance.manifest");
  equalSemantic(sha256Bytes(encoded), manifestRecord.sha256, "evidence.manifestText hash");
  const m = parseManifestText(e.manifestText, "evidence.manifestText");
  if (!isManifestV6(m)) fail("evidence.manifestText.meta.spec", "requires spec 0.2.0");
  equalSemantic(e.name, m.meta.name, "evidence.name"); equalSemantic(e.spec, m.meta.spec, "evidence.spec");
  const toolchain = object(env.toolchain, "environment.toolchain"), replay = object(prov.replay, "provenance.replay");
  retainedMembers(toolchain, ["requested"], "environment.toolchain"); retainedMembers(replay, ["declaredDependencies"], "provenance.replay");
  equalSemantic(toolchain.requested, m.toolchain, "environment.toolchain.requested");
  equalSemantic(replay.declaredDependencies, m.replay.dependencies, "provenance.replay.declaredDependencies");
  const steps = list(e.steps, "evidence.steps");
  if (steps.length !== m.steps.length) fail("evidence.steps", "step count mismatch");
  const claims = (value: unknown, definitions: ClaimV5[], path: string) => {
    const actual = list(value, path);
    if (actual.length !== definitions.length) fail(path, "claim count mismatch");
    actual.forEach((raw, i) => {
      const c = object(raw, `${path}[${i}]`); retainedMembers(c, ["kind", "target", "expected"], `${path}[${i}]`);
      equalSemantic({ kind: c.kind, target: c.target, expected: c.expected }, claimDefinitionV3(definitions[i]!), `${path}[${i}] definition`);
    });
  };
  steps.forEach((raw, i) => {
    const p = `evidence.steps[${i}]`, s = object(raw, p), declared = m.steps[i]!;
    retainedMembers(s, ["name", "kind", "claims"], p);
    equalSemantic(s.name, declared.name, `${p}.name`); equalSemantic(s.kind, declared.kind, `${p}.kind`);
    if (declared.kind === "transaction") {
      const keys = ["expectedErrorCode", "expectedErrorGroup", "expectedCycles"] as const;
      const declaredValues = { expectedErrorCode: declared.expect.error?.code, expectedErrorGroup: declared.expect.error?.group, expectedCycles: declared.expect.cycles };
      for (const key of keys) {
        if (Object.hasOwn(s, key) !== (declaredValues[key] !== undefined)) fail(p, `${key} presence mismatch`);
        if (Object.hasOwn(s, key)) { retainedMembers(s, [key], p); equalSemantic(s[key], declaredValues[key], `${p}.${key}`); }
      }
      retainedMembers(s, ["expectedStatus"], p);
      equalSemantic(s.expectedStatus, declared.expect.tx, `${p}.expectedStatus`);
    }
    claims(s.claims, declared.assertions, `${p}.claims`);
  });
  claims(e.assertions, m.assertions, "evidence.assertions");
  return m;
}

/** Distinct lock or type scripts of a transaction's groups, from the retained inputs and the outputs. */
function groupScripts(role: "lock" | "type", inputs: readonly LiveCellResponse[], tx: ReturnType<typeof validateTransaction>): ScriptV4[] {
  const scripts: ScriptV4[] = [];
  const add = (script: ScriptV4 | null | undefined) => { if (script != null && !scripts.some((s) => canonicalize(s) === canonicalize(script))) scripts.push(script); };
  for (const input of inputs) if (input.status === "live") add(role === "lock" ? input.cell.output.lock : input.cell.output.type);
  if (role === "type") for (const output of tx.outputs) add(output.type);
  return scripts;
}
const scriptMatches = (actual: ScriptV4, expected: { code_hash: string; hash_type: string; args: string | null }): boolean =>
  actual.code_hash === expected.code_hash && actual.hash_type === expected.hash_type && (expected.args === null || actual.args === expected.args);

function validateRejectionV4(s: Record<string, unknown>, tx: ReturnType<typeof validateTransaction>, path: string): LiveCellResponse[] | undefined {
  const rejection = s.rejection === undefined ? undefined : object(s.rejection, `${path}.rejection`);
  if (rejection?.kind === "node" && Object.hasOwn(rejection, "rpcCode")) {
    if (typeof rejection.rpcCode !== "number" || !TERMINAL_NODE_REJECTION_CODES.includes(rejection.rpcCode)) fail(`${path}.rejection.rpcCode`, "is not a terminal node rejection code");
    const { rpcCode: _code, ...rest } = rejection; void _code;
    assertRejectionEvidence({ observedStatus: s.observedStatus, rejection: rest, transaction: s.transaction }, path);
  } else {
    assertRejectionEvidence({ observedStatus: s.observedStatus, rejection: s.rejection, transaction: s.transaction }, path);
  }
  const script = rejection?.kind === "script";
  if (Object.hasOwn(s, "inputCells") !== script) fail(`${path}.inputCells`, script ? "required for a script rejection" : "only recorded for a script rejection");
  if (!script) return undefined;
  const cells = list(s.inputCells, `${path}.inputCells`);
  if (cells.length !== tx.inputs.length) fail(`${path}.inputCells`, "must record every input");
  const responses = cells.map((raw, i) => {
    const p = `${path}.inputCells[${i}]`, c = object(raw, p); exact(c, ["outPoint", "response"], [], p);
    const previous = object(object(tx.inputs[i], `${path}.transaction.inputs[${i}]`).previous_output, `${path}.transaction.inputs[${i}].previous_output`);
    equalSemantic(c.outPoint, { tx_hash: previous.tx_hash, index: previous.index }, `${p}.outPoint`);
    const response = validateLiveCellResponse(c.response, `${p}.response`);
    if (response.status !== "live") fail(`${p}.response.status`, "an input of a script-rejected transaction is live");
    return response;
  });
  const source = object(rejection.source, `${path}.rejection.source`);
  if (source.cell === "input") {
    const cell = responses[source.index as number]!;
    const consumed = rejection.role === "lock" ? cell.status === "live" ? cell.cell.output.lock : null : cell.status === "live" ? cell.cell.output.type ?? null : null;
    if (consumed == null) fail(`${path}.rejection.script`, `input ${String(source.index)} has no ${String(rejection.role)} script`);
    equalSemantic(toRpc(object(rejection.script, `${path}.rejection.script`) as never), consumed, `${path}.rejection.script (consumed Cell's ${String(rejection.role)})`);
  }
  return responses;
}

export function deriveOutcomeV4(evidence: unknown, environment: unknown): OutcomeV4 {
  const m = bindManifestV4(evidence, environment), e = object(evidence, "evidence");
  const scripts = validateSetupScripts(environment, m);
  const context = resolutionContextV4(environment, scripts);
  const exported = list(object(object(environment, "environment").devnet, "environment.devnet").accounts, "environment.devnet.accounts").length;
  if (exported !== m.setup.accounts) fail("environment.devnet.accounts", `records ${exported} accounts; the manifest declares ${m.setup.accounts}`);
  const rawSteps = list(e.steps, "evidence.steps").map((s, i) => object(s, `evidence.steps[${i}]`));
  const byName = new Map<string, { tx: ReturnType<typeof validateTransaction>; transactionHash: string; observedStatus: "committed" | "rejected"; inputs?: LiveCellResponse[] }>();
  rawSteps.forEach((s, i) => {
    const p = `evidence.steps[${i}]`;
    if (m.steps[i]!.kind === "pure") {
      exact(s, ["name", "kind", "durationMs", "claims"], [], p);
      return;
    }
    exact(s, ["name", "kind", "expectedStatus", "observedStatus", "transactionHash", "transaction", "durationMs", "claims"],
      ["expectedErrorCode", "expectedErrorGroup", "expectedCycles", "cycles", "rejection", "inputCells"], p);
    const tx = validateTransaction(s.transaction, `${p}.transaction`);
    equalSemantic(transactionHash(tx), hash32(s.transactionHash, `${p}.transactionHash`), `${p}.transactionHash`);
    if (s.observedStatus !== "committed" && s.observedStatus !== "rejected") fail(`${p}.observedStatus`, "terminal status required");
    const inputs = validateRejectionV4(s, tx, p);
    byName.set(m.steps[i]!.name, { tx, transactionHash: s.transactionHash as string, observedStatus: s.observedStatus, ...(inputs === undefined ? {} : { inputs }) });
  });
  const phaseContext: PhaseContext = {
    context,
    step(name) {
      const step = byName.get(name);
      if (step === undefined) fail(`step ${name}`, "is not a transaction step");
      return step;
    },
  };
  const phase = (definitions: ClaimV5[], raw: unknown, path: string) => derivePhaseV3(definitions, raw, path, phaseContext);
  const steps = rawSteps.map((s, i): StepOutcomeV4 => {
    const declared = m.steps[i]!;
    const claims = phase(declared.assertions, s.claims, `evidence.steps[${i}].claims`);
    if (declared.kind === "pure") return { name: declared.name, kind: "pure", claims };
    const recorded = byName.get(declared.name)!;
    const group = declared.expect.error?.group;
    const resolved = group === undefined ? undefined : resolveScriptRef(group.script, context);
    const rejection = s.rejection === undefined ? undefined : s.rejection as RejectionEvidence;
    if (group !== undefined && resolved !== undefined && rejection?.kind === "script" && recorded.inputs !== undefined) {
      const candidates = groupScripts(group.role, recorded.inputs, recorded.tx).filter((script) => scriptMatches(script, resolved));
      if (candidates.length > 1) {
        fail(`evidence.steps[${i}].expectedErrorGroup`, `matches ${candidates.length} ${group.role} script groups of the transaction; add args to name one group`);
      }
    }
    return {
      name: declared.name, kind: "transaction", expectedStatus: declared.expect.tx,
      ...(declared.expect.error?.code === undefined ? {} : { expectedErrorCode: declared.expect.error.code }),
      ...(group === undefined || resolved === undefined ? {} : { expectedErrorGroup: { ...group, resolved: { codeHash: resolved.code_hash, hashType: resolved.hash_type, args: resolved.args } } }),
      ...(declared.expect.cycles === undefined ? {} : { expectedCycles: declared.expect.cycles }),
      observedStatus: recorded.observedStatus,
      ...(s.cycles === undefined ? {} : { cycles: s.cycles as number }),
      ...(rejection === undefined ? {} : { rejection }),
      claims,
    };
  });
  const setup = {
    accounts: m.setup.accounts,
    scripts: scripts.map((script): SetupScriptOutcome => script.kind === "binary"
      ? { name: script.name, kind: "binary", hashType: script.hashType, codeHash: script.codeHash, binarySha256: script.binarySha256, dataHash: script.dataHash }
      : { name: script.name, kind: "builtin", builtin: script.builtin, hashType: script.hashType, codeHash: script.codeHash }),
  };
  return { schema: OUTCOME_V4, name: m.meta.name, spec: SPEC_V6, setup, steps, assertions: phase(m.assertions, e.assertions, "evidence.assertions") };
}

/** A step passes when its status, error code, error group, cycles, and immediate claims all hold. */
export function verdictForOutcomeV4(outcome: OutcomeV4): "PASS" | "FAIL" {
  const stepOk = (s: StepOutcomeV4): boolean => {
    if (!s.claims.every((c) => c.ok)) return false;
    if (s.kind === "pure") return true;
    if (s.expectedStatus !== s.observedStatus || !errorCodeSatisfied(s.expectedErrorCode, s.rejection)) return false;
    if (s.expectedCycles !== undefined && !cyclesSatisfy(s.expectedCycles, s.cycles)) return false;
    if (s.expectedErrorGroup !== undefined) {
      const { role, resolved } = s.expectedErrorGroup;
      if (s.rejection?.kind !== "script" || s.rejection.role !== role || s.rejection.script === undefined) return false;
      if (!scriptMatches(toRpc(s.rejection.script), { code_hash: resolved.codeHash, hash_type: resolved.hashType, args: resolved.args })) return false;
    }
    return true;
  };
  return outcome.steps.every(stepOk) && outcome.assertions.every((c) => c.ok) ? "PASS" : "FAIL";
}

export function populateEvidenceV4(input: RunInputV4, outcome: OutcomeV4): RunEvidenceV4 {
  const claims = (raw: ClaimInputV3[], derived: ClaimOutcomeV3[]): ClaimEvidenceV3[] => raw.map((c, i) => {
    const d = derived[i]!;
    if (d.kind === "cell_deps" && c.kind === "cell_deps") return d;
    if (d.kind === "cell" && c.kind === "cell") return { ...d, input: c.input };
    if (d.kind === "balance" && c.kind === "balance") return { ...d, input: c.input };
    throw new Error("claim kind mismatch during population");
  });
  return { ...input, steps: input.steps.map((s, i) => ({ ...s, claims: claims(s.claims, outcome.steps[i]!.claims) })), assertions: claims(input.assertions, outcome.assertions) };
}

export function verifyStoredClaimsV4(evidence: unknown, outcome: OutcomeV4): void {
  const e = object(evidence, "evidence");
  const claims = (raw: unknown, derived: ClaimOutcomeV3[], path: string) => list(raw, path).forEach((v, i) => {
    const c = object(v, `${path}[${i}]`);
    exact(c, ["kind", "target", "expected", "observed", "observationValid", "ok", ...(derived[i]!.kind === "cell_deps" ? [] : ["input"])], [], `${path}[${i}]`);
    const { input: _input, ...stored } = c; void _input;
    equalSemantic(stored, derived[i], `${path}[${i}] stored derivation`);
  });
  list(e.steps, "evidence.steps").forEach((s, i) => claims(object(s, "step").claims, outcome.steps[i]!.claims, `evidence.steps[${i}].claims`));
  claims(e.assertions, outcome.assertions, "evidence.assertions");
}
