import { describe, expect, test } from "bun:test";
import { ccc } from "@ckb-ccc/core";
import { decodeFullAddress } from "../src/address";
import { parseManifestText } from "../src/manifest";
import { parseQuantity } from "../src/manifest-v5";
import { isManifestV5, type BalanceAssertionV5, type CellAssertionV5 } from "../src/types";

const HEAD = `[meta]\nname = "draft5"\nspec = "0.1.0-draft.5"\n[toolchain]\nckb = "0.209.0"\noffckb = "0.4.13"\n[replay]\ndependencies = []\n[setup]\naccounts = 2\n`;
const STEP = `[[step]]\nname = "mint"\nrun = "inert"\nexpect.tx = "committed"\n`;
const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = ccc.Address.from({ script: { codeHash: HASH, hashType: "type", args: "0x0102" }, prefix: "ckt" }).toString();

function parse(body: string, head = HEAD) {
  const manifest = parseManifestText(`${head}${STEP}${body}`);
  if (!isManifestV5(manifest)) throw new Error("expected draft.5");
  return manifest;
}
const cell = (body: string) => parse(`[[assert.cell]]\n${body}\n`).assertions[0] as CellAssertionV5;
const balance = (body: string) => parse(`[[assert.balance]]\n${body}\n`).assertions[0] as BalanceAssertionV5;
const rejects = (body: string, message: string) => expect(() => parse(body)).toThrow(message);

describe("draft.5 grammar", () => {
  test("cycles comparators are parsed, bounded, and mutually consistent", () => {
    expect(parse(`[[assert.cell]]\nout_point = { step = "mint", index = 0 }\ncount = 1\n`, HEAD).steps[0]!.expect).toEqual({ tx: "committed" });
    const withCycles = parseManifestText(`${HEAD}[[step]]\nname = "mint"\nrun = "inert"\nexpect.tx = "committed"\nexpect.cycles = { gte = 1000, lt = 5_000_000 }\n`);
    expect(withCycles.steps[0]!.expect).toEqual({ tx: "committed", cycles: { gte: 1000, lt: 5_000_000 } });
    for (const [cycles, message] of [
      ["{ eq = 1, lt = 2 }", "eq cannot be combined"], ["{ lt = 1, lte = 2 }", "mutually exclusive"], ["{ gte = 5, lt = 5 }", "must be below lt"],
      ["{ gte = 6, lte = 5 }", "must not exceed lte"], ["{ }", "at least one"], ["{ lt = -1 }", "safe integer"], ["{ max = 1 }", "not supported"],
    ]) expect(() => parseManifestText(`${HEAD}[[step]]\nname = "mint"\nrun = "inert"\nexpect.tx = "committed"\nexpect.cycles = ${cycles}\n`)).toThrow(message);
    expect(() => parseManifestText(`${HEAD.replace("draft.5", "draft.4")}[[step]]\nname = "mint"\nrun = "inert"\nexpect.tx = "committed"\nexpect.cycles = { lt = 1 }\n[[assert.cell]]\nout_point = { step = "mint", index = 0 }\ncount = 1\n`)).toThrow("expect.cycles is not supported");
  });

  test("cell selectors: out_point, script filters, and their combinations", () => {
    expect(cell(`out_point = { step = "mint", index = 0 }\ncount = 1`).selector).toEqual({ outPoint: { step: "mint", index: 0 } });
    expect(cell(`lock = { account = 1 }\ncount = { gte = 1 }`).selector).toEqual({ lock: { kind: "account", index: 1 } });
    expect(cell(`type = { builtin = "xudt" }\ncount = 0`).selector).toEqual({ type: { kind: "builtin", name: "xudt", args: null } });
    expect(cell(`type = { builtin = "xudt", args = "0x01" }\nlock = { code_hash = "${HASH}", hash_type = "data1", args = "0x" }\ncount = { lte = 3 }`).selector)
      .toEqual({ type: { kind: "builtin", name: "xudt", args: "0x01" }, lock: { kind: "explicit", codeHash: HASH, hashType: "data1", args: "0x" } });
    rejects(`[[assert.cell]]\ncount = 1\n`, "requires a selector");
    rejects(`[[assert.cell]]\nlock = "sample_lock"\ncount = 1\n`, "named setup scripts are not supported");
    rejects(`[[assert.cell]]\nlock = { builtin = "nope" }\ncount = 1\n`, "must be one of the OffCKB system scripts");
    rejects(`[[assert.cell]]\ntype = { account = 0 }\ncount = 1\n`, "only valid for lock references");
    rejects(`[[assert.cell]]\nlock = { account = 2 }\ncount = 1\n`, "below setup.accounts (2)");
    rejects(`[[assert.cell]]\nlock = { builtin = "dao", account = 0 }\ncount = 1\n`, "exactly one of");
    rejects(`[[assert.cell]]\nlock = { code_hash = "${HASH}", hash_type = "type" }\ncount = 1\n`, "requires code_hash, hash_type, and args");
    rejects(`[[assert.cell]]\nlock = { code_hash = "${HASH}", hash_type = "sha", args = "0x" }\ncount = 1\n`, "hash_type must be");
    rejects(`[[assert.cell]]\nout_point = { step = "later", index = 0 }\ncount = 1\n`, "earlier step");
    rejects(`[[assert.cell]]\nout_point = { step = "mint", index = 0 }\ncount = 2\n`, "selects at most one Cell");
  });

  test("count shorthand and comparators; property checks force at least one Cell", () => {
    expect(cell(`lock = { account = 0 }\ncount = 3`).count).toEqual({ eq: 3 });
    expect(cell(`lock = { account = 0 }\ncount = { gte = 1, lte = 4 }`).count).toEqual({ gte: 1, lte: 4 });
    expect(cell(`lock = { account = 0 }\ncapacity = { gte = "1 CKB" }`).count).toEqual({ gte: 1 });
    expect(cell(`lock = { account = 0 }\ncount = { lte = 4 }\ndata = { len = 16 }`).count).toEqual({ lte: 4, gte: 1 });
    expect(cell(`lock = { account = 0 }\ncount = 0`).count).toEqual({ eq: 0 });
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncount = 0\ndata = { len = 16 }\n`, "incompatible with per-Cell property checks");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncount = { lte = 0 }\ncapacity = { eq = "1 CKB" }\n`, "incompatible with per-Cell property checks");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncount = { eq = 1, gte = 1 }\n`, "cannot be combined");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncount = { gte = 2, lte = 1 }\n`, "must not exceed lte");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncount = -1\n`, "safe integer");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\n`, "at least one of count, data, capacity");
  });

  test("data and capacity checks", () => {
    expect(cell(`lock = { account = 0 }\ndata = { eq = "0x0102", len = 2, min_bytes = 1 }`).data).toEqual({ eq: "0x0102", len: 2, minBytes: 1 });
    expect(cell(`lock = { account = 0 }\ncapacity = { gte = "1000 CKB", lte = "1000.5 CKB" }`).capacity).toEqual({ gte: "100000000000", lte: "100050000000" });
    expect(cell(`lock = { account = 0 }\ncapacity = { eq = "61 shannon" }`).capacity).toEqual({ eq: "61" });
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ndata = { eq = "0x0102", len = 3 }\n`, "contradicts the length");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ndata = { eq = "0x01", min_bytes = 2 }\n`, "exceeds the length of data.eq");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ndata = { len = 1, min_bytes = 2 }\n`, "exceeds data.len");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ndata = { eq = "0xABC" }\n`, "lowercase 0x-prefixed even-length hex");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ndata = { }\n`, "at least one of eq, len, min_bytes");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncapacity = { gte = 1000 }\n`, "bare numbers are rejected");
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncapacity = { gte = "1000" }\n`, 'such as "1000 CKB"');
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncapacity = { gte = "1.123456789 CKB" }\n`, 'such as "1000 CKB"');
    rejects(`[[assert.cell]]\nlock = { account = 0 }\ncapacity = { gte = "18446744073709551616 shannon" }\n`, "64-bit capacity range");
  });

  test("balance targets, udt, and amounts", () => {
    expect(balance(`account = 1\ngte = "999 CKB"`)).toEqual({ kind: "balance", target: { kind: "account", index: 1 }, amount: { gte: "99900000000" } });
    expect(balance(`address = "${ADDRESS}"\neq = "0 CKB"`).target).toEqual({ kind: "address", address: ADDRESS, lock: { codeHash: HASH, hashType: "type", args: "0x0102" } });
    expect(balance(`lock = { builtin = "always_success", args = "0x" }\nlte = "5 shannon"`).target).toEqual({ kind: "lock", script: { kind: "builtin", name: "always_success", args: "0x" } });
    expect(balance(`account = 0\nudt = { type = { builtin = "xudt", args = "0x${"11".repeat(32)}" } }\ngte = "1000"`)).toEqual({
      kind: "balance", target: { kind: "account", index: 0 }, udt: { type: { kind: "builtin", name: "xudt", args: `0x${"11".repeat(32)}` } }, amount: { gte: "1000" } });
    rejects(`[[assert.balance]]\naccount = 0\naddress = "${ADDRESS}"\ngte = "1 CKB"\n`, "exactly one target");
    rejects(`[[assert.balance]]\ngte = "1 CKB"\n`, "exactly one target");
    rejects(`[[assert.balance]]\naccount = 2\ngte = "1 CKB"\n`, "below setup.accounts (2)");
    rejects(`[[assert.balance]]\naddress = "ckt1nope"\ngte = "1 CKB"\n`, "not a full-format bech32m CKB address");
    rejects(`[[assert.balance]]\nlock = { builtin = "always_success" }\ngte = "1 CKB"\n`, "wildcard args are not allowed");
    rejects(`[[assert.balance]]\naccount = 0\nudt = { type = { builtin = "xudt" } }\ngte = "1"\n`, "wildcard args are not allowed");
    rejects(`[[assert.balance]]\naccount = 0\nudt = { type = { account = 0 } }\ngte = "1"\n`, "only valid for lock references");
    rejects(`[[assert.balance]]\naccount = 0\nudt = { type = { builtin = "xudt", args = "0x" } }\ngte = "1 CKB"\n`, 'base-unit integer string such as "1000"');
    rejects(`[[assert.balance]]\naccount = 0\ngte = "1000"\n`, 'such as "1000 CKB"');
    rejects(`[[assert.balance]]\naccount = 0\ngte = 1000\n`, "bare numbers are rejected");
    rejects(`[[assert.balance]]\naccount = 0\n`, "at least one of eq, gte, lte");
    rejects(`[[assert.balance]]\naccount = 0\neq = "1 CKB"\ngte = "1 CKB"\n`, "cannot be combined");
    rejects(`[[assert.balance]]\naccount = 0\nudt = { type = { builtin = "xudt", args = "0x" } }\ngte = "340282366920938463463374607431768211456"\n`, "128-bit UDT amount range");
  });

  test("cell_deps accepts every OffCKB system script and keeps declaration order across kinds", () => {
    const manifest = parse(`[[assert.balance]]\naccount = 0\ngte = "1 CKB"\n[[assert.cell]]\nlock = { account = 0 }\ncount = 1\n[[assert.cell_deps]]\nstep = "mint"\ncontains = { builtin = "secp256k1_blake160_sighash_all" }\n`);
    expect(manifest.assertions.map((claim) => claim.kind)).toEqual(["cell", "cell_deps", "balance"]);
    rejects(`[[assert.cell_deps]]\nstep = "mint"\ncontains = { builtin = "nope" }\n`, "must be one of the OffCKB system scripts");
    rejects(`[[assert.cell_deps]]\nstep = "mint"\ncontains = "dao"\n`, "must be a table");
  });

  test("draft.3 and draft.4 reject the draft.5 vocabulary", () => {
    for (const spec of ["draft.3", "draft.4"]) {
      const head = HEAD.replace("draft.5", spec);
      expect(() => parseManifestText(`${head}${STEP}[[assert.cell]]\nlock = { account = 0 }\ncount = 1\n`)).toThrow("not supported");
      expect(() => parseManifestText(`${head}${STEP}[[assert.balance]]\naccount = 0\ngte = "1 CKB"\n`)).toThrow("not supported");
    }
  });

  test("quantity normalization", () => {
    expect(parseQuantity("1 CKB", "q", "t", "ckb")).toBe("100000000");
    expect(parseQuantity("0.00000001 CKB", "q", "t", "ckb")).toBe("1");
    expect(parseQuantity("007 shannon", "q", "t", "ckb")).toBe("7");
    expect(parseQuantity("0", "q", "t", "udt")).toBe("0");
    expect(() => parseQuantity("1e3", "q", "t", "udt")).toThrow("base-unit integer");
  });
});

describe("full-format address decoding", () => {
  test("round-trips CCC full addresses for every hash type and refuses other forms", () => {
    for (const hashType of ["data", "type", "data1", "data2"] as const) {
      const script = { codeHash: HASH, hashType, args: "0x" };
      for (const prefix of ["ckb", "ckt"] as const) {
        const encoded = ccc.Address.from({ script, prefix }).toString();
        expect(decodeFullAddress(encoded)).toEqual({ prefix, codeHash: HASH, hashType, args: "0x" });
      }
    }
    expect(() => decodeFullAddress(ADDRESS.toUpperCase())).toThrow("lowercase");
    expect(() => decodeFullAddress(`${ADDRESS.slice(0, -1)}${ADDRESS.endsWith("q") ? "p" : "q"}`)).toThrow("checksum");
    expect(() => decodeFullAddress("btc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toThrow("prefix");
    expect(() => decodeFullAddress("ckt1qyqrdsefa43s6m882pcj53m4gdnj4k5lzzmsuv8ry5")).toThrow(/short|checksum|payload type/);
  });
});
