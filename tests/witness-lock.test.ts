import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCkb } from "@ckb-ccc/core";
import {
  buildWitnessLock, checkWitnessLock, CODE_OFFSET, EXIT_CODE, LOAD_ADDRESS, WITNESS_LOCK_PATH,
} from "../showcases/repository-script/lock/build";

const DEBUGGER = join(import.meta.dir, "..", ".ckb-verify", "offckb", "cache", "verified-debugger", "1.1.1-linux-x64", "ckb-debugger");
const hasDebugger = existsSync(DEBUGGER);
if (!hasDebugger) console.warn(`witness-lock: skipping ckb-debugger tests; pinned debugger not found at ${DEBUGGER}`);

describe("witness_lock build", () => {
  test("committed binary matches a fresh deterministic build (--check)", () => {
    const first = buildWitnessLock().binary;
    expect(buildWitnessLock().binary).toEqual(first);
    const result = checkWitnessLock();
    expect(result.actual).toBe(result.expected);
    expect(result.ok).toBe(true);
  });

  test("ELF header and single PT_LOAD segment are sane", () => {
    const bin = readFileSync(WITNESS_LOCK_PATH);
    const v = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    expect(bin.length).toBeLessThan(1024);
    expect([...bin.subarray(0, 7)]).toEqual([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    expect(v.getUint16(16, true)).toBe(2); // ET_EXEC
    expect(v.getUint16(18, true)).toBe(243); // EM_RISCV
    expect(v.getBigUint64(24, true)).toBe(BigInt(LOAD_ADDRESS + CODE_OFFSET)); // e_entry
    expect(v.getBigUint64(32, true)).toBe(64n); // e_phoff
    expect(v.getUint16(54, true)).toBe(56); // e_phentsize
    expect(v.getUint16(56, true)).toBe(1); // e_phnum
    expect(v.getUint16(60, true)).toBe(0); // e_shnum
    expect(v.getUint32(64, true)).toBe(1); // PT_LOAD
    expect(v.getUint32(68, true)).toBe(5); // PF_R | PF_X
    expect(v.getBigUint64(72, true)).toBe(0n); // p_offset
    expect(v.getBigUint64(80, true)).toBe(BigInt(LOAD_ADDRESS)); // p_vaddr
    expect(v.getBigUint64(96, true)).toBe(BigInt(bin.length)); // p_filesz
    expect(v.getBigUint64(104, true)).toBe(BigInt(bin.length)); // p_memsz
    expect((bin.length - CODE_OFFSET) % 4).toBe(0);
  });
});

type HashType = "data1" | "data2";
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const hash32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function mockTx(binary: Uint8Array, hashType: HashType, args: string, witness: string | null) {
  const lock = { code_hash: hashCkb(binary), hash_type: hashType, args };
  const depOutPoint = { tx_hash: hash32(1), index: "0x0" };
  const inputOutPoint = { tx_hash: hash32(2), index: "0x0" };
  const input = { since: "0x0", previous_output: inputOutPoint };
  const alwaysLock = { code_hash: hash32(0), hash_type: "data", args: "0x" };
  return {
    mock_info: {
      inputs: [{ input, output: { capacity: "0x174876e800", lock, type: null }, data: "0x", header: null }],
      cell_deps: [{ cell_dep: { out_point: depOutPoint, dep_type: "code" },
        output: { capacity: "0x174876e800", lock: alwaysLock, type: null }, data: hex(binary), header: null }],
      header_deps: [],
    },
    tx: {
      version: "0x0", cell_deps: [{ out_point: depOutPoint, dep_type: "code" }], header_deps: [], inputs: [input],
      outputs: [{ capacity: "0x174876e800", lock: alwaysLock, type: null }], outputs_data: ["0x"], witnesses: witness === null ? [] : [witness],
    },
  };
}

describe.skipIf(!hasDebugger)("witness_lock under ckb-debugger 1.1.1", () => {
  const cases: Array<{ name: string; args: string; witness: string | null; exit: number }> = [
    { name: "matching first byte", args: "0x01", witness: "0x01", exit: EXIT_CODE.OK },
    { name: "matching first byte, longer args and witness", args: "0x01ff", witness: "0x0100", exit: EXIT_CODE.OK },
    { name: "mismatching first byte", args: "0x01", witness: "0x02", exit: EXIT_CODE.MISMATCH },
    { name: "empty witness", args: "0x01", witness: "0x", exit: EXIT_CODE.EMPTY_WITNESS },
    { name: "empty args", args: "0x", witness: "0x01", exit: EXIT_CODE.EMPTY_ARGS },
    { name: "no witness at index 0", args: "0x01", witness: null, exit: EXIT_CODE.LOAD_WITNESS_FAILED },
  ];

  let dir = "";
  let debuggerCopy = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "witness-lock-"));
    // Run a private copy so the verified cache is never touched.
    debuggerCopy = join(dir, "ckb-debugger");
    copyFileSync(DEBUGGER, debuggerCopy);
    chmodSync(debuggerCopy, 0o755);
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function run(hashType: HashType, args: string, witness: string | null) {
    const txFile = join(dir, `mock-${hashType}-${args}-${witness ?? "none"}.json`);
    writeFileSync(txFile, JSON.stringify(mockTx(readFileSync(WITNESS_LOCK_PATH), hashType, args, witness), null, 2));
    const proc = Bun.spawnSync([debuggerCopy, "--tx-file", txFile, "--script-group-type", "lock", "--cell-index", "0", "--cell-type", "input"],
      { stdout: "pipe", stderr: "pipe" });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    const match = /Run result: (-?\d+)/.exec(output);
    return { output, result: match ? Number(match[1]) : null };
  }

  for (const hashType of ["data1", "data2"] as const) {
    for (const c of cases) {
      test(`${hashType}: ${c.name} -> exit ${c.exit}`, () => {
        const { output, result } = run(hashType, c.args, c.witness);
        if (result !== c.exit) console.error(output);
        expect(result).toBe(c.exit);
      });
    }
  }
});
