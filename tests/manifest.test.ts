import { describe, expect, test } from "bun:test";
import { ManifestError, parseManifestText } from "../src/manifest";
import { manifest4 } from "./fixtures/claims-v2/synthetic";

const depTable = '\n[[step.assert.cell_deps]]\nstep = "produce"\ncontains = { builtin = "dao" }\n';
describe("draft.4 parser closure", () => {
  test.each(['type = { builtin = "dao", args_bytes = 0 }', 'data = { min_bytes = 1 }', 'type = { builtin = "spore", args_bytes = 32 }\ndata = { min_bytes = 8 }', ''])(
    "P01 immediate and final cell forms %s", property => {
      const text = manifest4(property);
      const root = text.replace('[[step.assert.cell]]', '[[assert.cell]]');
      expect(parseManifestText(text).steps[0]!.assertions).toEqual(parseManifestText(root).assertions);
    });
  test("P01 dep-only accepted without expectation, cells then deps and repeats preserved", () => {
    const base = manifest4('').split('[[step.assert.cell]]')[0]!.replace('expect.tx = "committed"\n', '');
    const depOnly = base + depTable;
    expect(parseManifestText(depOnly).steps[0]!.assertions).toEqual([{ kind: "cell_deps", step: "produce", contains: { kind: "builtin", name: "dao" } }]);
    const mixed = depOnly + '\n[[step.assert.cell]]\nout_point = { step = "produce", index = 0 }\ncount = 0\n' + depTable;
    expect(parseManifestText(mixed).steps[0]!.assertions.map(c => c.kind)).toEqual(["cell", "cell_deps", "cell_deps"]);
    expect(parseManifestText(depOnly.replace('step.assert.cell_deps', 'assert.cell_deps')).assertions).toHaveLength(1);
  });
  for (const [name, property, path] of [
    ["unknown cell", "extra = 0", "extra"],
    ["type primitive", "type = 1", "type"],
    ["data primitive", "data = []", "data"],
    ["unknown type", 'type = { builtin = "dao", args_bytes = 0, code_hash = "x" }', "type.code_hash"],
    ["unknown data", 'data = { min_bytes = 1, content = "x" }', "data.content"],
    ["missing builtin", 'type = { args_bytes = 0 }', "type.builtin"],
    ["missing args", 'type = { builtin = "dao" }', "type.args_bytes"],
    ["missing min", 'data = {}', "data.min_bytes"],
    ["wrong alias case", 'type = { builtin = "Dao", args_bytes = 0 }', "type.builtin"],
    ["unknown alias", 'type = { builtin = "custom", args_bytes = 0 }', "type.builtin"],
  ]) test(`P02 ${name} has full path`, () => {
    expect(() => parseManifestText(manifest4(property))).toThrow(`step[0].assert.cell[0].${path}`);
  });
  for (const [from, to, path] of [
    ['contains = { builtin = "dao" }', 'contains = { builtin = "dao", args = "0x" }', "contains.args"],
    ['contains = { builtin = "dao" }', 'contains = {}', "contains.builtin"],
    ['contains = { builtin = "dao" }', 'contains = true', "contains"],
    ['contains = { builtin = "dao" }', 'contains = { builtin = "DAO" }', "contains.builtin"],
    ['step = "produce"', 'step = "produce"\nindex = 0', "index"],
    ['step = "produce"', 'step = 1', "step"],
    ['step = "produce"\n', '', "step"],
  ]) test(`P02 deps reject ${to} at ${path}`, () => {
    expect(() => parseManifestText(manifest4('') + depTable.replace(from!, to!))).toThrow(`step[0].assert.cell_deps[0].${path}`);
  });
  test("P02 unknown containers and outpoint keys, wrong arrays/tables", () => {
    for (const text of [manifest4('').replace('out_point = {', 'out_point = { hash = "x",'), manifest4('').replace('[[step.assert.cell]]', '[step.assert.cell]'), manifest4('').replace('[[step.assert.cell]]', '[[step.assert.plugin]]'), manifest4('') + depTable.replace('[[step.assert.cell_deps]]', '[step.assert.cell_deps]')]) expect(() => parseManifestText(text)).toThrow(ManifestError);
  });
  test("P03 immediate current/earlier only, final any declared step, literal names", () => {
    const later = '\n[[step]]\nname = "later"\nrun = "fake"\n';
    for (const claim of [manifest4('').replace('step = "produce"', 'step = "later"'), manifest4('') + depTable.replace('step = "produce"', 'step = "later"')]) expect(() => parseManifestText(claim + later)).toThrow("earlier");
    expect(parseManifestText(manifest4('').replace('step.assert.cell', 'assert.cell').replace('step = "produce"', 'step = "later"') + later).assertions).toHaveLength(1);
    expect(() => parseManifestText(manifest4('').replace('step = "produce"', 'step = "Produce"'))).toThrow("out_point.step");
    expect(() => parseManifestText(manifest4('') + later.replace('name = "later"', 'name = "produce"'))).toThrow("duplicated");
  });
  test("P03 P04 numeric selectors enforce safe u32 and binary count", () => {
    for (const bad of ["-1", "0.5", "true", '"0"', "4294967296", "9007199254740992"]) expect(() => parseManifestText(manifest4('').replace('index = 0', `index = ${bad}`))).toThrow("out_point.index");
    expect(parseManifestText(manifest4('').replace('index = 0', 'index = 4294967295')).steps[0]!.assertions).toHaveLength(1);
    for (const bad of ["-1", "0.5", "true", '"1"', "2", "9007199254740992"]) expect(() => parseManifestText(manifest4('').replace('count = 1', `count = ${bad}`))).toThrow("count");
    for (const count of [0, 1]) expect(() => parseManifestText(manifest4('').replace('count = 1', `count = ${count}`))).not.toThrow();
    for (const property of ['type = { builtin = "dao", args_bytes = 0 }', 'data = { min_bytes = 1 }']) expect(() => parseManifestText(manifest4(property).replace('count = 1', 'count = 0'))).toThrow("requires count = 1");
  });
  test("P05 sizes at inclusive bounds and invalid primitives", () => {
    for (const args of [0, 1048576]) expect(() => parseManifestText(manifest4(`type = { builtin = "dao", args_bytes = ${args} }`))).not.toThrow();
    for (const size of [1, 1048576]) expect(() => parseManifestText(manifest4(`data = { min_bytes = ${size} }`))).not.toThrow();
    for (const bad of ["-1", "1.5", "true", '"0x11"', "1048577", "9007199254740992"]) {
      expect(() => parseManifestText(manifest4(`type = { builtin = "dao", args_bytes = ${bad} }`))).toThrow("args_bytes");
      expect(() => parseManifestText(manifest4(`data = { min_bytes = ${bad} }`))).toThrow("min_bytes");
    }
    expect(() => parseManifestText(manifest4('data = { min_bytes = 0 }'))).toThrow("min_bytes");
  });
  test("P04 L02 draft.3 count>1 remains valid and rejects every new syntax", () => {
    expect(parseManifestText(manifest4('').replace('draft.4', 'draft.3').replace('count = 1', 'count = 42')).steps[0]!.assertions).toMatchObject([{ count: 42 }]);
    for (const text of [manifest4(), manifest4('data = { min_bytes = 1 }'), manifest4('') + depTable, manifest4('') + depTable.replace('step.assert.cell_deps', 'assert.cell_deps')]) expect(() => parseManifestText(text.replace('draft.4', 'draft.3'))).toThrow("not supported");
  });
  test("P02 spec dispatch precedes assertion validation", () => {
    expect(() => parseManifestText(manifest4('plugin = 1').replace('draft.4', 'draft.99'))).toThrow("meta.spec");
  });
});

const VALID = `
[meta]
name = "secp-transfer"
spec = "0.1.0-draft.3"
description = "runner-owned transfer"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "transfer"
run = "bun run showcases/secp-transfer/produce.ts committed"
timeout = "45s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "transfer", index = 0 }
count = 1
`;

function replace(source: string, from: string, to: string): string {
  const result = source.replace(from, to);
  if (result === source) throw new Error(`test replacement did not match: ${from}`);
  return result;
}

function expectManifestError(source: string, message: string): void {
  expect(() => parseManifestText(source, "verify.toml")).toThrow(ManifestError);
  expect(() => parseManifestText(source, "verify.toml")).toThrow(message);
}

describe("parseManifestText", () => {
  test("requires the supported exact debugger pin for every declared rejection", () => {
    const rejected = VALID.replace('expect.tx = "committed"', 'expect.tx = "rejected"');
    expectManifestError(rejected, "rejected transactions require toolchain.ckb-debugger");
    const pinned = rejected.replace('offckb = "0.4.13"', 'offckb = "0.4.13"\nckb-debugger = "1.1.1"');
    expect(parseManifestText(pinned).toolchain.ckbDebugger).toBe("1.1.1");
    for (const bad of ["latest", "1.1.2", "01.1.1", "v1.1.1"]) {
      expect(() => parseManifestText(pinned.replace('ckb-debugger = "1.1.1"', `ckb-debugger = "${bad}"`))).toThrow(ManifestError);
    }
    expect(parseManifestText(VALID).toolchain.ckbDebugger).toBeUndefined();
  });
  test("normalizes the supported manifest subset", () => {
    const manifest = parseManifestText(VALID, "verify.toml");

    expect(manifest).toEqual({
      meta: {
        name: "secp-transfer",
        spec: "0.1.0-draft.3",
        description: "runner-owned transfer",
      },
      toolchain: { ckb: "0.209.0", offckb: "0.4.13" },
      replay: { dependencies: [] },
      setup: { accounts: 2 },
      steps: [
        {
          name: "transfer",
          run: "bun run showcases/secp-transfer/produce.ts committed",
          timeoutMs: 45_000,
          expect: { tx: "committed" },
          assertions: [
            {
              kind: "cell",
              outPoint: { step: "transfer", index: 0 },
              count: 1,
            },
          ],
        },
      ],
      assertions: [],
    });
  });

  test("rejects unknown nested keys with their manifest path", () => {
    const source = replace(VALID, 'expect.tx = "committed"', 'expect.tx = "committed"\nexpect.typo = true');

    expectManifestError(source, "step[0].expect.typo is not supported");
  });

  test("rejects a vacuous claim set", () => {
    const source = VALID.replace('expect.tx = "committed"\n', "").replace(/\n\[\[step\.assert\.cell\]\][\s\S]*$/, "\n");

    expectManifestError(source, "manifest must declare at least one expectation or assertion");
  });

  test("rejects duplicate step names", () => {
    const source = `${VALID}\n[[step]]\nname = "transfer"\nrun = "true"\n`;

    expectManifestError(source, 'step name "transfer" is duplicated');
  });

  test("rejects output references to later steps", () => {
    const source = replace(VALID, 'step = "transfer"', 'step = "later"') + '\n[[step]]\nname = "later"\nrun = "true"\n';

    expectManifestError(source, 'step[0].assert.cell[0].out_point.step must reference this or an earlier step');
  });

  test("rejects invalid or unsafe output indices", () => {
    const negative = replace(VALID, "index = 0", "index = -1");
    const unsafe = replace(VALID, "index = 0", "index = 9007199254740992");

    expectManifestError(negative, "step[0].assert.cell[0].out_point.index must be a non-negative safe integer");
    expectManifestError(unsafe, "step[0].assert.cell[0].out_point.index must be a non-negative safe integer");
  });

  test("requires the implemented spec and OffCKB adapter versions", () => {
    expectManifestError(
      replace(VALID, 'spec = "0.1.0-draft.3"', 'spec = "0.1.0-draft.9"'),
      'meta.spec must equal "0.1.0-draft.3"',
    );
    expectManifestError(
      replace(VALID, 'offckb = "0.4.13"', 'offckb = "0.4.12"'),
      'toolchain.offckb must equal "0.4.13"',
    );
  });

  test("validates timeout and account bounds", () => {
    expectManifestError(replace(VALID, 'timeout = "45s"', 'timeout = "0s"'), "step[0].timeout must be between 1s and 600s");
    expectManifestError(replace(VALID, "accounts = 2", "accounts = 21"), "setup.accounts must be an integer between 1 and 20");
  });

  test("accepts the RFC replay dependency vocabulary and rejects duplicates or unknown values", () => {
    const declared = replace(
      VALID,
      "dependencies = []",
      'dependencies = ["external_time", "randomness", "fee_estimation", "dynamic_since", "external_network"]',
    );

    expect(parseManifestText(declared).replay.dependencies).toEqual([
      "external_time",
      "randomness",
      "fee_estimation",
      "dynamic_since",
      "external_network",
    ]);
    expectManifestError(
      replace(VALID, "dependencies = []", 'dependencies = ["external_time", "external_time"]'),
      "replay.dependencies must not contain duplicates",
    );
    expectManifestError(
      replace(VALID, "dependencies = []", 'dependencies = ["wall_clock"]'),
      "replay.dependencies[0] must be a supported replay dependency",
    );
  });
});
