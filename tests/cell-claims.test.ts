import { describe, expect, test } from "bun:test";
import { EvidenceIntegrityError, verifyReport } from "../src/report";
import { canonicalSha256, sha256Bytes } from "../src/canonical";
import { bindManifestV2, deriveOutcomeV2, validateBinding, validateDep, validateLiveCellResponse, validateOutput,
  validateScript, validateTransaction, populateEvidenceV2, verdictForOutcomeV2, equalSemantic } from "../src/cell-claims";
import { transactionHash } from "../src/transaction";
import { bindings, hex32, liveResponse, syntheticReportV2, syntheticTransaction } from "./fixtures/claims-v2/synthetic";

// Deliberate hostile wire edits: mutation tests must bypass static report types.
type Wire = any;
function rehash(r: Wire) {
  if (typeof r.evidence.manifestText === "string") r.environment.provenance.manifest.sha256 = sha256Bytes(Buffer.from(r.evidence.manifestText));
  r.digests = { outcome: canonicalSha256(r.outcomeClaims), environment: canonicalSha256(r.environment) };
}
function rejectMutation(edit: (r: Wire) => void) {
  const r = syntheticReportV2(); edit(r); rehash(r);
  expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
}
function allCells(r: Wire): Wire[] { return [...r.evidence.steps.flatMap((s: Wire) => s.claims), ...r.evidence.assertions].filter((c: Wire) => c.kind === "cell"); }
function syncRaw(r: Wire) {
  for (const s of r.evidence.steps) s.transactionHash = transactionHash(s.transaction);
  for (const c of allCells(r)) {
    const step = r.evidence.steps.find((s: Wire) => s.name === c.target.step);
    if (c.target.index < step.transaction.outputs.length) c.input = { kind: "query", outPoint: { tx_hash: step.transactionHash, index: `0x${c.target.index.toString(16)}` }, response: liveResponse(step.transaction, c.target.index) };
    else c.input = { kind: "missing-output" };
  }
}
function regenerate(r: Wire) {
  rehash(r);
  const outcome = deriveOutcomeV2(r.evidence, r.environment);
  r.evidence = populateEvidenceV2(r.evidence, outcome); r.outcomeClaims = outcome;
  r.verdict = verdictForOutcomeV2(outcome); rehash(r); verifyReport(r);
  return r;
}

describe("v2 retained semantic closure", () => {
  test("FIX3 zero equivalence is numeric only and preserves exact retained shape", () => {
    for (const [actual, expected] of [[-0, 0], [0, -0], [-0, -0], [0, 0]]) {
      expect(() => equalSemantic({ index: actual }, { index: expected }, "zero")).not.toThrow();
    }
    for (const value of ["0", false, null, undefined, 1, -1, NaN, Infinity]) {
      expect(() => equalSemantic({ index: value }, { index: 0 }, "not numeric zero")).toThrow();
    }
    expect(() => equalSemantic({ index: -0, extra: undefined }, { index: 0 }, "extra key")).toThrow();
    expect(() => equalSemantic(Object.create({ index: -0 }), { index: 0 }, "inherited index")).toThrow();
    let reads = 0;
    const getter = Object.defineProperty({}, "index", { enumerable: true, get() { reads++; return -0; } });
    expect(() => equalSemantic(getter, { index: 0 }, "accessor")).toThrow();
    expect(reads).toBe(0);
  });
  test.each(["non-null toJSON", "forEach method", "forEach getter"])(
    "FIX2 canonical dispatch refuses inherited %s before hashing retained binding", form => {
      const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
      const binding = r.environment.devnet.systemScripts.dao;
      let reads = 0, calls = 0;
      if (form === "non-null toJSON") Object.setPrototypeOf(binding, { toJSON: 42 });
      else {
        const forEach = () => { calls++; }; // Canonicalizer would hash an empty vector.
        Object.setPrototypeOf(binding.cellDeps, Object.create(Array.prototype, {
          forEach: form.endsWith("getter") ? { get() { reads++; return forEach; } } : { value: forEach },
        }));
      }
      rehash(r); reads = 0; calls = 0;
      expect(() => verifyReport(r)).toThrow(form === "non-null toJSON" ? "toJSON" : "forEach");
      expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
      expect(() => verifyReport(JSON.parse(JSON.stringify(r)))).toThrow(EvidenceIntegrityError);
    });
  test.each(["plain", "null prototype", "inherited metadata", "non-callable toJSON", "shadowed hook"])(
    "FIX2 controls preserve supported %s semantic objects and array slots", form => {
      const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
      let calls = 0;
      for (const value of [r, r.environment.devnet.systemScripts.dao, r.evidence.steps[0].claims[0].input.response]) {
        if (form === "null prototype") Object.setPrototypeOf(value, null);
        if (form === "inherited metadata") Object.setPrototypeOf(value, { label: "not retained or consumed" });
        if (form === "non-callable toJSON") Object.setPrototypeOf(value, { toJSON: null });
        if (form === "shadowed hook") Object.setPrototypeOf(value, Object.create({ toJSON() { calls++; return {}; } }, { toJSON: { value: null } }));
      }
      if (form === "non-callable toJSON") Object.setPrototypeOf(r.environment.devnet.systemScripts.dao.cellDeps,
        Object.create(Array.prototype, { toJSON: { value: undefined } }));
      Object.defineProperty(r.environment.devnet.systemScripts.dao.cellDeps, "0", { enumerable: false });
      rehash(r); verifyReport(r); verifyReport(JSON.parse(JSON.stringify(r)));
      expect(r.verdict).toBe("PASS");
      expect(calls).toBe(0);
    });
  test.each(["steps", "claims", "transaction outputs", "stored vector", "outcome vector"])(
    "FIX2 controls reject inherited array serialization hooks on consumed %s", slot => {
      const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
      const value = slot === "steps" ? r.evidence.steps : slot === "claims" ? r.evidence.steps[0].claims :
        slot === "transaction outputs" ? r.evidence.steps[0].transaction.outputs : slot === "stored vector" ?
        r.evidence.steps[0].claims[1].observed.present : r.outcomeClaims.steps[0].claims[1].observed.present;
      let reads = 0, calls = 0;
      Object.setPrototypeOf(value, Object.create(Array.prototype, {
        toJSON: { get() { reads++; return () => { calls++; return []; }; } },
      }));
      expect(() => verifyReport(r)).toThrow("toJSON");
      expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
    });
  test.each(["own hook", "inherited hook", "inherited getter"])("FIX2 report container refuses %s before JSON can replace report2", form => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    verifyReport(r);
    let reads = 0, calls = 0;
    const hook = () => { calls++; return {}; };
    const owner = form === "own hook" ? r : Object.create(Object.getPrototypeOf(r));
    Object.defineProperty(owner, "toJSON", form === "inherited getter" ? { get() { reads++; return hook; } } : { value: hook, enumerable: true });
    if (owner !== r) Object.setPrototypeOf(r, owner);
    expect(() => verifyReport(r)).toThrow("report.toJSON");
    expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
    expect(() => verifyReport(JSON.parse(JSON.stringify(r)))).toThrow(EvidenceIntegrityError);
  });
  test("FIX2 methods validate actual binding slots instead of inherited map results", () => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const binding = r.environment.devnet.systemScripts.dao;
    const valid = JSON.parse(JSON.stringify(binding.cellDeps));
    binding.cellDeps = [null];
    let calls = 0;
    Object.setPrototypeOf(binding.cellDeps, Object.create(Array.prototype, {
      map: { value() { calls++; return valid; } },
    }));
    rehash(r);
    expect(() => verifyReport(r)).toThrow("cellDeps[0]");
    expect(() => validateBinding(binding)).toThrow("cellDeps[0]");
    expect(calls).toBe(0);
    expect(() => verifyReport(JSON.parse(JSON.stringify(r)))).toThrow("cellDeps[0]");
  });
  test.each(["outputs", "outputs_data", "cell_deps"])("FIX2 methods validate actual transaction %s slots", key => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const tx = r.evidence.steps[0].transaction, valid = tx[key];
    tx[key] = [null];
    let calls = 0;
    Object.setPrototypeOf(tx[key], Object.create(Array.prototype, {
      map: { value() { calls++; return valid; } },
    }));
    expect(() => verifyReport(r)).toThrow(key);
    expect(calls).toBe(0);
  });
  test.each(["steps", "immediate claims", "final claims"])("FIX2 methods never dispatch input iteration callbacks for %s", slot => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const array = slot === "steps" ? r.evidence.steps : slot === "immediate claims" ? r.evidence.steps[0].claims : r.evidence.assertions;
    let reads = 0, calls = 0;
    const unexpected = () => { calls++; throw new Error("untrusted array method executed"); };
    Object.setPrototypeOf(array, Object.create(Array.prototype, {
      map: { get() { reads++; return unexpected; } },
      every: { value: unexpected }, [Symbol.iterator]: { value: unexpected },
    }));
    // Valid own slots still work; rejecting all unusual prototypes is not the fix.
    expect(() => verifyReport(r)).not.toThrow();
    const derived = deriveOutcomeV2(r.evidence, r.environment);
    const populated = populateEvidenceV2(r.evidence, derived);
    expect(populated).toEqual(JSON.parse(JSON.stringify(r.evidence)));
    expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
    verifyReport(JSON.parse(JSON.stringify(r)));
  });
  test.each([
    ["binding", (r: Wire) => r.environment.devnet.systemScripts.dao, () => ({})],
    ["binding array", (r: Wire) => r.environment.devnet.systemScripts.dao.cellDeps, () => []],
    ["retained response", (r: Wire) => r.evidence.steps[0].claims[0].input.response, () => ({ status: "unknown", cell: null })],
  ] as const)("FIX2 hooks reject inherited toJSON on %s without calling it", (_name, select, replacement) => {
    // Break raw/outcome aliasing before attaching any independently hostile input.
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    verifyReport(r);
    const value = select(r);
    let calls = 0;
    Object.setPrototypeOf(value, Object.create(Object.getPrototypeOf(value), {
      toJSON: { value: () => { calls++; return replacement(); } },
    }));
    rehash(r); calls = 0;
    expect(() => verifyReport(r)).toThrow("toJSON");
    expect(calls).toBe(0);
    // Explicit serialization here is a negative control, not a validation strategy.
    expect(() => verifyReport(JSON.parse(JSON.stringify(r)))).toThrow(EvidenceIntegrityError);
  });
  test.each(["binding", "binding array", "retained response"])("FIX2 hooks reject inherited toJSON accessor on %s without reading it", slot => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const value = slot === "binding" ? r.environment.devnet.systemScripts.dao : slot === "binding array" ?
      r.environment.devnet.systemScripts.dao.cellDeps : r.evidence.steps[0].claims[0].input.response;
    let reads = 0, calls = 0;
    Object.setPrototypeOf(value, Object.create(Object.getPrototypeOf(value), {
      toJSON: { get() { reads++; return () => { calls++; return {}; }; } },
    }));
    expect(() => verifyReport(r)).toThrow("toJSON");
    expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
  });
  test.each(["object", "array"])("FIX2 hooks are not executed by exact semantic equality for %s", kind => {
    const expected = kind === "object" ? { count: 1 } : [true, true];
    const actual = JSON.parse(JSON.stringify(expected));
    let calls = 0;
    Object.setPrototypeOf(actual, Object.create(Object.getPrototypeOf(actual), {
      toJSON: { value: () => { calls++; return expected; } },
    }));
    expect(() => equalSemantic(actual, expected, "semantic")).toThrow("toJSON");
    expect(calls).toBe(0);
  });
  test.each([
    ["schema"], ["evidence"], ["outcomeClaims"], ["environment"], ["verdict"], ["digests"],
    ["environment", "schema"], ["environment", "provenance", "schema"],
  ].map(path => ({ path })))("SPEC01 report2 dispatch retains its consumed envelope member %#", ({ path }) => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    verifyReport(r);
    let owner = r;
    for (const key of path.slice(0, -1)) owner = owner[key];
    Object.defineProperty(owner, path.at(-1)!, { enumerable: false });
    rehash(r);
    expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
    expect(() => verifyReport(JSON.parse(JSON.stringify(r)))).toThrow(EvidenceIntegrityError);
  });

  test.each(["all-hole", "leading", "middle", "trailing", "inherited", "null-control"])("SPEC02 binding slots reject %s without vacuous PASS", form => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const b = r.environment.devnet.systemScripts.dao, [a, z] = b.cellDeps;
    if (form === "all-hole") b.cellDeps = Array(1);
    if (form === "leading") b.cellDeps = [, a, z];
    if (form === "middle") b.cellDeps = [a, , z];
    if (form === "trailing") b.cellDeps = [a, z, ,];
    if (form === "null-control") b.cellDeps = [null];
    if (form === "inherited") {
      delete b.cellDeps[0];
      Object.setPrototypeOf(b.cellDeps, Object.create(Array.prototype, { 0: { value: a } }));
    }
    rehash(r);
    expect(() => validateBinding(b)).toThrow("cellDeps");
    expect(() => deriveOutcomeV2(r.evidence, r.environment)).toThrow("cellDeps");
    expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
  });
  test.each(["outputs", "outputs_data", "cell_deps", "inputs", "header_deps", "witnesses"])("SPEC02 consumed transaction %s requires own slots", key => {
    const tx: Wire = JSON.parse(JSON.stringify(syntheticReportV2().evidence.steps[0]!.transaction));
    tx[key] = Array(1);
    expect(() => validateTransaction(tx)).toThrow(key);
    Object.setPrototypeOf(tx[key], Object.create(Array.prototype, { 0: { value: null } }));
    expect(() => validateTransaction(tx)).toThrow(key);
  });
  test.each(["steps", "immediate claims", "final claims", "replay", "stored vector", "outcome vector"])("SPEC02 semantic arrays reject inherited slots in %s", slot => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    // Replay uses a declared entry so a filled inherited slot would otherwise match.
    if (slot === "replay") {
      r.evidence.manifestText = r.evidence.manifestText.replace("dependencies = []", 'dependencies = ["randomness"]');
      r.environment.provenance.replay = { declaredDependencies: ["randomness"], status: "tainted", reasons: [{ scope: "outcome", code: "randomness", detail: "manifest declares replay dependency randomness" }] };
      rehash(r); verifyReport(r);
    }
    const array = slot === "steps" ? r.evidence.steps : slot === "immediate claims" ? r.evidence.steps[0].claims :
      slot === "final claims" ? r.evidence.assertions : slot === "replay" ? r.environment.provenance.replay.declaredDependencies :
      slot === "stored vector" ? r.evidence.steps[0].claims[1].observed.present : r.outcomeClaims.steps[0].claims[1].observed.present;
    const value = array[0]; delete array[0];
    Object.setPrototypeOf(array, Object.create(Array.prototype, { 0: { value } }));
    rehash(r);
    expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
  });
  test("SPEC02 exact equality rejects matching holes, inherited slots and hidden non-index keys", () => {
    expect(() => equalSemantic(Array(1), Array(1), "vector")).toThrow();
    const inherited = Array(1);
    Object.setPrototypeOf(inherited, Object.create(Array.prototype, { 0: { value: true } }));
    expect(() => equalSemantic(inherited, inherited, "vector")).toThrow();
    for (const key of ["extra", "01", "-1", "4294967295", Symbol("extra")]) {
      const b = JSON.parse(JSON.stringify(bindings.dao));
      Object.defineProperty(b.cellDeps, key, { value: undefined });
      expect(() => validateBinding(b)).toThrow("cellDeps");
      expect(() => equalSemantic(b.cellDeps, b.cellDeps, "vector")).toThrow();
    }
  });
  test("SPEC02 own non-enumerable array indices are JSON-retained controls", () => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const arrays = [r.environment.devnet.systemScripts.dao.cellDeps, r.evidence.steps, r.evidence.steps[0].claims,
      r.evidence.assertions, r.evidence.steps[0].claims[1].observed.present, r.outcomeClaims.steps[0].claims[1].observed.present,
      r.evidence.steps[0].transaction.outputs, r.evidence.steps[0].transaction.outputs_data, r.evidence.steps[0].transaction.cell_deps];
    for (const array of arrays) Object.defineProperty(array, "0", { enumerable: false });
    rehash(r); verifyReport(r); verifyReport(JSON.parse(JSON.stringify(r)));
    const outcome = deriveOutcomeV2(r.evidence, r.environment);
    expect(outcome.steps[0]!.claims[1]!.observed).toEqual({ present: [true, true] });
  });

  test.each([
    ["alias", (r: Wire) => [r.environment.devnet.systemScripts, "dao"]],
    ["binding codeHash", (r: Wire) => [r.environment.devnet.systemScripts.dao, "codeHash"]],
    ["dependency index", (r: Wire) => [r.environment.devnet.systemScripts.dao.cellDeps[0].outPoint, "index"]],
    ["manifest text", (r: Wire) => [r.evidence, "manifestText"]],
    ["requested container", (r: Wire) => [r.environment.toolchain, "requested"]],
    ["step transaction", (r: Wire) => [r.evidence.steps[0], "transaction"]],
    ["claim kind", (r: Wire) => [r.evidence.steps[0].claims[0], "kind"]],
    ["claim input", (r: Wire) => [r.evidence.steps[0].claims[0], "input"]],
    ["optional output type", (r: Wire) => [r.evidence.steps[0].transaction.outputs[0], "type"]],
    ["raw response data", (r: Wire) => [r.evidence.steps[0].claims[0].input.response.cell.data, "content"]],
  ] as const)("SPEC01 retention rejects non-enumerable %s before derivation", (_name, select) => {
    // Break internal fixture aliases BEFORE the independent raw mutation.
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    verifyReport(r);
    const [owner, key] = select(r);
    Object.defineProperty(owner, key, { enumerable: false });
    rehash(r);
    expect(() => deriveOutcomeV2(r.evidence, r.environment)).toThrow();
    expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
  });
  test.each(["extra", "ckbDebugger"])("SPEC01 exact own requested presence includes hidden %s undefined", key => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    Object.defineProperty(r.environment.toolchain.requested, key, { value: undefined, enumerable: false });
    rehash(r);
    expect(() => bindManifestV2(r.evidence, r.environment)).toThrow("requested");
    expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
    // JSON omits the extra member; that does not legitimize the original input.
    expect(() => verifyReport(JSON.parse(JSON.stringify(r)))).not.toThrow();
  });
  test.each([
    ["binding", () => JSON.parse(JSON.stringify(bindings.dao)), validateBinding],
    ["script", () => (syntheticTransaction().outputs[0] as Wire).lock, validateScript],
    ["output", () => syntheticTransaction().outputs[0], validateOutput],
    ["dep", () => syntheticReportV2().evidence.steps[0]!.transaction.cell_deps[0], validateDep],
    ["response", () => liveResponse(syntheticTransaction()), validateLiveCellResponse],
    ["transaction", () => syntheticTransaction(), validateTransaction],
  ] as const)("SPEC01 exact %s rejects hidden required and extra own members", (_name, make, check) => {
    const good: Wire = JSON.parse(JSON.stringify(make()));
    expect(() => check(good)).not.toThrow();
    const hidden = JSON.parse(JSON.stringify(good));
    Object.defineProperty(hidden, Object.keys(good)[0]!, { enumerable: false });
    expect(() => check(hidden)).toThrow();
    const extra = JSON.parse(JSON.stringify(good));
    Object.defineProperty(extra, "extra", { value: undefined });
    expect(() => check(extra)).toThrow();
  });
  test("SPEC01 exact semantic objects reject symbol-only extensions", () => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    r.environment.toolchain.requested[Symbol("extra")] = undefined;
    rehash(r);
    expect(() => bindManifestV2(r.evidence, r.environment)).toThrow("requested");
    const b = JSON.parse(JSON.stringify(bindings.dao));
    b[Symbol("extra")] = undefined;
    expect(() => validateBinding(b)).toThrow();
  });
  test("SPEC01 semantic data members cannot change via getters during retention", () => {
    const r: Wire = JSON.parse(JSON.stringify(syntheticReportV2()));
    const b = r.environment.devnet.systemScripts.dao, value = b.codeHash;
    let reads = 0;
    Object.defineProperty(b, "codeHash", { enumerable: true, get: () => ++reads === 1 ? value : undefined });
    // A data field, unlike this accessor, has a stable value for validation and JSON.
    expect(() => validateBinding(b)).toThrow();
    expect(reads).toBe(0);
    expect(() => deriveOutcomeV2(r.evidence, r.environment)).toThrow();
  });
  test.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("S03 exact hex rejects trailing line terminator %#", suffix => {
    const script = { code_hash: hex32("11"), hash_type: "type", args: "0x" };
    expect(() => validateScript({ ...script, code_hash: script.code_hash + suffix })).toThrow("code_hash");
    expect(() => validateScript({ ...script, args: "0xab" + suffix })).toThrow("args");
    const output: Wire = syntheticTransaction().outputs[0]; output.capacity = "0x1" + suffix;
    expect(() => validateOutput(output)).toThrow("capacity");
    expect(() => validateDep({ out_point: { tx_hash: hex32("21"), index: "0x0" + suffix }, dep_type: "code" })).toThrow("index");
  });
  test("M02 independently rehashed siblings cannot disagree on one boundary snapshot", () => {
    const r: Wire = syntheticReportV2();
    const cell = '\n[[step.assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 1\ntype = { builtin = "dao", args_bytes = 0 }\ndata = { min_bytes = 1 }\n';
    r.evidence.manifestText = r.evidence.manifestText.replace('[[step.assert.cell_deps]]', cell + '[[step.assert.cell_deps]]');
    r.evidence.steps[0].claims.splice(1, 0, structuredClone(r.evidence.steps[0].claims[0]));
    r.outcomeClaims.steps[0].claims.splice(1, 0, structuredClone(r.outcomeClaims.steps[0].claims[0]));
    rehash(r); verifyReport(r);
    r.evidence.steps[0].claims[1].input.response.block_hash = hex32("de");
    rehash(r); expect(() => verifyReport(r)).toThrow("phase snapshot");
  });
  test("V04 missing-output arm is derived, never forged through booleans or extra inputs", () => {
    const r: Wire = syntheticReportV2();
    r.evidence.steps[0].transaction.outputs = []; r.evidence.steps[0].transaction.outputs_data = []; syncRaw(r); regenerate(r);
    r.evidence.steps[0].claims[0].input = { kind: "query", outPoint: { tx_hash: r.evidence.steps[0].transactionHash, index: "0x0" }, response: { status: "unknown", cell: null } };
    rehash(r); expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
  });
  test("S01 same code but wrong hash_type fails with actual raw identity", () => {
    const r: Wire = syntheticReportV2(); r.evidence.steps[0].transaction.outputs[0].type.hash_type = "data2";
    syncRaw(r); regenerate(r);
    expect(r.verdict).toBe("FAIL");
    expect(r.evidence.steps[0].claims[0].observed.type.identity).toEqual({ kind: "raw", codeHash: bindings.dao!.codeHash, hashType: "data2" });
  });
  test("S08 extra distinct deps are membership-neutral, not exclusivity or type inference", () => {
    const r: Wire = syntheticReportV2();
    const before = r.digests.outcome;
    r.evidence.steps[0].transaction.cell_deps.push({ out_point: { tx_hash: hex32("de"), index: "0x7" }, dep_type: "code" });
    syncRaw(r); regenerate(r); expect(r.digests.outcome).toBe(before);
    r.evidence.steps[0].transaction.cell_deps = []; syncRaw(r); regenerate(r);
    expect(r.evidence.steps[0].claims[0].ok).toBe(true);
    expect(r.evidence.steps[0].claims[1].observed.present).toEqual([false, false]);
  });
  test("V05 V08 all-consistent rewrite is internal consistency, not execution attestation", () => {
    const r: Wire = syntheticReportV2();
    r.evidence.manifestText = r.evidence.manifestText.replace('name = "synthetic-cell-claims"', 'name = "rewritten"').replace('dependencies = []', 'dependencies = ["external_network"]');
    r.evidence.name = "rewritten";
    r.environment.provenance.replay = { declaredDependencies: ["external_network"], status: "tainted", reasons: [{ scope: "outcome", code: "external_network", detail: "manifest declares replay dependency external_network" }] };
    regenerate(r); expect(r.verdict).toBe("PASS"); expect(r.outcomeClaims.name).toBe("rewritten");
  });
  test("V01 derived outcome excludes raw inputs, paths and timings but retains all statuses/cycles", () => {
    const r = syntheticReportV2(), before = deriveOutcomeV2(r.evidence, r.environment);
    r.evidence.steps[0]!.durationMs = 12345; r.createdAt = 'another synthetic timestamp';
    expect(deriveOutcomeV2(r.evidence, r.environment)).toEqual(before);
    expect(before.steps).toHaveLength(3);
    for (const step of before.steps) { expect(step.cycles).toBe(100); expect(step.observedStatus).toBe("committed");
      for (const key of ["transaction", "transactionHash", "durationMs", "path"]) expect(step).not.toHaveProperty(key);
    }
    expect(before).not.toHaveProperty("manifestText");
    expect(before.steps[0]!.claims[0]).not.toHaveProperty("input");
  });
  test("V03 referenced bindings must be own hash-bound environment members", () => {
    const r: Wire = syntheticReportV2();
    const scripts = r.environment.devnet.systemScripts;
    r.environment.devnet.systemScripts = Object.assign(Object.create({ dao: scripts.dao }), { spore: scripts.spore });
    rehash(r); expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
  });
  test("V01 literal independent synthetic PASS verifies without builder normalization", () => {
    const r = syntheticReportV2(); verifyReport(r);
    expect(deriveOutcomeV2(r.evidence, r.environment)).toEqual(r.outcomeClaims);
  });
  test("V07 exact requested object rejects extra undefined optional members", () => rejectMutation(r => { r.environment.toolchain.requested.extra = undefined; }));
  test("V06 exact optional expectation absence rejects a present undefined member", () => rejectMutation(r => { r.evidence.steps[1].expectedStatus = undefined; }));

  test.each([
    ["S03 output missing capacity", (v: Wire) => { delete v.capacity; }],
    ["S03 output missing lock", (v: Wire) => { delete v.lock; }],
    ["S03 output extra key", (v: Wire) => { v.extra = 0; }],
    ["S03 output type empty", (v: Wire) => { v.type = {}; }],
    ["S03 lock wrong hash type", (v: Wire) => { v.lock.hash_type = "data3"; }],
    ["S03 lock uppercase hash", (v: Wire) => { v.lock.code_hash = `0x${"AB".repeat(32)}`; }],
    ["S03 lock extra key", (v: Wire) => { v.lock.extra = false; }],
    ["S03 capacity leading zero", (v: Wire) => { v.capacity = "0x01"; }],
    ["S03 capacity overflow", (v: Wire) => { v.capacity = "0x10000000000000000"; }],
  ] as const)("%s", (_name, edit) => {
    const output = structuredClone(syntheticTransaction().outputs[0]); edit(output);
    expect(() => validateOutput(output)).toThrow();
  });
  test.each(["0x1", "0xzz", "0xAB", "AB", 0, null, "0x" + "ab".repeat(1_048_577)].map((bad, index) => ({ bad, index })))("S02 rejects malformed or oversized bytes case %#", ({ bad }) => {
    const tx = syntheticTransaction(); tx.outputs_data = [bad];
    expect(() => validateTransaction(tx)).toThrow("outputs_data[0]");
    const script = { code_hash: hex32("11"), hash_type: "type", args: bad };
    expect(() => validateScript(script)).toThrow("args");
  });
  test("S02 accepts MAX_BYTES before hashing; rejects missing data and alignment", () => {
    const tx = syntheticTransaction(); tx.outputs_data = ["0x" + "ab".repeat(1_048_576)];
    expect<unknown>(validateTransaction(tx).outputs_data).toEqual(tx.outputs_data);
    tx.outputs_data = []; expect(() => validateTransaction(tx)).toThrow("alignment");
    const response: Wire = liveResponse(syntheticTransaction()); delete response.cell.data;
    expect(() => validateLiveCellResponse(response)).toThrow("data");
  });
  test.each([
    ["S05 status missing", (v: Wire) => { delete v.status; }],
    ["S05 status unknown enum", (v: Wire) => { v.status = "pending"; }],
    ["S05 live cell null", (v: Wire) => { v.cell = null; }],
    ["S05 nonlive with cell", (v: Wire) => { v.status = "dead"; }],
    ["S05 block hash malformed", (v: Wire) => { v.block_hash = "0x12"; }],
    ["S03 data hash wrong", (v: Wire) => { v.cell.data.hash = hex32("44"); }],
    ["S03 data extra key", (v: Wire) => { v.cell.data.extra = 1; }],
    ["S03 cell extra key", (v: Wire) => { v.cell.extra = 1; }],
    ["S03 response extra key", (v: Wire) => { v.extra = 1; }],
  ] as const)("%s", (_name, edit) => {
    const response = liveResponse(syntheticTransaction()); edit(response);
    expect(() => validateLiveCellResponse(response)).toThrow();
  });
  test("S03 sentinel and CCC content hash branches, optional block hash", () => {
    const tx = syntheticTransaction();
    for (const data of ["0x", "0x00", "0xabcd"]) {
      tx.outputs_data = [data]; const response = liveResponse(tx);
      expect<unknown>(validateLiveCellResponse(response)).toEqual(response);
      expect(validateLiveCellResponse({ ...response, block_hash: hex32("ac") })).toMatchObject({ status: "live" });
    }
    expect(() => validateLiveCellResponse({ status: "dead", cell: null, block_hash: hex32("ac") })).toThrow();
  });
  test.each([
    ["S07 absent binding", undefined], ["S07 empty binding", {}],
    ["S07 empty deps", { ...bindings.dao, cellDeps: [] }],
    ["S07 duplicate binding dep", { ...bindings.dao, cellDeps: [bindings.dao!.cellDeps[0], bindings.dao!.cellDeps[0]] }],
    ...[-1, 1.5, true, 0x1_0000_0000, Number.MAX_SAFE_INTEGER + 1, "0"].map(index => ["S07 invalid binding index " + index, { ...bindings.dao, cellDeps: [{ outPoint: { txHash: hex32("21"), index }, depType: "code" }] }]),
    ["S07 wrong dep type", { ...bindings.dao, cellDeps: [{ outPoint: { txHash: hex32("21"), index: 0 }, depType: "dep_group" }] }],
    ["S07 unknown binding key", { ...bindings.dao, args: "0x" }],
  ].map(([name, binding]) => ({ name, binding })))("S07 invalid binding case %#", ({ binding }) => expect(() => validateBinding(binding)).toThrow());
  test("S07 duplicate tx deps rejected, extra distinct deps accepted", () => {
    const tx = syntheticReportV2().evidence.steps[0]!.transaction;
    expect(() => validateTransaction(tx)).not.toThrow();
    tx.cell_deps.push(structuredClone(tx.cell_deps[0]));
    expect(() => validateTransaction(tx)).toThrow("duplicate");
    for (const index of ["0x00", "0x100000000", 0, "0X0"]) {
      expect(() => validateDep({ out_point: { tx_hash: hex32("21"), index }, dep_type: "code" })).toThrow();
    }
  });

  for (const phase of ["immediate", "final"] as const) {
    const claims = (r: Wire) => phase === "immediate" ? r.evidence.steps[0].claims : r.evidence.assertions;
    test.each([
      ["V01 ok", (c: Wire) => { c.ok = false; }],
      ["V01 validity", (c: Wire) => { c.observationValid = false; }],
      ["V01 count", (c: Wire) => { c.observed.count = 0; }],
      ["V01 type alias", (c: Wire) => { c.observed.type.identity.name = "spore"; }],
      ["V01 args length", (c: Wire) => { c.observed.type.argsBytes = 1; }],
      ["V01 data length", (c: Wire) => { c.observed.dataBytes = 3; }],
      ["V01 extra observation", (c: Wire) => { c.observed.extra = true; }],
      ["V03 missing input", (c: Wire) => { delete c.input; }],
      ["V03 target retarget", (c: Wire) => { c.target.step = "unreferenced"; }],
      ["V03 unknown kind", (c: Wire) => { c.kind = "plugin"; }],
      ["V04 wrong input arm", (c: Wire) => { c.input = { kind: "missing-output" }; }],
      ["S09 wrong outpoint", (c: Wire) => { c.input.outPoint.tx_hash = hex32("ff"); }],
      ["S09 wrong capacity", (c: Wire) => { c.input.response.cell.output.capacity = "0x1"; }],
      ["S09 wrong lock", (c: Wire) => { c.input.response.cell.output.lock.args = "0x5678"; }],
      ["S09 wrong type", (c: Wire) => { c.input.response.cell.output.type.args = "0x11"; }],
      ["S09 wrong data", (c: Wire) => { const t = syntheticTransaction(); t.outputs_data = ["0xeeee"]; c.input.response.cell.data = liveResponse(t).cell.data; }],
    ] as const)(`%s ${phase} rehashed`, (_name, edit) => rejectMutation(r => edit(claims(r)[0])));
    test.each([[], [true], [true, true, true], [false, true], [true, false]].map(vector => ({ vector })))(`V04 dependency vector ${phase} case %#`, ({ vector }) => rejectMutation(r => { claims(r)[1].observed.present = vector; }));
    test(`V03 deleted/reordered claims ${phase}`, () => {
      rejectMutation(r => claims(r).pop()); rejectMutation(r => claims(r).reverse());
    });
  }
  test.each([
    ["V01 verdict", (r: Wire) => { r.verdict = "FAIL"; }],
    ["V01 outcome ok", (r: Wire) => { r.outcomeClaims.steps[0].claims[0].ok = false; }],
    ["V02 transaction deps", (r: Wire) => { r.evidence.steps[0].transaction.cell_deps.pop(); syncRaw(r); }],
    ["V02 transaction data", (r: Wire) => { r.evidence.steps[0].transaction.outputs_data = ["0x"]; syncRaw(r); }],
    ["V02 binding code", (r: Wire) => { r.environment.devnet.systemScripts.dao.codeHash = hex32("dd"); }],
    ["V02 binding deps", (r: Wire) => { r.environment.devnet.systemScripts.dao.cellDeps.reverse(); r.environment.devnet.systemScripts.dao.cellDeps[0].outPoint.index = 8; }],
    ["V03 missing manifest", (r: Wire) => { delete r.evidence.manifestText; }],
    ["V03 missing transaction", (r: Wire) => { delete r.evidence.steps[1].transaction; }],
    ["V03 missing binding", (r: Wire) => { delete r.environment.devnet.systemScripts.dao; }],
    ["S09 live rejected target", (r: Wire) => { r.evidence.steps[0].observedStatus = "rejected"; }],
    ["V05 evidence name", (r: Wire) => { r.evidence.name = "other"; r.outcomeClaims.name = "other"; }],
    ["V05 manifest name", (r: Wire) => { r.evidence.manifestText = r.evidence.manifestText.replace('name = "synthetic-cell-claims"', 'name = "other"'); }],
    ["V05 manifest spec", (r: Wire) => { r.evidence.manifestText = r.evidence.manifestText.replace("draft.4", "draft.3"); }],
    ["V05 evidence spec", (r: Wire) => { r.evidence.spec = "0.1.0-draft.3"; }],
    ["V05 outcome spec", (r: Wire) => { r.outcomeClaims.spec = "0.1.0-draft.3"; }],
    ["V06 unreferenced rename", (r: Wire) => { r.evidence.steps[1].name = "renamed"; r.outcomeClaims.steps[1].name = "renamed"; }],
    ["V06 unreferenced deletion", (r: Wire) => { r.evidence.steps.splice(1, 1); r.outcomeClaims.steps.splice(1, 1); }],
    ["V06 unreferenced reorder", (r: Wire) => { r.evidence.steps = [r.evidence.steps[0],r.evidence.steps[2],r.evidence.steps[1]]; r.outcomeClaims.steps = [r.outcomeClaims.steps[0],r.outcomeClaims.steps[2],r.outcomeClaims.steps[1]]; }],
    ["V06 expectation addition", (r: Wire) => { r.evidence.steps[1].expectedStatus = "committed"; }],
    ["V06 expectation omission", (r: Wire) => { delete r.evidence.steps[0].expectedStatus; }],
    ["V07 ckb", (r: Wire) => { r.environment.toolchain.requested.ckb = "0.210.0"; }],
    ["V07 offckb", (r: Wire) => { r.environment.toolchain.requested.offckb = "0.4.12"; }],
    ["V07 debugger addition", (r: Wire) => { r.environment.toolchain.requested.ckbDebugger = "1.1.1"; }],
    ["V07 requested extra", (r: Wire) => { r.environment.toolchain.requested.extra = "tool"; }],
    ["V08 external network vs stable empty", (r: Wire) => { r.evidence.manifestText = r.evidence.manifestText.replace("dependencies = []", 'dependencies = ["external_network"]'); }],
    ["V02 transaction hash", (r: Wire) => { r.evidence.steps[0].transactionHash = hex32("cc"); }],
    ["V01 outcome digest", (r: Wire) => { r.outcomeClaims.extra = 1; }],
  ] as const)("%s rehashed", (_name, edit) => rejectMutation(edit));

  test("V07 debugger omission/value and V08 declaration order checked before provenance", () => {
    for (const requested of [{ ckb: "0.209.0", offckb: "0.4.13" }, { ckb: "0.209.0", offckb: "0.4.13", ckbDebugger: "1.1.0" }]) {
      const r = syntheticReportV2();
      r.evidence.manifestText = r.evidence.manifestText.replace('offckb = "0.4.13"', 'offckb = "0.4.13"\nckb-debugger = "1.1.1"');
      Object.assign(r.environment.toolchain, { requested }); rehash(r);
      expect(() => bindManifestV2(r.evidence, r.environment)).toThrow("requested");
    }
    const r = syntheticReportV2(); r.evidence.manifestText = r.evidence.manifestText.replace("dependencies = []", 'dependencies = ["randomness", "external_network"]');
    r.environment.provenance.replay = { declaredDependencies: ["external_network", "randomness"], status: "tainted", reasons: ["external_network", "randomness"].map(code => ({ scope: "outcome", code: code as "randomness" | "external_network", detail: `manifest declares replay dependency ${code}` })) };
    rehash(r); expect(() => verifyReport(r)).toThrow("declaredDependencies");
  });
  test("V05 UTF-8 lone surrogate cannot be made valid by rehashing", () => rejectMutation(r => { r.evidence.manifestText += '# bad \ud800\n'; }));
  test("V01 both canonical digest mismatches fail without rehash", () => {
    for (const key of ["outcome", "environment"] as const) { const r = syntheticReportV2(); r.digests[key] = "sha256:" + "0".repeat(64); expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError); }
  });

  test("N01 consistent code/dep remap keeps outcome, changes environment", () => {
    const a = syntheticReportV2(), b: Wire = structuredClone(a);
    b.environment.devnet.systemScripts.dao.codeHash = hex32("aa");
    b.environment.devnet.systemScripts.dao.cellDeps[0].outPoint.txHash = hex32("bb");
    for (const s of b.evidence.steps) { s.transaction.outputs[0].type.code_hash = hex32("aa"); s.transaction.cell_deps[0].out_point.tx_hash = hex32("bb"); }
    syncRaw(b); regenerate(b);
    expect(b.digests.outcome).toBe(a.digests.outcome); expect(b.digests.environment).not.toBe(a.digests.environment);
  });
  test("N02 mismatch remains raw; no inverse alias lookup or scrub", () => {
    const r: Wire = syntheticReportV2();
    for (const s of r.evidence.steps) s.transaction.outputs[0].type.code_hash = bindings.spore!.codeHash;
    syncRaw(r); regenerate(r);
    expect(r.verdict).toBe("FAIL");
    expect(r.outcomeClaims.steps[0].claims[0].observed.type.identity).toEqual({ kind: "raw", codeHash: bindings.spore!.codeHash, hashType: "type" });
    r.evidence.steps[0].claims[0].observed.type.identity = { kind: "builtin", name: "dao" }; rehash(r);
    expect(() => verifyReport(r)).toThrow(EvidenceIntegrityError);
  });
  test("N03 same-length data/args and reordered tx deps preserve only declared semantics", () => {
    const a: Wire = syntheticReportV2();
    a.evidence.manifestText = a.evidence.manifestText.replaceAll("args_bytes = 0", "args_bytes = 1");
    for (const c of allCells(a)) c.expected.type.argsBytes = 1;
    for (const s of a.evidence.steps) s.transaction.outputs[0].type.args = "0xaa";
    syncRaw(a); regenerate(a);
    const b: Wire = structuredClone(a);
    for (const s of b.evidence.steps) { s.transaction.outputs_data = ["0xeeee"]; s.transaction.outputs[0].type.args = "0xbb"; s.transaction.cell_deps.reverse(); }
    syncRaw(b); regenerate(b); expect(b.digests.outcome).toBe(a.digests.outcome);
    b.evidence.steps[0].transaction.outputs_data = ["0xee"]; syncRaw(b); regenerate(b); expect(b.digests.outcome).not.toBe(a.digests.outcome);
    const c: Wire = structuredClone(a); c.evidence.steps[0].transaction.outputs[0].type.args = "0xaaaa"; syncRaw(c); regenerate(c); expect(c.digests.outcome).not.toBe(a.digests.outcome); expect(c.verdict).toBe("FAIL");
  });
  test("S08 member slots not tx positions; exact hash/index/type; export order retained", () => {
    for (const edit of [(d: Wire) => { d.out_point.tx_hash = hex32("ac"); }, (d: Wire) => { d.out_point.index = "0x1"; }, (d: Wire) => { d.dep_type = "dep_group"; }]) {
      const r: Wire = syntheticReportV2(); edit(r.evidence.steps[0].transaction.cell_deps[0]); syncRaw(r); regenerate(r);
      expect(r.evidence.steps[0].claims[1].observed.present).toEqual([false, true]); expect(r.verdict).toBe("FAIL");
      r.environment.devnet.systemScripts.dao.cellDeps.reverse(); regenerate(r); expect(r.evidence.steps[0].claims[1].observed.present).toEqual([true, false]);
    }
  });
  test("S04 S10 valid nonlive rejected candidate can satisfy count0 and deps, never properties", () => {
    for (const status of ["dead", "unknown"]) {
      const r: Wire = syntheticReportV2(); r.evidence.steps[0].observedStatus = "rejected";
      r.evidence.steps[0].rejection = { kind: "node", reason: "synthetic rejection" };
      for (const c of allCells(r)) c.input.response = { status, cell: null };
      regenerate(r); expect(r.evidence.steps[0].claims[0].ok).toBe(false); expect(r.evidence.steps[0].claims[1].ok).toBe(true);
      r.evidence.manifestText = r.evidence.manifestText.replace('expect.tx = "committed"\n', '').replaceAll('count = 1\ntype = { builtin = "dao", args_bytes = 0 }\ndata = { min_bytes = 1 }', 'count = 0');
      delete r.evidence.steps[0].expectedStatus;
      for (const c of allCells(r)) c.expected = { count: 0 };
      regenerate(r); expect(r.verdict).toBe("PASS");
    }
  });
  test("S06 missing index fails count0; no input inference from reason", () => {
    const r: Wire = syntheticReportV2();
    r.evidence.manifestText = r.evidence.manifestText.replaceAll('count = 1\ntype = { builtin = "dao", args_bytes = 0 }\ndata = { min_bytes = 1 }', 'count = 0');
    for (const c of allCells(r)) c.expected = { count: 0 };
    r.evidence.steps[0].transaction.outputs = []; r.evidence.steps[0].transaction.outputs_data = []; syncRaw(r); regenerate(r);
    expect(r.verdict).toBe("FAIL"); expect(r.evidence.steps[0].claims[0]).toMatchObject({ observed: { state: "missing-output", count: 0 }, observationValid: false, ok: false });
  });
  test("S09 absent/null type equivalence only and witnesses excluded by raw hash", () => {
    const r: Wire = syntheticReportV2(); for (const s of r.evidence.steps) delete s.transaction.outputs[0].type;
    syncRaw(r); for (const c of allCells(r)) c.input.response.cell.output.type = null;
    regenerate(r); expect(r.verdict).toBe("FAIL");
    const before = r.digests.outcome; r.evidence.steps[0].transaction.witnesses = ["0x1234"]; verifyReport(r); expect(r.digests.outcome).toBe(before);
  });
  test("L01 exact report2 tuple refuses legacy opt-in and missing/unknown/mixed schemas", () => {
    const paths = [["schema"], ["outcomeClaims", "schema"], ["environment", "schema"], ["environment", "provenance", "schema"]];
    for (const path of paths) for (const replacement of [undefined, null, "unknown", "ckb-verify-report/1", "ckb-verify-environment/2", "ckb-verify-provenance/1"]) {
      const r: Wire = syntheticReportV2(); let o = r; for (const key of path.slice(0,-1)) o = o[key];
      if (replacement === undefined) delete o[path.at(-1)!]; else o[path.at(-1)!] = replacement;
      rehash(r); expect(() => verifyReport(r, { allowLegacy: true })).toThrow(EvidenceIntegrityError);
    }
  });
});
