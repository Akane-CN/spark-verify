import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "src", "cli.ts");

function runCli(...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", cli, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("ckb-verify CLI", () => {
  test("prints the runner version", () => {
    const result = runCli("--version");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("0.0.1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("documents the run command", () => {
    const result = runCli("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ckb-verify run [manifest]");
    expect(result.stderr.toString()).toBe("");
  });
});
