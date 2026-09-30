import { describe, expect, test } from "bun:test";
import { main, type CliDependencies } from "../src/cli";
import type { RunManifestResult } from "../src/runner";

const SHA256 = `sha256:${"1".repeat(64)}` as `sha256:${string}`;

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
      environment: {
        schema: "ckb-verify-environment/2",
        runner: { name: "ckb-verify", version: "0.0.1" },
        toolchain: {
          requested: { ckb: "0.209.0", offckb: "0.4.13" },
          observed: { ckb: "0.209.0", offckb: "0.4.13" },
        },
        provenance: {
          schema: "ckb-verify-provenance/1",
          replay: { declaredDependencies: [], status: "stable", reasons: [] },
          source: { gitCommit: "a".repeat(40), dirty: false, dirtyDigest: null },
          manifest: { sha256: SHA256 },
          lockfile: { path: "bun.lock", sha256: SHA256 },
          runtime: {
            name: "bun",
            requestedVersion: "1.2.19",
            observedVersion: "1.2.19",
            metadata: { path: "package.json", sha256: SHA256 },
          },
          binaries: {
            ckb: {
              version: "0.209.0",
              platform: "linux",
              architecture: "x64",
              asset: "fixture.tar.gz",
              sourceUrl: "https://example.invalid/fixture.tar.gz",
              expectedArchiveSha256: SHA256,
              archiveSha256: SHA256,
              binarySha256: SHA256,
            },
          },
        },
        platform: { os: "linux", arch: "x64" },
        devnet: { network: "devnet", genesisHash: "0xgenesis", systemScripts: {} },
      },
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

  test("turns SIGTERM into an abort, waits for cleanup, and returns the conventional signal exit code", async () => {
    let sawAbort = false;
    let disposed = false;
    const deps: CliDependencies = {
      runManifest: async (options) => {
        const signal = (options as { signal?: AbortSignal }).signal;
        await Promise.race([
          new Promise<never>((_resolve, reject) => {
            const abort = () => {
              sawAbort = true;
              reject(new Error("run interrupted"));
            };
            if (signal?.aborted === true) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
          Bun.sleep(50).then(() => {
            throw new Error("signal was not forwarded");
          }),
        ]);
        throw new Error("unreachable");
      },
      subscribeSignals: (handler) => {
        queueMicrotask(() => handler("SIGTERM"));
        return () => {
          disposed = true;
        };
      },
      stdout: () => undefined,
      stderr: () => undefined,
    };

    expect(await main(["run", "verify.toml"], deps)).toBe(143);
    expect(sawAbort).toBe(true);
    expect(disposed).toBe(true);
  });
});
