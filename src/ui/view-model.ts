// What the local console (`ckb-verify ui`) draws for a report: a pure, defensive projection of any report
// version into labelled transactions, claims with expected and observed values, and a short environment
// summary. Nothing here verifies anything; the console shows `inspectReport` beside it for that.

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export interface ScriptLike { code_hash?: string; hash_type?: string; args?: string; codeHash?: string; hashType?: string }
export interface CellView { capacity: string; lock: string; type: string | null; dataBytes: number | null; data: string | null; origin?: string }
export interface StepView {
  name: string;
  kind: "transaction" | "pure";
  expected: { status?: string; errorCode?: number; errorGroup?: string; cycles?: string };
  observed: { status?: string; cycles?: number; rejection?: string };
  checks: Array<{ label: string; ok: boolean }>;
  transaction?: { hash: string; inputs: Array<{ outPoint: string; cell: CellView | null }>; outputs: CellView[]; cellDeps: string[]; witnesses: number };
  claims: ClaimView[];
}
export interface ClaimView { kind: string; target: string; expected: string; observed: string; ok: boolean; observationValid: boolean }
export interface ReportView {
  schema: string; spec: string; name: string; verdict: string; createdAt: string;
  digests: { outcome: string; environment: string };
  replay: { status: string; reasons: Array<{ scope: string; code: string; detail: string }> };
  environment: Array<[string, string]>;
  setupScripts: Array<{ name: string; kind: string; hashType: string; codeHash: string; detail: string }>;
  steps: StepView[];
  assertions: ClaimView[];
}

/** Shannons as a CKB decimal, without floating point: 29999900000 -> "299.999". */
export function formatCkb(shannons: string | bigint): string {
  let value: bigint;
  try { value = typeof shannons === "bigint" ? shannons : BigInt(shannons); } catch { return String(shannons); }
  const whole = value / 100_000_000n, fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
const short = (hex: string | undefined, keep = 10): string => (hex === undefined ? "?" : hex.length <= keep + 6 ? hex : `${hex.slice(0, keep)}…${hex.slice(-4)}`);

/** Names a script the way a reader thinks of it: an exported account, a setup script, or an OffCKB system script. */
export class ScriptNamer {
  private readonly byCode = new Map<string, string>();
  private readonly accounts = new Map<string, string>();
  constructor(environment: unknown, outcome: unknown) {
    const devnet = isRecord(environment) && isRecord(environment.devnet) ? environment.devnet : {};
    if (isRecord(devnet.systemScripts)) {
      for (const [name, binding] of Object.entries(devnet.systemScripts)) {
        if (isRecord(binding)) this.byCode.set(`${str(binding.codeHash)}|${str(binding.hashType)}`, name);
      }
    }
    // Setup scripts win over a system script with the same identity: they are what the author named.
    const setup = isRecord(outcome) && isRecord(outcome.setup) ? list(outcome.setup.scripts) : [];
    for (const script of setup) if (isRecord(script)) this.byCode.set(`${str(script.codeHash)}|${str(script.hashType)}`, str(script.name) ?? "setup script");
    for (const account of list(devnet.accounts)) {
      if (!isRecord(account) || !isRecord(account.lock)) continue;
      const lock = account.lock;
      this.accounts.set(`${str(lock.codeHash)}|${str(lock.hashType)}|${str(lock.args)}`, `account ${String(account.index)}`);
    }
  }
  label(script: unknown): string {
    if (!isRecord(script)) return "none";
    const s = script as ScriptLike;
    const codeHash = s.code_hash ?? s.codeHash, hashType = s.hash_type ?? s.hashType, args = s.args ?? "0x";
    const account = this.accounts.get(`${codeHash}|${hashType}|${args}`);
    if (account !== undefined) return account;
    const name = this.byCode.get(`${codeHash}|${hashType}`);
    const shownArgs = args === "0x" ? "" : `(${short(args, 12)})`;
    return name !== undefined ? `${name}${shownArgs}` : `${short(codeHash)} ${hashType ?? "?"}${shownArgs}`;
  }
}

/** A script reference as written in a claim definition (explicit, builtin, account, or named setup script). */
function refText(ref: unknown): string {
  if (!isRecord(ref)) return String(ref);
  const args = ref.args === null ? " (any args)" : typeof ref.args === "string" ? ` args ${short(ref.args, 12)}` : "";
  if (ref.kind === "builtin") return `builtin ${String(ref.name)}${args}`;
  if (ref.kind === "setup") return `${String(ref.name)}${args}`;
  if (ref.kind === "account") return `account ${String(ref.index)}`;
  if (ref.kind === "explicit") return `${short(str(ref.codeHash))} ${String(ref.hashType)}${args}`;
  return JSON.stringify(ref);
}
function rangeText(range: unknown, unit?: "ckb"): string {
  if (typeof range === "number") return `= ${range}`;
  if (!isRecord(range)) return JSON.stringify(range);
  const show = (v: unknown) => (unit === "ckb" ? `${formatCkb(String(v))} CKB` : String(v));
  return Object.entries(range).map(([op, v]) => `${{ eq: "=", gte: "≥", lte: "≤", lt: "<" }[op] ?? op} ${show(v)}`).join(", ");
}

export function claimView(claim: unknown): ClaimView {
  const c = isRecord(claim) ? claim : {};
  const target = isRecord(c.target) ? c.target : {};
  const expected = isRecord(c.expected) ? c.expected : {};
  const observed = isRecord(c.observed) ? c.observed : {};
  const kind = str(c.kind) ?? "?";
  let targetText = "", expectedText = "", observedText = "";
  if (kind === "cell") {
    const parts: string[] = [];
    if (isRecord(target.outPoint)) parts.push(`output ${String(target.outPoint.index)} of "${String(target.outPoint.step)}"`);
    else if (typeof target.step === "string") parts.push(`output ${String(target.index)} of "${target.step}"`);
    if (target.lock !== undefined) parts.push(`lock ${refText(target.lock)}`);
    if (target.type !== undefined) parts.push(`type ${refText(target.type)}`);
    targetText = parts.join(", ");
    const e: string[] = [`count ${rangeText(expected.count)}`];
    if (isRecord(expected.data)) e.push(`data ${Object.entries(expected.data).map(([k, v]) => `${k} ${typeof v === "string" ? short(v, 18) : String(v)}`).join(", ")}`);
    if (expected.capacity !== undefined) e.push(`capacity ${rangeText(expected.capacity, "ckb")}`);
    if (isRecord(expected.type)) e.push(`type ${JSON.stringify(expected.type)}`);
    expectedText = e.join("; ");
    const cells = list(observed.cells);
    observedText = observed.state === "non-live" ? `not live (${String(observed.status)})` : observed.state === "missing-output" ? "no such output"
      : `count ${String(observed.count)}${cells.length > 0 ? `: ${cells.slice(0, 3).map((cell) => isRecord(cell) ? `${formatCkb(String(cell.capacity))} CKB${cell.dataBytes === null ? "" : `, ${String(cell.dataBytes)} B`}` : "").join(" | ")}${cells.length > 3 ? " …" : ""}` : ""}`;
  } else if (kind === "balance") {
    const t = target;
    targetText = t.kind === "account" ? `account ${String(t.index)}` : t.kind === "address" ? `address ${short(str(t.address), 14)}` : `lock ${refText(t.script)}`;
    const udt = isRecord(expected.udt) ? ` of UDT ${refText(expected.udt.type)}` : " (CKB)";
    targetText += udt;
    expectedText = rangeText(expected.amount, isRecord(expected.udt) ? undefined : "ckb");
    observedText = observed.total === null ? `malformed UDT data in ${list(observed.malformed).length} Cell(s)`
      : `${isRecord(expected.udt) ? String(observed.total) : `${formatCkb(String(observed.total))} CKB`} over ${String(observed.cells)} Cell(s)`;
  } else if (kind === "cell_deps") {
    targetText = `cell deps of "${String(target.step)}"`;
    const contains = isRecord(expected.contains) ? expected.contains : {};
    expectedText = `contains ${String(contains.kind === "setup" ? "" : "builtin ")}${String(contains.name)}`;
    observedText = `${list(observed.present).filter(Boolean).length}/${list(observed.present).length} deps present`;
  } else {
    targetText = JSON.stringify(c.target); expectedText = JSON.stringify(c.expected); observedText = JSON.stringify(c.observed);
  }
  return { kind, target: targetText, expected: expectedText, observed: observedText, ok: c.ok === true, observationValid: c.observationValid !== false };
}

function cellView(output: unknown, data: unknown, namer: ScriptNamer, origin?: string): CellView {
  const o = isRecord(output) ? output : {};
  const content = typeof data === "string" ? data : null;
  return {
    capacity: formatCkb(str(o.capacity) ?? "0"), lock: namer.label(o.lock), type: o.type == null ? null : namer.label(o.type),
    dataBytes: content === null ? null : (content.length - 2) / 2, data: content === null ? null : short(content, 34),
    ...(origin === undefined ? {} : { origin }),
  };
}

function rejectionText(rejection: unknown, namer: ScriptNamer): string | undefined {
  if (!isRecord(rejection)) return undefined;
  if (rejection.kind === "script") {
    const source = isRecord(rejection.source) ? `${String(rejection.source.cell)} ${String(rejection.source.index)}` : "?";
    return `script error ${String(rejection.code)} from the ${String(rejection.role)} script ${namer.label(rejection.script)} of ${source}`;
  }
  return `node rejection${rejection.rpcCode === undefined ? "" : ` (RPC ${String(rejection.rpcCode)})`}${typeof rejection.reason === "string" ? `: ${rejection.reason}` : ""}`;
}

/** Builds the console's view of a report of any version; unknown shapes degrade to raw text, never throw. */
export function buildReportView(report: unknown): ReportView {
  const r = isRecord(report) ? report : {};
  const evidence = isRecord(r.evidence) ? r.evidence : {};
  const outcome = isRecord(r.outcomeClaims) ? r.outcomeClaims : {};
  const environment = isRecord(r.environment) ? r.environment : {};
  const provenance = isRecord(environment.provenance) ? environment.provenance : {};
  const namer = new ScriptNamer(environment, outcome);
  const outcomeSteps = list(outcome.steps), evidenceSteps = list(evidence.steps);

  // Outputs of earlier steps, so an input can say where its Cell came from.
  const produced = new Map<string, { label: string; cell: CellView }>();
  const steps: StepView[] = outcomeSteps.map((raw, i) => {
    const s = isRecord(raw) ? raw : {};
    const e = isRecord(evidenceSteps[i]) ? (evidenceSteps[i] as Json) : {};
    const kind = s.kind === "pure" ? "pure" : "transaction";
    const group = isRecord(s.expectedErrorGroup) ? s.expectedErrorGroup : undefined;
    const resolved = group !== undefined && isRecord(group.resolved) ? group.resolved : undefined;
    const rejection = isRecord(s.rejection) ? s.rejection : undefined;
    const checks: StepView["checks"] = [];
    if (kind === "transaction" && typeof s.expectedStatus === "string") checks.push({ label: `expect.tx = ${s.expectedStatus}`, ok: s.expectedStatus === s.observedStatus });
    if (typeof s.expectedErrorCode === "number") checks.push({ label: `expect.error.code = ${s.expectedErrorCode}`, ok: rejection?.kind === "script" && rejection.code === s.expectedErrorCode });
    if (group !== undefined) {
      const script = rejection?.kind === "script" && isRecord(rejection.script) ? rejection.script : undefined;
      const ok = script !== undefined && rejection?.role === group.role && resolved !== undefined && script.codeHash === resolved.codeHash &&
        script.hashType === resolved.hashType && (resolved.args === null || script.args === resolved.args);
      checks.push({ label: `expect.error.group = ${String(group.role)} ${refText(group.script)}`, ok });
    }
    if (isRecord(s.expectedCycles)) {
      const cycles = typeof s.cycles === "number" ? s.cycles : undefined, c = s.expectedCycles as Record<string, number>;
      const ok = cycles !== undefined && (c.eq === undefined || cycles === c.eq) && (c.lt === undefined || cycles < c.lt) && (c.lte === undefined || cycles <= c.lte) && (c.gte === undefined || cycles >= c.gte);
      checks.push({ label: `expect.cycles ${rangeText(c)}`, ok });
    }
    let transaction: StepView["transaction"];
    const tx = isRecord(e.transaction) ? e.transaction : undefined;
    if (tx !== undefined) {
      const hash = str(e.transactionHash) ?? "?";
      const retained = list(e.inputCells);
      const inputs = list(tx.inputs).map((input, k) => {
        const previous = isRecord(input) && isRecord(input.previous_output) ? input.previous_output : {};
        const key = `${str(previous.tx_hash)}#${Number.parseInt(str(previous.index) ?? "0x0", 16)}`;
        const known = produced.get(key);
        const kept = isRecord(retained[k]) && isRecord((retained[k] as Json).response) ? ((retained[k] as Json).response as Json) : undefined;
        const keptCell = kept !== undefined && isRecord(kept.cell) ? kept.cell : undefined;
        return {
          outPoint: `${short(str(previous.tx_hash))}#${Number.parseInt(str(previous.index) ?? "0x0", 16)}`,
          cell: known !== undefined ? { ...known.cell, origin: known.label }
            : keptCell !== undefined ? cellView(keptCell.output, isRecord(keptCell.data) ? keptCell.data.content : null, namer, "retained by the runner") : null,
        };
      });
      const outputsData = list(tx.outputs_data);
      const outputs = list(tx.outputs).map((output, k) => {
        const cell = cellView(output, outputsData[k], namer);
        produced.set(`${hash}#${k}`, { label: `output ${k} of "${str(s.name) ?? "?"}"`, cell });
        return cell;
      });
      const cellDeps = list(tx.cell_deps).map((dep) => {
        const out = isRecord(dep) && isRecord(dep.out_point) ? dep.out_point : {};
        return `${short(str(out.tx_hash))}#${Number.parseInt(str(out.index) ?? "0x0", 16)} (${isRecord(dep) ? String(dep.dep_type) : "?"})`;
      });
      transaction = { hash, inputs, outputs, cellDeps, witnesses: list(tx.witnesses).length };
    }
    return {
      name: str(s.name) ?? `step ${i + 1}`, kind,
      expected: {
        ...(typeof s.expectedStatus === "string" ? { status: s.expectedStatus } : {}),
        ...(typeof s.expectedErrorCode === "number" ? { errorCode: s.expectedErrorCode } : {}),
        ...(group === undefined ? {} : { errorGroup: `${String(group.role)} ${refText(group.script)}` }),
        ...(isRecord(s.expectedCycles) ? { cycles: rangeText(s.expectedCycles) } : {}),
      },
      observed: {
        ...(typeof s.observedStatus === "string" ? { status: s.observedStatus } : {}),
        ...(typeof s.cycles === "number" ? { cycles: s.cycles } : {}),
        ...(rejection === undefined ? {} : { rejection: rejectionText(rejection, namer) ?? "" }),
      },
      checks,
      ...(transaction === undefined ? {} : { transaction }),
      claims: list(s.claims).map(claimView),
    };
  });

  const toolchain = isRecord(environment.toolchain) ? environment.toolchain : {};
  const observed = isRecord(toolchain.observed) ? toolchain.observed : {};
  const platform = isRecord(environment.platform) ? environment.platform : {};
  const devnet = isRecord(environment.devnet) ? environment.devnet : {};
  const source = isRecord(provenance.source) ? provenance.source : {};
  const envRows: Array<[string, string]> = [
    ["runner", isRecord(environment.runner) ? `${String(environment.runner.name)} ${String(environment.runner.version)}` : "?"],
    ["CKB", String(observed.ckb ?? "?")], ["OffCKB", String(observed.offckb ?? "?")],
    ["ckb-debugger", String(observed.ckbDebugger ?? "not used")],
    ["platform", `${String(platform.os ?? "?")} ${String(platform.arch ?? "?")}`],
    ["genesis", String(devnet.genesisHash ?? "?")],
    ["source", `${String(source.gitCommit ?? "unknown")}${source.dirty === true ? " (dirty)" : source.dirty === false ? " (clean)" : ""}`],
  ];
  if (isRecord(provenance.repository)) envRows.push(["repository", String(provenance.repository.url)]);
  if (Array.isArray(provenance.lockfiles)) envRows.push(["lockfiles", provenance.lockfiles.map((l) => (isRecord(l) ? String(l.path) : "")).join(", ") || "none"]);
  else if (isRecord(provenance.lockfile)) envRows.push(["lockfile", `${String(provenance.lockfile.path)} ${provenance.lockfile.sha256 === null ? "(missing)" : ""}`]);
  if (isRecord(devnet.sealing)) envRows.push(["sealing", String(devnet.sealing.fingerprint)]);

  const setupScripts = list(devnet.scripts).map((raw) => {
    const s = isRecord(raw) ? raw : {};
    const detail = s.kind === "binary" ? `${String(s.path)}, ${String(s.size)} bytes, ${String(s.binarySha256)}` : `alias of ${String(s.builtin)}`;
    return { name: String(s.name), kind: String(s.kind), hashType: String(s.hashType), codeHash: String(s.codeHash), detail };
  });
  const replay = isRecord(provenance.replay) ? provenance.replay : {};
  const digests = isRecord(r.digests) ? r.digests : {};
  return {
    schema: String(r.schema ?? "?"), spec: String(evidence.spec ?? outcome.spec ?? "?"), name: String(evidence.name ?? outcome.name ?? "?"),
    verdict: String(r.verdict ?? "?"), createdAt: String(r.createdAt ?? ""),
    digests: { outcome: String(digests.outcome ?? "?"), environment: String(digests.environment ?? "?") },
    replay: { status: String(replay.status ?? "?"), reasons: list(replay.reasons).filter(isRecord).map((x) => ({ scope: String(x.scope), code: String(x.code), detail: String(x.detail) })) },
    environment: envRows, setupScripts, steps, assertions: list(outcome.assertions).map(claimView),
  };
}

/** Two reports of the same manifest: do they agree, and if not, on which claims? */
export function compareReports(a: unknown, b: unknown): { sameManifest: boolean; outcomeEqual: boolean; environmentEqual: boolean; differences: string[] } {
  const va = buildReportView(a), vb = buildReportView(b);
  const differences: string[] = [];
  const claimsA = [...va.steps.flatMap((s) => s.claims.map((c) => [`step "${s.name}" ${c.kind} ${c.target}`, c] as const)), ...va.assertions.map((c) => [`final ${c.kind} ${c.target}`, c] as const)];
  const claimsB = new Map([...vb.steps.flatMap((s) => s.claims.map((c) => [`step "${s.name}" ${c.kind} ${c.target}`, c] as const)), ...vb.assertions.map((c) => [`final ${c.kind} ${c.target}`, c] as const)]);
  for (const [key, claim] of claimsA) {
    const other = claimsB.get(key);
    if (other === undefined) differences.push(`${key}: only in the first report`);
    else if (other.ok !== claim.ok || other.observed !== claim.observed) differences.push(`${key}: ${claim.ok ? "ok" : "failed"} (${claim.observed}) vs ${other.ok ? "ok" : "failed"} (${other.observed})`);
    claimsB.delete(key);
  }
  for (const key of claimsB.keys()) differences.push(`${key}: only in the second report`);
  for (const [i, step] of va.steps.entries()) {
    const other = vb.steps[i];
    if (other !== undefined && step.name === other.name && (step.observed.status !== other.observed.status || step.observed.cycles !== other.observed.cycles)) {
      differences.push(`step "${step.name}": ${step.observed.status ?? "-"}/${step.observed.cycles ?? "-"} cycles vs ${other.observed.status ?? "-"}/${other.observed.cycles ?? "-"} cycles`);
    }
  }
  return { sameManifest: va.name === vb.name && va.spec === vb.spec, outcomeEqual: va.digests.outcome === vb.digests.outcome,
    environmentEqual: va.digests.environment === vb.digests.environment, differences };
}
