import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli";
import type { RunManifestResult } from "../src/runner";

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

  test("defines PASS as all recorded-environment claims passing", async () => {
    const stdout: string[] = [];
    const exitCode = await main(["run", "verify.toml"], {
      runManifest: async () =>
        ({
          verdict: "PASS",
          reportPath: "/tmp/report.json",
          report: {
            digests: {
              outcome: "sha256:outcome",
              environment: "sha256:environment",
            },
          },
        }) as RunManifestResult,
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toStartWith("PASS: All declared claims passed in the recorded environment.\n");
  });
});
