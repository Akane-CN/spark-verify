// provenance/4: repository identity sanitization, runtime pins, every lockfile, and replay reasons re-derived offline.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProvenanceV4Consistency, collectProvenanceV4, parseRuntimePins, parseToolVersion, sanitizeRepositoryUrl, type ProvenanceEvidenceV4,
} from "../src/provenance-v4";

const SHA = `sha256:${"ab".repeat(32)}` as `sha256:${string}`;
const OTHER = `sha256:${"cd".repeat(32)}`;
const ckbBinary = { version: "0.209.0", platform: "linux" as const, architecture: "x64" as const, asset: "ckb.tar.gz", sourceUrl: "https://example.invalid/ckb.tar.gz",
  expectedArchiveSha256: SHA, archiveSha256: SHA, binarySha256: SHA };

async function collect(files: Record<string, string>, overrides: Partial<Parameters<typeof collectProvenanceV4>[0]> = {}): Promise<ProvenanceEvidenceV4> {
  const root = await mkdtemp(join(tmpdir(), "prov4-"));
  try {
    for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
    return await collectProvenanceV4({
      projectRoot: root, manifestBytes: new TextEncoder().encode("m"), replayDependencies: [], repositoryUrl: "https://github.com/o/r.git",
      sourceRevision: { gitCommit: "a".repeat(40), dirty: false, dirtyDigest: null }, ckbBinary, ckbDebuggerBinary: null,
      toolchain: { ckb: { requested: "0.209.0", observed: "0.209.0", driftAllowed: false } }, sealingFingerprint: SHA, defaultSealingFingerprint: SHA,
      observeTool: async (tool) => ({ bun: "1.2.19", node: "22.22.0", pnpm: "9.1.0" } as Record<string, string>)[tool] ?? null,
      ...overrides,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("repository identity", () => {
  test("drops credentials, userinfo, query, and fragment; refuses local paths", () => {
    expect(sanitizeRepositoryUrl("https://user:token@github.com/o/r.git?x=1#f")).toBe("https://github.com/o/r.git");
    expect(sanitizeRepositoryUrl("git@github.com:o/r.git")).toBe("ssh://github.com/o/r.git");
    expect(sanitizeRepositoryUrl("ssh://git@Example.COM:2222/o/r")).toBe("ssh://example.com:2222/o/r");
    for (const local of ["/srv/repo.git", "../repo", "file:///srv/repo", "C:\\repo", ""]) expect(sanitizeRepositoryUrl(local)).toBeNull();
  });
});

describe("runtime pins", () => {
  test("reads packageManager, .tool-versions, mise.toml, .nvmrc, and .node-version", () => {
    expect(parseRuntimePins({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0+sha512.abc" }),
      ".tool-versions": "nodejs 22.22.0\n# comment\nruby 3.3.0\n",
      "mise.toml": "[tools]\nbun = \"1.2.19\"\nnode = { version = \"22\" }\n",
      ".nvmrc": "v22.22.0\n",
    })).toEqual([
      { tool: "pnpm", requested: "9.1.0", source: "package.json#packageManager" },
      { tool: "node", requested: "22.22.0", source: ".tool-versions" },
      { tool: "bun", requested: "1.2.19", source: "mise.toml" },
      { tool: "node", requested: "22", source: "mise.toml" },
      { tool: "node", requested: "22.22.0", source: ".nvmrc" },
    ]);
    expect(parseToolVersion("v22.22.0\n")).toBe("22.22.0");
    expect(parseToolVersion("garbage")).toBeNull();
  });
});

describe("replay reasons", () => {
  test("a pinned Bun project with bun.lock is stable", async () => {
    const p = await collect({ "package.json": JSON.stringify({ packageManager: "bun@1.2.19" }), "bun.lock": "{}" });
    expect(p.replay).toEqual({ declaredDependencies: [], status: "stable", reasons: [] });
    expect(p.lockfiles.map((l) => l.path)).toEqual(["bun.lock"]);
    expect(p.repository).toEqual({ remote: "origin", url: "https://github.com/o/r.git" });
  });

  test("an npm/pnpm project with its own lockfile is stable too", async () => {
    const p = await collect({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }), "pnpm-lock.yaml": "lockfileVersion: 9", "Cargo.lock": "" });
    expect(p.replay.status).toBe("stable");
    expect(p.lockfiles.map((l) => l.path)).toEqual(["pnpm-lock.yaml", "Cargo.lock"]);
  });

  test("missing, ranged, and drifting pins taint; no lockfile taints; a non-default devnet taints", async () => {
    const p = await collect({ ".nvmrc": "20\n", ".tool-versions": "bun 1.1.0\n" }, { sealingFingerprint: OTHER });
    expect(p.replay.reasons.map((r) => r.code)).toEqual(["runtime_pin_missing", "runtime_pin_missing", "runtime_version_drift", "lockfile_missing", "nondefault_devnet"]);
    expect(p.replay.status).toBe("tainted");
  });

  test("an absent pinned tool is drift, recorded as null", async () => {
    const p = await collect({ "package.json": JSON.stringify({ packageManager: "yarn@4.1.0" }), "yarn.lock": "" });
    expect(p.runtime.observed).toEqual([{ tool: "yarn", version: null }]);
    expect(p.replay.reasons.map((r) => r.code)).toEqual(["runtime_version_drift"]);
  });
});

describe("offline consistency", () => {
  test("recorded reasons, orderings, and identities are re-checked", async () => {
    const good = await collect({ "package.json": JSON.stringify({ packageManager: "bun@1.2.19" }), "bun.lock": "{}" });
    expect(() => assertProvenanceV4Consistency(good)).not.toThrow();
    const tamper = (change: (p: ProvenanceEvidenceV4) => void) => { const copy = structuredClone(good); change(copy); return () => assertProvenanceV4Consistency(copy); };
    expect(tamper((p) => { p.replay.status = "tainted"; })).toThrow("replay status");
    expect(tamper((p) => { p.runtime.observed[0]!.version = "1.2.18"; })).toThrow("replay reasons");
    expect(tamper((p) => { p.lockfiles = []; })).toThrow("replay reasons");
    expect(tamper((p) => { p.devnet.sealingFingerprint = OTHER; })).toThrow("replay reasons");
    expect(tamper((p) => { p.repository = { remote: "origin", url: "https://u:p@github.com/o/r" }; })).toThrow("sanitized");
    expect(tamper((p) => { p.lockfiles.push({ path: "bun.lock", sha256: SHA }); })).toThrow("fixed order");
    expect(tamper((p) => { p.runtime.pins.push({ tool: "node", requested: "22.22.0", source: ".nvmrc" }); })).toThrow("no recorded metadata digest");
    expect(tamper((p) => { (p as unknown as Record<string, unknown>).extra = 1; })).toThrow("exactly");
  });
});
