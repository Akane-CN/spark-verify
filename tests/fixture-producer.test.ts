import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const producer = join(root, "fixtures", "secp-transfer", "produce.ts");

describe("secp transfer producer boundary", () => {
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
