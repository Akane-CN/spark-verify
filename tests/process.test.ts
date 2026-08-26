import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, runProcess } from "../src/process";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runCommand", () => {
  test("captures stdout, stderr, and the exit code", async () => {
    const result = await runCommand("printf out; printf err >&2; exit 7", {
      cwd: import.meta.dir,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ stdout: "out", stderr: "err", exitCode: 7, timedOut: false });
  });

  test("runs argv without shell interpolation", async () => {
    const literal = "$HOME; printf injected";
    const result = await runProcess([process.execPath, "-e", "process.stdout.write(process.argv[1])", literal], {
      cwd: import.meta.dir,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ stdout: literal, stderr: "", exitCode: 0, timedOut: false });
  });

  test("terminates the timed-out process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-process-"));
    directories.push(directory);
    const marker = join(directory, "leaked");

    const result = await runCommand(`sleep 0.2; printf leaked > ${JSON.stringify(marker)}`, {
      cwd: directory,
      timeoutMs: 30,
    });
    await Bun.sleep(300);

    expect(result.timedOut).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
