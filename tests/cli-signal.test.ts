import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI process signals", () => {
  test("waits for runner cleanup before exiting with SIGTERM status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ckb-verify-cli-signal-"));
    directories.push(directory);
    const ready = join(directory, "ready");
    const cleaned = join(directory, "cleaned");
    const script = `
      import { writeFile } from "node:fs/promises";
      import { main, subscribeProcessSignals } from "./src/cli.ts";
      const ready = process.argv[1];
      const cleaned = process.argv[2];
      const code = await main(["run"], {
        runManifest: async ({ signal }) => {
          const interrupted = signal.aborted
            ? Promise.resolve()
            : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await writeFile(ready, "ready");
          await interrupted;
          await writeFile(cleaned, "cleaned");
          throw new Error("run interrupted");
        },
        subscribeSignals: subscribeProcessSignals,
        stdout: () => undefined,
        stderr: () => undefined,
      });
      process.exitCode = code;
    `;
    const child = Bun.spawn([process.execPath, "-e", script, ready, cleaned], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = Date.now() + 2_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);

    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(existsSync(cleaned)).toBe(true);
  });
});
