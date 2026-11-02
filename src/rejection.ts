// Offline checks on recorded rejection evidence. The outcome digest covers this data, so a report must not
// carry rejection evidence the runner could never have written: a node rejection with a script error code,
// a script rejection whose hash does not match its script or whose source is not in the transaction, a
// committed step with a rejection, or a rejected step without one.
import { scriptHash, type NormalizedScript } from "./transaction";

export class RejectionEvidenceError extends Error {}

function fail(path: string, problem: string): never {
  throw new RejectionEvidenceError(`${path}: ${problem}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) fail(path, `missing ${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(path, `unexpected ${key}`);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "must be a safe integer");
  return value;
}

function normalized(value: unknown, path: string): NormalizedScript {
  const script = record(value, path);
  exactKeys(script, ["codeHash", "hashType", "args"], [], path);
  if (typeof script.codeHash !== "string" || !/^0x[0-9a-f]{64}$/.test(script.codeHash)) fail(`${path}.codeHash`, "must be a 32-byte hex hash");
  if (script.hashType !== "data" && script.hashType !== "type" && script.hashType !== "data1" && script.hashType !== "data2") fail(`${path}.hashType`, "invalid hash type");
  if (typeof script.args !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(script.args)) fail(`${path}.args`, "must be even-length hex");
  return { codeHash: script.codeHash, hashType: script.hashType, args: script.args };
}

/** Checks one step's recorded status, rejection, and transaction against each other. */
export function assertRejectionEvidence(step: { observedStatus?: unknown; rejection?: unknown; transaction?: unknown }, path: string): void {
  const hasRejection = Object.hasOwn(step, "rejection") && step.rejection !== undefined;
  if (step.observedStatus === "committed") {
    if (hasRejection) fail(`${path}.rejection`, "a committed step cannot carry rejection evidence");
    return;
  }
  if (step.observedStatus !== "rejected") return;
  if (!hasRejection) fail(`${path}.rejection`, "a rejected step must carry rejection evidence");
  const rejection = record(step.rejection, `${path}.rejection`);
  if (rejection.kind === "node") {
    exactKeys(rejection, ["kind"], ["reason"], `${path}.rejection`);
    if (rejection.reason !== undefined && typeof rejection.reason !== "string") fail(`${path}.rejection.reason`, "must be a string");
    return;
  }
  if (rejection.kind !== "script") fail(`${path}.rejection.kind`, "must be script or node");
  exactKeys(rejection, ["kind", "rpcCode", "code", "source", "role", "script", "scriptHash"], [], `${path}.rejection`);
  integer(rejection.rpcCode, `${path}.rejection.rpcCode`);
  integer(rejection.code, `${path}.rejection.code`);
  if (rejection.role !== "lock" && rejection.role !== "type") fail(`${path}.rejection.role`, "must be lock or type");
  const source = record(rejection.source, `${path}.rejection.source`);
  exactKeys(source, ["cell", "index"], [], `${path}.rejection.source`);
  if (source.cell !== "input" && source.cell !== "output") fail(`${path}.rejection.source.cell`, "must be input or output");
  const index = integer(source.index, `${path}.rejection.source.index`);
  const script = normalized(rejection.script, `${path}.rejection.script`);
  if (rejection.scriptHash !== scriptHash(script)) fail(`${path}.rejection.scriptHash`, "does not match the recorded script");
  if (step.transaction === undefined) return; // report/1 retains no transaction; only the shape and hash are checkable
  const transaction = record(step.transaction, `${path}.transaction`);
  const cells = source.cell === "input" ? transaction.inputs : transaction.outputs;
  if (!Array.isArray(cells) || index < 0 || index >= cells.length) fail(`${path}.rejection.source`, `${source.cell} ${index} is not in the transaction`);
  if (source.cell === "output") {
    // An output's scripts are in the transaction itself; an input's lock needs the consumed Cell, which the
    // report does not retain, so only the bounds are checkable for inputs.
    const output = record(cells[index], `${path}.transaction.outputs[${index}]`);
    const raw = output[rejection.role as string];
    if (raw === null || raw === undefined) fail(`${path}.rejection.script`, `output ${index} has no ${String(rejection.role)} script`);
    const rpc = record(raw, `${path}.transaction.outputs[${index}].${String(rejection.role)}`);
    const fromTransaction = normalized({ codeHash: rpc.code_hash, hashType: rpc.hash_type, args: rpc.args }, `${path}.transaction.outputs[${index}].${String(rejection.role)}`);
    if (fromTransaction.codeHash !== script.codeHash || fromTransaction.hashType !== script.hashType || fromTransaction.args !== script.args) {
      fail(`${path}.rejection.script`, `differs from output ${index}'s ${String(rejection.role)} script`);
    }
  }
}

/** `expect.error.code` is satisfied only by script evidence with that code. */
export function errorCodeSatisfied(expected: number | undefined, rejection: { kind?: unknown; code?: unknown } | undefined): boolean {
  return expected === undefined || (rejection?.kind === "script" && rejection.code === expected);
}
