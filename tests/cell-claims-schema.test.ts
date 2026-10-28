import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { bindings, liveResponse, manifest4, syntheticReportV2, syntheticTransaction } from "./fixtures/claims-v2/synthetic";
import { parseManifestText } from "../src/manifest";
import { validateBinding, validateDep, validateLiveCellResponse, validateOutput, validateScript, validateTransaction } from "../src/cell-claims";
import { verifyReport } from "../src/report";
import { canonicalSha256 } from "../src/canonical";

const file = Bun.file(new URL('../schemas/ckb-verify-claims-v2.schema.json', import.meta.url));
test("P06 publishes a bounded fragment with discriminated exact semantic definitions", async () => {
  expect(await file.exists()).toBe(true);
  const schema = await file.json();
  expect(schema.$comment).toContain("not a complete report");
  const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addSchema(schema);
  const report = syntheticReportV2();
  for (const [name, value] of [
    ['claimEvidence', report.evidence.steps[0]!.claims[0]], ['claimEvidence', report.evidence.steps[0]!.claims[1]],
    ['claimOutcome', report.outcomeClaims.steps[0]!.claims[0]], ['claimOutcome', report.outcomeClaims.steps[0]!.claims[1]],
    ['transaction', report.evidence.steps[0]!.transaction], ['binding', report.environment.devnet.systemScripts.dao],
  ] as const) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
});

// Wire corruption intentionally bypasses static types; validators see the same object.
type Wire = any;
const schema = await file.json();
const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addSchema(schema);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function shape(name: string, value: unknown): boolean {
  let check = validators.get(name);
  if (check === undefined) { check = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }); validators.set(name, check); }
  return check(value) as boolean;
}
function runtime(check: () => unknown): boolean { try { check(); return true; } catch { return false; } }
function parity(name: string, value: unknown, check: () => unknown, valid: boolean): void {
  expect(shape(name, value)).toBe(valid); expect(runtime(check)).toBe(valid);
}
describe("P06 schema/runtime parity", () => {
  test.each(["all-hole", "leading", "middle", "trailing", "explicit-null"])("SPEC02 binding sparse/null runtime and Ajv both reject %s", form => {
    const b: Wire = JSON.parse(JSON.stringify(bindings.dao)), [a, z] = b.cellDeps;
    b.cellDeps = form === "all-hole" ? Array(1) : form === "leading" ? [, a, z] :
      form === "middle" ? [a, , z] : form === "trailing" ? [a, z, ,] : [null];
    parity("binding", b, () => validateBinding(b), false);
    const serialized = JSON.parse(JSON.stringify(b));
    parity("binding", serialized, () => validateBinding(serialized), false);
  });
  test("SPEC01 descriptors are a retention check, not JSON Schema vocabulary", () => {
    const b: Wire = JSON.parse(JSON.stringify(bindings.dao));
    Object.defineProperty(b, "codeHash", { enumerable: false });
    expect(() => validateBinding(b)).toThrow("codeHash");
    const serialized = JSON.parse(JSON.stringify(b));
    parity("binding", serialized, () => validateBinding(serialized), false);
    const dense: Wire = JSON.parse(JSON.stringify(bindings.dao));
    Object.defineProperty(dense.cellDeps, "0", { enumerable: false });
    parity("binding", dense, () => validateBinding(dense), true);
    expect(shape("binding", JSON.parse(JSON.stringify(dense)))).toBe(true);
  });
  test("S03 exact-hex terminators agree and both reject", () => {
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      for (const s of [
        { code_hash: bindings.dao!.codeHash + suffix, hash_type: 'type', args: '0x' },
        { code_hash: bindings.dao!.codeHash, hash_type: 'type', args: '0xab' + suffix },
      ]) parity('script', s, () => validateScript(s), false);
      const o: Wire = syntheticTransaction().outputs[0]; o.capacity = '0x1' + suffix;
      parity('output', o, () => validateOutput(o), false);
      const d = { out_point: { tx_hash: bindings.dao!.codeHash, index: '0x1' + suffix }, dep_type: 'code' };
      parity('dep', d, () => validateDep(d), false);
    }
  });
  test("all fragment definitions compile strictly; root is not a whole-report schema", () => {
    for (const name of Object.keys(schema.$defs)) ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
    expect(ajv.validate(schema.$id, syntheticReportV2())).toBe(false);
  });
  test.each([
    ['', true], ['type = { builtin = "dao", args_bytes = 0 }', true],
    ['type = { builtin = "spore", args_bytes = 1048576 }\ndata = { min_bytes = 1048576 }', true],
    ['data = { min_bytes = 1 }', true], ['data = { min_bytes = 0 }', false],
    ['data = { min_bytes = 1048577 }', false], ['type = { builtin = "dao" }', false],
    ['type = { args_bytes = 0 }', false], ['type = { builtin = "DAO", args_bytes = 0 }', false],
    ['type = { builtin = "dao", args_bytes = -1 }', false], ['data = { min_bytes = true }', false],
    ['data = { min_bytes = 1.5 }', false], ['data = { min_bytes = 1, hash = "0x" }', false],
    ['unknown = true', false],
  ] as const)("manifest cell property %#", (property, valid) => {
    for (const boundary of ['step.assert.cell', 'assert.cell']) {
      const text = manifest4(property).replace('step.assert.cell', boundary);
      const raw: Wire = Bun.TOML.parse(text);
      const container = boundary === 'step.assert.cell' ? raw.step[0].assert : raw.assert;
      parity('manifestAssertions', container, () => parseManifestText(text), valid);
    }
  });
  test("count/property and u32 conditions agree", () => {
    for (const [from, to, valid] of [['count = 1','count = 0',false], ['count = 1','count = 2',false], ['index = 0','index = 4294967296',false], ['index = 0','index = 4294967295',true]] as const) {
      const text = manifest4().replace(from, to), raw: Wire = Bun.TOML.parse(text);
      parity('manifestAssertions', raw.step[0].assert, () => parseManifestText(text), valid);
    }
  });
  test.each(['{ builtin = "dao" }', '{ builtin = "spore" }', '{}', '{ builtin = "DAO" }', '{ builtin = "dao", index = 0 }'])("dependency manifest %s", contains => {
    const text = manifest4('') + `\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = ${contains}\n`;
    const raw: Wire = Bun.TOML.parse(text);
    parity('manifestAssertions', raw.step[0].assert, () => parseManifestText(text), contains === '{ builtin = "dao" }' || contains === '{ builtin = "spore" }');
  });
  test("normalized claim definitions preserve bounds and exact union shapes", () => {
    const m = parseManifestText(manifest4() + '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }');
    for (const claim of m.steps[0]!.assertions) expect(shape('claim', claim)).toBe(true);
    const c: Wire = structuredClone(m.steps[0]!.assertions[0]); c.count = 0; expect(shape('claim', c)).toBe(false);
    c.count = 1; c.type.extra = 1; expect(shape('claim', c)).toBe(false);
  });
  test.each([
    ['script', () => ({ code_hash: bindings.dao!.codeHash, hash_type: 'data2', args: '0x' }), validateScript],
    ['output', () => syntheticTransaction().outputs[0], validateOutput],
    ['binding', () => structuredClone(bindings.dao), validateBinding],
    ['dep', () => syntheticReportV2().evidence.steps[0]!.transaction.cell_deps[0], validateDep],
    ['liveCellResponse', () => liveResponse(syntheticTransaction()), validateLiveCellResponse],
    ['transaction', () => syntheticTransaction(), validateTransaction],
  ] as const)("semantic exact keys %s", (name, make, check) => {
    const good = make(); parity(name, good, () => check(good), true);
    const bad: Wire = make(); bad.extra = 'unsupported'; parity(name, bad, () => check(bad), false);
    for (const key of Object.keys(good!)) { const absent: Wire = make(); delete absent[key];
      if ((name === 'output' && key === 'type') || (name === 'liveCellResponse' && key === 'block_hash')) continue;
      parity(name, absent, () => check(absent), false);
    }
  });
  test("byte and integer shape boundaries agree before hashing", () => {
    for (const value of ['0x', '0x00', '0xAB', '0x1', '0xgg', null, true, '0x' + 'ab'.repeat(1048576), '0x' + 'ab'.repeat(1048577)]) {
      const s = { code_hash: bindings.dao!.codeHash, hash_type: 'type', args: value };
      expect(shape('script', s)).toBe(runtime(() => validateScript(s)));
    }
    for (const index of [0, 4294967295, -1, 1.5, 4294967296, true, '0']) {
      const b: Wire = structuredClone(bindings.dao); b.cellDeps[0].outPoint.index = index;
      expect(shape('binding', b)).toBe(runtime(() => validateBinding(b)));
    }
  });
  test("nonlive discriminator and optional null block hash agree", () => {
    for (const status of ['dead', 'unknown', 'live', 'pending', null]) for (const block_hash of [null, bindings.dao!.codeHash]) {
      const response = { status, cell: null, block_hash };
      expect(shape('liveCellResponse', response)).toBe(runtime(() => validateLiveCellResponse(response)));
    }
  });
  test("empty/duplicate referenced bindings and tx deps are rejected", () => {
    const b = structuredClone(bindings.dao!); b.cellDeps = []; parity('binding', b, () => validateBinding(b), false);
    b.cellDeps = [bindings.dao!.cellDeps[0]!, bindings.dao!.cellDeps[0]!]; parity('binding', b, () => validateBinding(b), false);
    const t = syntheticReportV2().evidence.steps[0]!.transaction; t.cell_deps.push(structuredClone(t.cell_deps[0])); parity('transaction', t, () => validateTransaction(t), false);
  });
  test.each([
    (c: Wire) => { c.observed.extra = true; }, (c: Wire) => { c.observed.type.identity.kind = 'plugin'; },
    (c: Wire) => { c.observed.type.argsBytes = -1; }, (c: Wire) => { c.expected.count = 0; },
    (c: Wire) => { c.input.outPoint.index = '0x00'; }, (c: Wire) => { c.input.extra = true; },
    (c: Wire) => { c.kind = 'plugin'; }, (c: Wire) => { delete c.observed; },
  ])("claim evidence exact-shape rehashed refusal %#", edit => {
    const r: Wire = syntheticReportV2(); edit(r.evidence.steps[0].claims[0]);
    r.digests = { outcome: canonicalSha256(r.outcomeClaims), environment: canonicalSha256(r.environment) };
    parity('claimEvidence', r.evidence.steps[0].claims[0], () => verifyReport(r), false);
  });
  test("schema alone deliberately cannot establish hashes, alignment or truth", () => {
    const response = liveResponse(syntheticTransaction()); response.cell.data.hash = bindings.dao!.codeHash;
    expect(shape('liveCellResponse', response)).toBe(true); expect(() => validateLiveCellResponse(response)).toThrow('hash');
    const tx = syntheticTransaction(); tx.outputs_data = [];
    expect(shape('transaction', tx)).toBe(true); expect(() => validateTransaction(tx)).toThrow('alignment');
    const r: Wire = syntheticReportV2(); r.evidence.steps[0].claims[0].ok = false;
    expect(shape('claimEvidence', r.evidence.steps[0].claims[0])).toBe(true); expect(() => verifyReport(r)).toThrow();
  });
});
