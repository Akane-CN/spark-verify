// Deterministic builder for the "witness lock" CKB script (RV64I ELF), with no external toolchain.
//
//   bun run showcases/repository-script/lock/build.ts           # write build/witness_lock
//   bun run showcases/repository-script/lock/build.ts --check   # exit 1 if the committed file differs
//
// The script loads its own Script, takes the first byte of `args`, loads witness 0 of the
// GROUP_INPUT source (raw bytes, not WitnessArgs) and exits 0 iff the first witness byte equals it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const WITNESS_LOCK_PATH = join(import.meta.dir, "..", "build", "witness_lock");
export const WITNESS_LOCK_VARIANT_PATH = join(import.meta.dir, "..", "build", "witness_lock_variant");
export const LOAD_ADDRESS = 0x10000;
export const SCRIPT_BUFFER_SIZE = 256;

// ---------------------------------------------------------------------------------------------
// RV64I encoding
// ---------------------------------------------------------------------------------------------
const REG = { zero: 0, ra: 1, sp: 2, t0: 5, t1: 6, t2: 7, s0: 8, a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a7: 17 } as const;
type Reg = keyof typeof REG;

function checkImm(value: number, bits: number, what: string): void {
  const min = -(2 ** (bits - 1)), max = 2 ** (bits - 1) - 1;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${what} immediate out of range: ${value}`);
}
const r = (name: Reg) => REG[name];
const iType = (imm: number, rs1: Reg, f3: number, rd: Reg, op: number) => {
  checkImm(imm, 12, "I-type");
  return (((imm & 0xfff) << 20) | (r(rs1) << 15) | (f3 << 12) | (r(rd) << 7) | op) >>> 0;
};
const sType = (imm: number, rs2: Reg, rs1: Reg, f3: number, op: number) => {
  checkImm(imm, 12, "S-type");
  return ((((imm >> 5) & 0x7f) << 25) | (r(rs2) << 20) | (r(rs1) << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | op) >>> 0;
};
const bType = (imm: number, rs2: Reg, rs1: Reg, f3: number) => {
  checkImm(imm, 13, "B-type");
  if (imm % 2 !== 0) throw new Error(`misaligned branch offset ${imm}`);
  return ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (r(rs2) << 20) | (r(rs1) << 15) | (f3 << 12)
    | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | 0x63) >>> 0;
};
const jType = (imm: number, rd: Reg) => {
  checkImm(imm, 21, "J-type");
  if (imm % 2 !== 0) throw new Error(`misaligned jump offset ${imm}`);
  return ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20)
    | (((imm >> 12) & 0xff) << 12) | (r(rd) << 7) | 0x6f) >>> 0;
};
const uType = (imm20: number, rd: Reg, op: number) => {
  if (!Number.isInteger(imm20) || imm20 < 0 || imm20 > 0xfffff) throw new Error(`U-type immediate out of range: ${imm20}`);
  return ((imm20 << 12) | (r(rd) << 7) | op) >>> 0;
};

// A tiny two-pass assembler: every instruction is 4 bytes, labels resolve to byte offsets.
type Item = { label: string } | { text: string; encode: (pc: number, labels: Map<string, number>) => number };
class Asm {
  readonly items: Item[] = [];
  private emit(text: string, encode: (pc: number, labels: Map<string, number>) => number) { this.items.push({ text, encode }); }
  label(name: string) { this.items.push({ label: name }); }
  addi(rd: Reg, rs1: Reg, imm: number) { this.emit(`addi ${rd}, ${rs1}, ${imm}`, () => iType(imm, rs1, 0, rd, 0x13)); }
  slli(rd: Reg, rs1: Reg, sh: number) {
    if (sh < 0 || sh > 63) throw new Error(`shift out of range: ${sh}`);
    this.emit(`slli ${rd}, ${rs1}, ${sh}`, () => iType(sh, rs1, 1, rd, 0x13));
  }
  add(rd: Reg, rs1: Reg, rs2: Reg) { this.emit(`add ${rd}, ${rs1}, ${rs2}`, () => ((r(rs2) << 20) | (r(rs1) << 15) | (r(rd) << 7) | 0x33) >>> 0); }
  lui(rd: Reg, imm20: number) { this.emit(`lui ${rd}, ${imm20}`, () => uType(imm20, rd, 0x37)); }
  lbu(rd: Reg, off: number, rs1: Reg) { this.emit(`lbu ${rd}, ${off}(${rs1})`, () => iType(off, rs1, 4, rd, 0x03)); }
  lwu(rd: Reg, off: number, rs1: Reg) { this.emit(`lwu ${rd}, ${off}(${rs1})`, () => iType(off, rs1, 6, rd, 0x03)); }
  ld(rd: Reg, off: number, rs1: Reg) { this.emit(`ld ${rd}, ${off}(${rs1})`, () => iType(off, rs1, 3, rd, 0x03)); }
  sd(rs2: Reg, off: number, rs1: Reg) { this.emit(`sd ${rs2}, ${off}(${rs1})`, () => sType(off, rs2, rs1, 3, 0x23)); }
  private branch(name: string, f3: number, rs1: Reg, rs2: Reg, target: string) {
    this.emit(`${name} ${rs1}, ${rs2}, ${target}`, (pc, labels) => bType(resolve(labels, target) - pc, rs2, rs1, f3));
  }
  beq(rs1: Reg, rs2: Reg, t: string) { this.branch("beq", 0, rs1, rs2, t); }
  bne(rs1: Reg, rs2: Reg, t: string) { this.branch("bne", 1, rs1, rs2, t); }
  bgeu(rs1: Reg, rs2: Reg, t: string) { this.branch("bgeu", 7, rs1, rs2, t); }
  j(target: string) { this.emit(`jal zero, ${target}`, (pc, labels) => jType(resolve(labels, target) - pc, "zero")); }
  ecall() { this.emit("ecall", () => 0x00000073); }
  /** Materialise a 12-bit-plus constant with lui+addi (sign-adjusted). */
  li(rd: Reg, value: number) {
    if (value >= -2048 && value <= 2047) return this.addi(rd, "zero", value);
    const lo = ((value & 0xfff) << 20) >> 20; // sign-extended low 12 bits
    const hi = ((value - lo) >>> 12) & 0xfffff;
    this.lui(rd, hi);
    if (lo !== 0) this.addi(rd, rd, lo);
  }

  assemble(): { code: Uint8Array; listing: string[] } {
    const labels = new Map<string, number>();
    let pc = 0;
    for (const item of this.items) {
      if ("label" in item) {
        if (labels.has(item.label)) throw new Error(`duplicate label ${item.label}`);
        labels.set(item.label, pc);
      } else pc += 4;
    }
    const code = new Uint8Array(pc);
    const view = new DataView(code.buffer);
    const listing: string[] = [];
    pc = 0;
    for (const item of this.items) {
      if ("label" in item) { listing.push(`${item.label}:`); continue; }
      const word = item.encode(pc, labels);
      view.setUint32(pc, word, true);
      listing.push(`  ${pc.toString(16).padStart(4, "0")}: ${word.toString(16).padStart(8, "0")}  ${item.text}`);
      pc += 4;
    }
    return { code, listing };
  }
}
function resolve(labels: Map<string, number>, name: string): number {
  const at = labels.get(name);
  if (at === undefined) throw new Error(`undefined label ${name}`);
  return at;
}

// ---------------------------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------------------------
export const SYSCALL = { EXIT: 93, LOAD_SCRIPT: 2052, LOAD_WITNESS: 2074 } as const;
export const EXIT_CODE = { OK: 0, LOAD_SCRIPT_FAILED: 1, EMPTY_ARGS: 2, LOAD_WITNESS_FAILED: 3, EMPTY_WITNESS: 4, MISMATCH: 42 } as const;

// Stack frame (sp is set up by CKB-VM near the top of memory; we only use memory below it):
//   sp+0   u64  length in/out for LOAD_* syscalls
//   sp+8   u8   witness buffer (only the first byte is needed)
//   sp+16  [u8; 256] script buffer
const FRAME = 16 + SCRIPT_BUFFER_SIZE;

function program(mismatchCode: number): Asm {
  const a = new Asm();
  a.label("_start");
  a.addi("sp", "sp", -FRAME);
  // LOAD_SCRIPT(addr = sp+16, len = &[sp] (=256), offset = 0)
  a.addi("t0", "zero", SCRIPT_BUFFER_SIZE);
  a.sd("t0", 0, "sp");
  a.addi("a0", "sp", 16);
  a.addi("a1", "sp", 0);
  a.addi("a2", "zero", 0);
  a.li("a7", SYSCALL.LOAD_SCRIPT);
  a.ecall();
  a.bne("a0", "zero", "fail_load_script");
  // molecule Script table: header = [total_size, off(code_hash), off(hash_type), off(args)];
  // args (Bytes) = u32 LE length + data. Require off(args)+4 < 256 so the length and first byte are buffered.
  a.lwu("t1", 16 + 12, "sp");
  a.addi("t2", "zero", SCRIPT_BUFFER_SIZE - 4);
  a.bgeu("t1", "t2", "fail_load_script");
  a.add("t1", "t1", "sp");
  a.lwu("t2", 16, "t1"); // args length
  a.beq("t2", "zero", "fail_empty_args");
  a.lbu("s0", 16 + 4, "t1"); // first args byte
  // LOAD_WITNESS(addr = sp+8, len = &[sp] (=1), offset = 0, index = 0, source = GROUP_INPUT)
  a.addi("t0", "zero", 1);
  a.sd("t0", 0, "sp");
  a.addi("a0", "sp", 8);
  a.addi("a1", "sp", 0);
  a.addi("a2", "zero", 0);
  a.addi("a3", "zero", 0);
  a.addi("a4", "zero", 1);
  a.slli("a4", "a4", 56);
  a.addi("a4", "a4", 1); // 0x0100000000000001
  a.li("a7", SYSCALL.LOAD_WITNESS);
  a.ecall();
  a.bne("a0", "zero", "fail_load_witness");
  a.ld("t0", 0, "sp"); // full witness length
  a.beq("t0", "zero", "fail_empty_witness");
  a.lbu("t1", 8, "sp");
  a.bne("t1", "s0", "fail_mismatch");
  a.addi("a0", "zero", EXIT_CODE.OK);
  a.label("exit");
  a.addi("a7", "zero", SYSCALL.EXIT);
  a.ecall();
  for (const [label, code] of [
    ["fail_load_script", EXIT_CODE.LOAD_SCRIPT_FAILED], ["fail_empty_args", EXIT_CODE.EMPTY_ARGS],
    ["fail_load_witness", EXIT_CODE.LOAD_WITNESS_FAILED], ["fail_empty_witness", EXIT_CODE.EMPTY_WITNESS],
    ["fail_mismatch", mismatchCode],
  ] as const) {
    a.label(label);
    a.addi("a0", "zero", code);
    a.j("exit");
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// ELF64 wrapper: header + one PT_LOAD (R|X) covering the whole file, no section headers.
// ---------------------------------------------------------------------------------------------
export const ELF_HEADER_SIZE = 64;
export const PROGRAM_HEADER_SIZE = 56;
export const CODE_OFFSET = ELF_HEADER_SIZE + PROGRAM_HEADER_SIZE;

function elf(code: Uint8Array): Uint8Array {
  const size = CODE_OFFSET + code.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2 /* ELFCLASS64 */, 1 /* LE */, 1 /* EV_CURRENT */, 0 /* SYSV */], 0);
  v.setUint16(16, 2, true); // e_type = ET_EXEC
  v.setUint16(18, 243, true); // e_machine = EM_RISCV
  v.setUint32(20, 1, true); // e_version
  v.setBigUint64(24, BigInt(LOAD_ADDRESS + CODE_OFFSET), true); // e_entry
  v.setBigUint64(32, BigInt(ELF_HEADER_SIZE), true); // e_phoff
  v.setBigUint64(40, 0n, true); // e_shoff
  v.setUint32(48, 0, true); // e_flags (no RVC, soft-float ABI)
  v.setUint16(52, ELF_HEADER_SIZE, true); // e_ehsize
  v.setUint16(54, PROGRAM_HEADER_SIZE, true); // e_phentsize
  v.setUint16(56, 1, true); // e_phnum
  v.setUint16(58, 64, true); // e_shentsize
  v.setUint16(60, 0, true); // e_shnum
  v.setUint16(62, 0, true); // e_shstrndx
  const ph = ELF_HEADER_SIZE;
  v.setUint32(ph + 0, 1, true); // p_type = PT_LOAD
  v.setUint32(ph + 4, 0b101, true); // p_flags = PF_R | PF_X
  v.setBigUint64(ph + 8, 0n, true); // p_offset
  v.setBigUint64(ph + 16, BigInt(LOAD_ADDRESS), true); // p_vaddr
  v.setBigUint64(ph + 24, BigInt(LOAD_ADDRESS), true); // p_paddr
  v.setBigUint64(ph + 32, BigInt(size), true); // p_filesz
  v.setBigUint64(ph + 40, BigInt(size), true); // p_memsz
  v.setBigUint64(ph + 48, 0x1000n, true); // p_align
  out.set(code, CODE_OFFSET);
  return out;
}

/** The variant differs only in its mismatch exit code (43): a different binary for the same manifest. */
export const VARIANT_MISMATCH_CODE = 43;
export function buildWitnessLock(mismatchCode: number = EXIT_CODE.MISMATCH): { binary: Uint8Array; listing: string[] } {
  const { code, listing } = program(mismatchCode).assemble();
  return { binary: elf(code), listing };
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Compare the committed binary with a fresh in-memory build. */
export function checkWitnessLock(path = WITNESS_LOCK_PATH, mismatchCode: number = EXIT_CODE.MISMATCH): { ok: boolean; expected: string; actual: string | null } {
  const expected = sha256Hex(buildWitnessLock(mismatchCode).binary);
  let actual: string | null = null;
  try { actual = sha256Hex(readFileSync(path)); } catch { actual = null; }
  return { ok: actual === expected, expected, actual };
}

if (import.meta.main) {
  const targets = [[WITNESS_LOCK_PATH, EXIT_CODE.MISMATCH], [WITNESS_LOCK_VARIANT_PATH, VARIANT_MISMATCH_CODE]] as const;
  if (process.argv.includes("--check")) {
    let ok = true;
    for (const [path, code] of targets) {
      const result = checkWitnessLock(path, code);
      console.log(`built     sha256:${result.expected}`);
      console.log(`committed sha256:${result.actual ?? "(missing)"}`);
      if (!result.ok) { console.error(`${path} is out of date; rebuild it`); ok = false; }
    }
    if (!ok) process.exit(1);
    console.log("witness_lock and witness_lock_variant are up to date");
  } else {
    for (const [path, code] of targets) {
      const { binary, listing } = buildWitnessLock(code);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, binary);
      if (process.argv.includes("--listing") && code === EXIT_CODE.MISMATCH) console.log(listing.join("\n"));
      console.log(`wrote ${path} (${binary.length} bytes) sha256:${sha256Hex(binary)}`);
    }
  }
}
