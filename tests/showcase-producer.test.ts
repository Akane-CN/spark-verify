import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const producer = join(root, "showcases", "secp-transfer", "produce.ts");

describe("secp transfer showcase producer boundary", () => {
  test("fails before touching the chain when runner context is missing", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", producer, "committed"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("CKB_VERIFY_RESULT");
  });

  test("contains no transaction submission call", async () => {
    const source = await Bun.file(producer).text();

    expect(source).toContain("signTransaction");
    expect(source).not.toContain("sendTransaction");
    expect(source).not.toContain("send_transaction");
  });
});

const nervdaoProducer = join(root, "showcases", "nervdao", "produce.ts");

describe("NervDAO showcase producer boundary", () => {
  test("fails before touching the chain when runner context is missing", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", nervdaoProducer, "committed"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("CKB_VERIFY_RESULT");
  });

  test("preserves the bounded DAO deposit construction without submission", async () => {
    const source = await Bun.file(nervdaoProducer).text();

    expect(source).toContain("09fc1aea6f3d0527cc2af08f766d900780a32ae9");
    expect(source).toContain("CKB_VERIFY_SYSTEM_SCRIPTS");
    expect(source).toContain('script("secp256k1_blake160_sighash_all")');
    expect(source).toContain('script("dao")');
    expect(source).toContain("KnownScript.NervosDao");
    expect(source).toContain("fixedPointFrom(200)");
    expect(source).toContain('["00".repeat(8)]');
    expect(source).toContain("addCellDepsOfKnownScripts");
    expect(source).toContain("completeFeeBy(signer, 1_000n)");
    expect(source).toContain("signTransaction");
    expect(source).toContain('mode === "tampered-signature"');
    expect(source).toContain("signature[0] = (signature[0] ?? 0) ^ 0x01");
    expect(source).not.toContain("sendTransaction");
    expect(source).not.toContain("send_transaction");
  });
});
