import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireRuntimeOwnership } from "../src/runtime-ownership";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI process signals", () => {
  test.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("waits for cleanup even after repeated %s signals", async (signal, code) => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-cli-signal-"));
    directories.push(directory);
    const ready = join(directory, "ready");
    const cleaned = join(directory, "cleaned");
    const cleaning = join(directory, "cleaning");
    const script = `
      import { writeFile } from "node:fs/promises";
      import { main, subscribeProcessSignals } from "./src/cli.ts";
      import { acquireRuntimeOwnership } from "./src/runtime-ownership.ts";
      const ready = process.argv[1];
      const cleaned = process.argv[2];
      const cleaning = process.argv[3];
      const code = await main(["run"], {
        runManifest: async ({ signal }) => {
          const lease = await acquireRuntimeOwnership();
          const interrupted = signal.aborted
            ? Promise.resolve()
            : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await writeFile(ready, "ready");
          await interrupted;
          await writeFile(cleaning, "cleaning");
          await Bun.sleep(150);
          await writeFile(cleaned, "cleaned");
          await lease.release();
          throw new Error("run interrupted");
        },
        subscribeSignals: subscribeProcessSignals,
        stdout: () => undefined,
        stderr: () => undefined,
      });
      process.exitCode = code;
    `;
    const child = Bun.spawn([process.execPath, "-e", script, ready, cleaned, cleaning], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = Date.now() + 2_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);

    child.kill(signal);
    const cleanupDeadline = Date.now() + 2_000;
    while (!existsSync(cleaning) && Date.now() < cleanupDeadline) await Bun.sleep(5);
    expect(existsSync(cleaning)).toBe(true);
    await expect(acquireRuntimeOwnership()).rejects.toThrow("runtime busy");
    child.kill(signal);
    expect(await child.exited).toBe(code);
    expect(existsSync(cleaned)).toBe(true);
    const next = await acquireRuntimeOwnership();
    await next.release();
  });
});
