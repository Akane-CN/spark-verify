import { describe, expect, test } from "bun:test";
import { main, type CliDependencies } from "../src/cli";
import type { RunManifestResult } from "../src/runner";

function result(verdict: "PASS" | "FAIL"): RunManifestResult {
  return {
    verdict,
    reportPath: "/tmp/evidence/report.json",
    report: {
      schema: "ckb-verify-report/1",
      verdict,
      createdAt: "2026-08-26T00:00:00.000Z",
      evidence: { name: "fixture", spec: "0.1.0-draft.3", steps: [], assertions: [] },
      outcomeClaims: { schema: "ckb-verify-outcome/1", name: "fixture", spec: "0.1.0-draft.3", steps: [], assertions: [] },
      environment: { schema: "ckb-verify-environment/1" },
      digests: { outcome: `sha256:${"1".repeat(64)}`, environment: `sha256:${"2".repeat(64)}` },
    },
  };
}

function dependencies(runResult: RunManifestResult): { deps: CliDependencies; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      runManifest: async () => runResult,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe("CLI run command", () => {
  test("returns zero and prints both digests for PASS", async () => {
    const state = dependencies(result("PASS"));

    expect(await main(["run", "verify.toml"], state.deps)).toBe(0);
    expect(state.stdout.join("")).toContain("PASS");
    expect(state.stdout.join("")).toContain("outcome: sha256:");
    expect(state.stdout.join("")).toContain("environment: sha256:");
    expect(state.stderr).toEqual([]);
  });

  test("returns one for a completed run whose declared claims fail", async () => {
    const state = dependencies(result("FAIL"));

    expect(await main(["run", "verify.toml"], state.deps)).toBe(1);
    expect(state.stdout.join("")).toContain("FAIL");
    expect(state.stdout.join("")).toContain("report: /tmp/evidence/report.json");
    expect(state.stderr).toEqual([]);
  });

  test("returns two and does not claim a verdict for execution errors", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: CliDependencies = {
      runManifest: async () => {
        throw new Error("node failed");
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };

    expect(await main(["run"], deps)).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("ERROR: node failed");
  });
});
