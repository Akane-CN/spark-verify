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
    expect(result.stdout.toString()).toBe("0.0.2\n");
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

  test("prints a field-level expected/observed diff for every failed claim on FAIL", async () => {
    const stdout: string[] = [];
    const exitCode = await main(["run", "verify.toml"], {
      runManifest: async () =>
        ({
          verdict: "FAIL",
          reportPath: "/tmp/report.json",
          report: {
            digests: { outcome: "sha256:outcome", environment: "sha256:environment" },
            outcomeClaims: {
              steps: [{
                name: "transfer", expectedStatus: "committed", observedStatus: "rejected", expectedErrorCode: -11, rejection: { code: 5 },
                claims: [
                  { kind: "cell", target: { step: "transfer", index: 0 }, expected: { count: 1 }, observed: { count: 0 }, ok: false },
                  { kind: "cell", target: { step: "transfer", index: 1 }, expected: { count: 1 }, observed: { count: 1 }, ok: true },
                ],
              }],
              assertions: [{ kind: "cell_deps", target: { step: "transfer" }, expected: { contains: { kind: "builtin", name: "dao" } }, observed: { present: [false] }, ok: false }],
            },
          },
        }) as unknown as RunManifestResult,
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(1);
    const text = stdout.join("");
    expect(text).toStartWith("FAIL: One or more declared claims failed.\n");
    expect(text).toContain('failed: step "transfer" expect.tx\n  expected: "committed"\n  observed: "rejected"\n');
    expect(text).toContain('failed: step "transfer" expect.error.code\n  expected: -11\n  observed: 5\n');
    expect(text).toContain('failed: step "transfer" assert.cell[0] target {"step":"transfer","index":0}\n  expected: {"count":1}\n  observed: {"count":0}\n');
    expect(text).not.toContain('target {"step":"transfer","index":1}');
    expect(text).toContain('failed: assert.cell_deps[0] target {"step":"transfer"}\n  expected: {"contains":{"kind":"builtin","name":"dao"}}\n  observed: {"present":[false]}\n');
    expect(text).toEndWith("report: /tmp/report.json\noutcome: sha256:outcome\nenvironment: sha256:environment\n");
  });
});
