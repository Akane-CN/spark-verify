import { afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Bytes } from "../src/canonical";
import { collectProvenance } from "../src/provenance";

const directories: string[] = [];
const COMMIT = "a".repeat(40);
const ARCHIVE_SHA256 = `sha256:${"1".repeat(64)}` as const;

const CKB_BINARY = {
  version: "0.209.0",
  platform: "linux" as const,
  architecture: "x64",
  asset: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
  sourceUrl:
    "https://github.com/nervosnetwork/ckb/releases/download/v0.209.0/ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
  expectedArchiveSha256: ARCHIVE_SHA256,
  archiveSha256: ARCHIVE_SHA256,
  binarySha256: `sha256:${"2".repeat(64)}` as const,
};

async function project(packageManager = "bun@1.2.19", withLockfile = true): Promise<{
  root: string;
  packageJsonBytes: Uint8Array;
  lockfileBytes?: Uint8Array;
}> {
  const root = await mkdtemp(join(tmpdir(), "ckb-verify-provenance-"));
  directories.push(root);
  const packageJsonBytes = new TextEncoder().encode(`${JSON.stringify({ packageManager })}\n`);
  await writeFile(join(root, "package.json"), packageJsonBytes);
  if (!withLockfile) return { root, packageJsonBytes };
  const lockfileBytes = new TextEncoder().encode('lockfileVersion = 1\n');
  await writeFile(join(root, "bun.lock"), lockfileBytes);
  return { root, packageJsonBytes, lockfileBytes };
}

async function schemaValidator(): Promise<ValidateFunction> {
  const schemaUrl = new URL("../schemas/ckb-verify-provenance-v1.schema.json", import.meta.url);
  const schema = JSON.parse(await Bun.file(schemaUrl).text()) as object;
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("formal provenance", () => {
  test("qualifies a clean, pinned, locked run as stable", async () => {
    const fixture = await project();
    const manifestBytes = new TextEncoder().encode("[replay]\ndependencies = []\n");

    const provenance = await collectProvenance({
      projectRoot: fixture.root,
      manifestBytes,
      replayDependencies: [],
      sourceRevision: { gitCommit: COMMIT, dirty: false, dirtyDigest: null },
      ckbBinary: CKB_BINARY,
      observedRuntimeVersion: "1.2.19",
    });

    expect(provenance).toEqual({
      schema: "ckb-verify-provenance/1",
      replay: { declaredDependencies: [], status: "stable", reasons: [] },
      source: { gitCommit: COMMIT, dirty: false, dirtyDigest: null },
      manifest: { sha256: sha256Bytes(manifestBytes) },
      lockfile: { path: "bun.lock", sha256: sha256Bytes(fixture.lockfileBytes!) },
      runtime: {
        name: "bun",
        requestedVersion: "1.2.19",
        observedVersion: "1.2.19",
        metadata: { path: "package.json", sha256: sha256Bytes(fixture.packageJsonBytes) },
      },
      binaries: { ckb: CKB_BINARY },
    });
  });

  test("records deterministic replay, source, runtime, and lockfile taint reasons", async () => {
    const fixture = await project("bun@1.2.18", false);
    const dirtyDigest = `sha256:${"3".repeat(64)}`;

    const provenance = await collectProvenance({
      projectRoot: fixture.root,
      manifestBytes: new TextEncoder().encode("fixture"),
      replayDependencies: ["external_time"],
      sourceRevision: { gitCommit: COMMIT, dirty: true, dirtyDigest },
      ckbBinary: CKB_BINARY,
      observedRuntimeVersion: "1.2.19",
    });

    expect(provenance.replay).toMatchObject({
      declaredDependencies: ["external_time"],
      status: "tainted",
    });
    expect(provenance.replay.reasons.map(({ scope, code }) => ({ scope, code }))).toEqual([
      { scope: "outcome", code: "external_time" },
      { scope: "environment", code: "dirty_source" },
      { scope: "environment", code: "runtime_version_drift" },
      { scope: "environment", code: "lockfile_missing" },
    ]);
    expect(provenance.source).toEqual({ gitCommit: COMMIT, dirty: true, dirtyDigest });
    expect(provenance.lockfile).toEqual({ path: "bun.lock", sha256: null });
    expect(provenance.runtime).toMatchObject({ requestedVersion: "1.2.18", observedVersion: "1.2.19" });
  });

  test("rejects contradictory verified binary digests", async () => {
    const fixture = await project();

    await expect(
      collectProvenance({
        projectRoot: fixture.root,
        manifestBytes: new TextEncoder().encode("fixture"),
        replayDependencies: [],
        sourceRevision: { gitCommit: COMMIT, dirty: false, dirtyDigest: null },
        ckbBinary: { ...CKB_BINARY, archiveSha256: `sha256:${"4".repeat(64)}` },
        observedRuntimeVersion: "1.2.19",
      }),
    ).rejects.toThrow("CKB archive provenance mismatch");
  });

  test("validates emitted stable and tainted provenance against the published schema", async () => {
    const stableProject = await project();
    const taintedProject = await project("bun@1.2.18", false);
    const validate = await schemaValidator();
    const stable = await collectProvenance({
      projectRoot: stableProject.root,
      manifestBytes: new TextEncoder().encode("stable"),
      replayDependencies: [],
      sourceRevision: { gitCommit: COMMIT, dirty: false, dirtyDigest: null },
      ckbBinary: CKB_BINARY,
      observedRuntimeVersion: "1.2.19",
    });
    const tainted = await collectProvenance({
      projectRoot: taintedProject.root,
      manifestBytes: new TextEncoder().encode("tainted"),
      replayDependencies: ["external_network"],
      sourceRevision: { gitCommit: COMMIT, dirty: true, dirtyDigest: `sha256:${"3".repeat(64)}` },
      ckbBinary: CKB_BINARY,
      observedRuntimeVersion: "1.2.19",
    });

    expect(validate(stable)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(validate(tainted)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("schema rejects internally inconsistent or incomplete provenance", async () => {
    const fixture = await project();
    const validate = await schemaValidator();
    const provenance = await collectProvenance({
      projectRoot: fixture.root,
      manifestBytes: new TextEncoder().encode("fixture"),
      replayDependencies: [],
      sourceRevision: { gitCommit: COMMIT, dirty: false, dirtyDigest: null },
      ckbBinary: CKB_BINARY,
      observedRuntimeVersion: "1.2.19",
    });

    const stableWithReason = structuredClone(provenance) as Record<string, any>;
    stableWithReason.replay.reasons.push({ scope: "environment", code: "lockfile_missing", detail: "contradiction" });
    expect(validate(stableWithReason)).toBe(false);

    const stableWithoutSource = structuredClone(provenance) as Record<string, any>;
    stableWithoutSource.source.gitCommit = null;
    expect(validate(stableWithoutSource)).toBe(false);

    const stableWithDirtySource = structuredClone(provenance) as Record<string, any>;
    stableWithDirtySource.source.dirty = true;
    stableWithDirtySource.source.dirtyDigest = `sha256:${"3".repeat(64)}`;
    expect(validate(stableWithDirtySource)).toBe(false);

    const stableWithoutLockfile = structuredClone(provenance) as Record<string, any>;
    stableWithoutLockfile.lockfile.sha256 = null;
    expect(validate(stableWithoutLockfile)).toBe(false);

    const stableWithoutRuntimePin = structuredClone(provenance) as Record<string, any>;
    stableWithoutRuntimePin.runtime.requestedVersion = null;
    expect(validate(stableWithoutRuntimePin)).toBe(false);

    const stableWithoutRuntimeMetadata = structuredClone(provenance) as Record<string, any>;
    stableWithoutRuntimeMetadata.runtime.metadata.sha256 = null;
    expect(validate(stableWithoutRuntimeMetadata)).toBe(false);

    const absoluteLockfile = structuredClone(provenance) as Record<string, any>;
    absoluteLockfile.lockfile.path = "/tmp/bun.lock";
    expect(validate(absoluteLockfile)).toBe(false);

    const missingBinaryDigest = structuredClone(provenance) as Record<string, any>;
    delete missingBinaryDigest.binaries.ckb.binarySha256;
    expect(validate(missingBinaryDigest)).toBe(false);
  });
});
