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
  test.skipIf(process.platform !== "linux")("settles on timeout and on abort even when a descendant escapes the group with the pipes", async () => {
    // Review finding (2026-11-02): `setsid` moved a descendant out of the process group while it kept
    // stdout open, so the call waited for that descendant instead of the timeout.
    const timed = performance.now();
    const result = await runCommand("setsid sleep 30 & exit 0", { cwd: tmpdir(), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(performance.now() - timed).toBeLessThan(5_000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const aborted = performance.now();
    await runCommand("setsid sleep 30 & sleep 30", { cwd: tmpdir(), timeoutMs: 60_000, signal: controller.signal });
    expect(performance.now() - aborted).toBeLessThan(5_000);
  });

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

  test("terminates the process group when its abort signal fires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-process-abort-"));
    directories.push(directory);
    const marker = join(directory, "leaked");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const result = await runCommand(`sleep 0.2; printf leaked > ${JSON.stringify(marker)}`, {
      cwd: directory,
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await Bun.sleep(300);

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(existsSync(marker)).toBe(false);
  });

  test("times out a background descendant that outlives the shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-process-background-"));
    directories.push(directory);
    const marker = join(directory, "leaked");

    const result = await runCommand(`(sleep 2; printf leaked > ${JSON.stringify(marker)}) & echo started`, {
      cwd: directory,
      timeoutMs: 100,
    });
    await Bun.sleep(300);

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(1_500);
    expect(existsSync(marker)).toBe(false);
  });
});
