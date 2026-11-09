// Spec 0.2.0 grammar: repository scripts, named references, pure steps, zero steps and accounts, error groups.
import { describe, expect, test } from "bun:test";
import { ManifestError, parseManifestText } from "../src/manifest";
import { validateRepositoryPath } from "../src/manifest-v6";
import { MANIFEST_V2_SCHEMA_ID, schemaProblems } from "../src/schemas";
import type { ManifestV6 } from "../src/types";

const HEAD = `[meta]
name = "v6"
spec = "0.2.0"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
ckb-debugger = "1.1.1"

[replay]
dependencies = []
`;
const SCRIPTS = `
[setup.scripts.lock_a]
binary = "build/lock_a"
hash_type = "type"

[setup.scripts.lock_b]
binary = "build/lock_a"
hash_type = "data1"

[setup.scripts.sighash]
builtin = "secp256k1_blake160_sighash_all"
`;
const manifest = (body: string, setup = `\n[setup]\naccounts = 2\n${SCRIPTS}`) => `${HEAD}${setup}\n${body}`;
const parse = (text: string) => parseManifestText(text, "verify.toml") as ManifestV6;
const rejects = (text: string, message: string) => {
  expect(() => parseManifestText(text, "verify.toml")).toThrow(ManifestError);
  expect(() => parseManifestText(text, "verify.toml")).toThrow(message);
};
const schema = (text: string) => schemaProblems(MANIFEST_V2_SCHEMA_ID, Bun.TOML.parse(text));

describe("spec 0.2.0 setup", () => {
  test("binary and builtin scripts parse in declaration order", () => {
    const m = parse(manifest(`[[assert.cell]]\nlock = "lock_a"\ncount = 0\n`));
    expect(m.setup).toEqual({ accounts: 2, scripts: [
      { name: "lock_a", kind: "binary", path: "build/lock_a", hashType: "type" },
      { name: "lock_b", kind: "binary", path: "build/lock_a", hashType: "data1" },
      { name: "sighash", kind: "builtin", builtin: "secp256k1_blake160_sighash_all" },
    ] });
    expect(schema(manifest(`[[assert.cell]]\nlock = "lock_a"\ncount = 0\n`))).toEqual([]);
  });

  test("zero accounts and zero steps are accepted when a claim exists", () => {
    const m = parse(manifest(`[[assert.cell]]\nlock = "lock_a"\ncount = 0\n`, `\n[setup]\naccounts = 0\n${SCRIPTS}`));
    expect(m.setup.accounts).toBe(0);
    expect(m.steps).toEqual([]);
  });

  test("an empty claim set is still refused", () => {
    rejects(manifest(""), "manifest must declare at least one expectation or assertion");
    rejects(manifest(`[[step]]\nname = "noop"\nrun = "true"\n`), "manifest must declare at least one expectation or assertion");
  });

  test("a script defines exactly one of binary or builtin, with valid names and hash types", () => {
    rejects(manifest("", `\n[setup]\naccounts = 1\n[setup.scripts.x]\nbinary = "a"\nbuiltin = "xudt"\nhash_type = "type"\n`), "exactly one of binary or builtin");
    rejects(manifest("", `\n[setup]\naccounts = 1\n[setup.scripts.x]\nbinary = "a"\n`), "hash_type must be type, data, data1, or data2");
    rejects(manifest("", `\n[setup]\naccounts = 1\n[setup.scripts.x]\nbuiltin = "xudt"\nhash_type = "type"\n`), "hash_type is not supported with builtin");
    rejects(manifest("", `\n[setup]\naccounts = 1\n[setup.scripts.x]\nbuiltin = "nope"\n`), "builtin must be one of the OffCKB system scripts");
    rejects(manifest("", `\n[setup]\naccounts = 1\n[setup.scripts.Bad-Name]\nbuiltin = "xudt"\n`), "script names must match");
  });

  test("binary paths stay inside the repository", () => {
    for (const bad of ["/abs", "../up", "a/../b", "a//b", "./a", "a\\b", "C:/x"]) {
      expect(() => validateRepositoryPath(bad, "p", "verify.toml")).toThrow(ManifestError);
    }
    expect(validateRepositoryPath("build/lock", "p", "verify.toml")).toBe("build/lock");
    expect(schema(manifest(`[[assert.cell]]\nlock = "lock_a"\ncount = 0\n`, `\n[setup]\naccounts = 1\n[setup.scripts.lock_a]\nbinary = "../x"\nhash_type = "type"\n`)).length).toBeGreaterThan(0);
  });

  test("deploying caps the exported accounts below OffCKB's deployer", () => {
    rejects(manifest(`[[assert.cell]]\nlock = "lock_a"\ncount = 0\n`, `\n[setup]\naccounts = 20\n${SCRIPTS}`), "at most 19 when setup.scripts deploys a binary");
    // A builtin alias deploys nothing, so all 20 accounts remain available.
    expect(parse(manifest(`[[assert.cell]]\nlock = "sighash"\ncount.gte = 0\n`, `\n[setup]\naccounts = 20\n[setup.scripts.sighash]\nbuiltin = "secp256k1_blake160_sighash_all"\n`)).setup.accounts).toBe(20);
  });
});

describe("spec 0.2.0 named references", () => {
  test("bare names are wildcards; tables carry exact args", () => {
    const m = parse(manifest(`[[assert.cell]]\nlock = "lock_a"\ntype = { script = "lock_b", args = "0x01" }\ncount = 0\n`));
    expect(m.assertions[0]).toMatchObject({ selector: { lock: { kind: "setup", name: "lock_a", args: null }, type: { kind: "setup", name: "lock_b", args: "0x01" } } });
  });

  test("unknown names are refused, and exact targets need args", () => {
    rejects(manifest(`[[assert.cell]]\nlock = "missing"\ncount = 0\n`), `names an unknown setup script "missing"`);
    rejects(manifest(`[[assert.balance]]\nlock = "lock_a"\ngte = "1 CKB"\n`), "needs exact args here");
    rejects(manifest(`[[assert.balance]]\nlock = { script = "lock_a" }\ngte = "1 CKB"\n`), "args is required here");
    expect(parse(manifest(`[[assert.balance]]\nlock = { script = "lock_a", args = "0x01" }\ngte = "1 CKB"\n`)).assertions[0]).toMatchObject({ target: { kind: "lock", script: { kind: "setup", name: "lock_a", args: "0x01" } } });
  });

  test("dependency membership accepts a setup script", () => {
    const m = parse(manifest(`[[step]]\nname = "t"\nrun = "x"\nexpect.tx = "committed"\n\n[[step.assert.cell_deps]]\nstep = "t"\ncontains = { script = "lock_a" }\n`));
    expect(m.steps[0]!.assertions[0]).toEqual({ kind: "cell_deps", step: "t", contains: { kind: "setup", name: "lock_a" } });
  });

  test("0.1.0 still refuses named references", () => {
    const text = manifest(`[[step]]\nname = "t"\nrun = "x"\nexpect.tx = "committed"\n\n[[assert.cell]]\nlock = "lock_a"\ncount = 0\n`, `\n[setup]\naccounts = 2\n`).replace('spec = "0.2.0"', 'spec = "0.1.0"');
    rejects(text, "named setup scripts are not supported");
  });
});

describe("spec 0.2.0 steps", () => {
  test("a step without expect is pure; with expect it produces a transaction", () => {
    const m = parse(manifest(`[[step]]\nname = "look"\nrun = "x"\n\n[[step.assert.cell]]\nlock = "lock_a"\ncount = 0\n\n[[step]]\nname = "send"\nrun = "y"\nexpect.tx = "committed"\n`));
    expect(m.steps.map((s) => s.kind)).toEqual(["pure", "transaction"]);
  });

  test("out-point and dependency claims cannot target a pure step", () => {
    rejects(manifest(`[[step]]\nname = "look"\nrun = "x"\n\n[[assert.cell]]\nout_point = { step = "look", index = 0 }\ncount = 0\n`), `references pure step "look"`);
    rejects(manifest(`[[step]]\nname = "look"\nrun = "x"\n\n[[step.assert.cell_deps]]\nstep = "look"\ncontains = { builtin = "xudt" }\n`), `references pure step "look"`);
  });

  test("expect requires tx; error requires rejected", () => {
    rejects(manifest(`[[step]]\nname = "t"\nrun = "x"\nexpect.cycles.lt = 5\n`), "tx must be");
    rejects(manifest(`[[step]]\nname = "t"\nrun = "x"\nexpect.tx = "committed"\nexpect.error.code = 1\n`), "error requires tx = \"rejected\"");
  });
});

describe("spec 0.2.0 expect.error.group", () => {
  const step = (group: string) => manifest(`[[step]]\nname = "t"\nrun = "x"\nexpect.tx = "rejected"\nexpect.error.code = 42\nexpect.error.group = ${group}\n`);
  test("named, builtin, explicit, and account groups parse", () => {
    expect((parse(step(`{ role = "lock", script = "lock_a", args = "0x01" }`)).steps[0] as Extract<ManifestV6["steps"][number], { kind: "transaction" }>).expect.error)
      .toEqual({ code: 42, group: { role: "lock", script: { kind: "setup", name: "lock_a", args: "0x01" } } });
    expect((parse(step(`{ role = "type", builtin = "xudt" }`)).steps[0] as never as { expect: { error: unknown } }).expect.error)
      .toEqual({ code: 42, group: { role: "type", script: { kind: "builtin", name: "xudt", args: null } } });
    expect((parse(step(`{ role = "lock", account = 1 }`)).steps[0] as never as { expect: { error: unknown } }).expect.error)
      .toEqual({ code: 42, group: { role: "lock", script: { kind: "account", index: 1 } } });
    expect(schema(step(`{ role = "lock", script = "lock_a", args = "0x01" }`))).toEqual([]);
  });

  test("role is required and constrains account references", () => {
    rejects(step(`{ script = "lock_a" }`), "role must be");
    rejects(step(`{ role = "type", account = 0 }`), "only valid for lock references");
    rejects(step(`{ role = "lock", account = 5 }`), "below setup.accounts");
    rejects(step(`{ role = "lock" }`), "requires a script reference besides role");
    rejects(step(`{ role = "lock", script = "nope" }`), "unknown setup script");
  });

  test("a group needs a rejected expectation and the pinned debugger", () => {
    rejects(manifest(`[[step]]\nname = "t"\nrun = "x"\nexpect.tx = "committed"\nexpect.error.group = { role = "lock", script = "lock_a" }\n`), "requires tx = \"rejected\"");
    rejects(step(`{ role = "lock", script = "lock_a" }`).replace('ckb-debugger = "1.1.1"\n', ""), "rejected transactions require toolchain.ckb-debugger");
  });
});
