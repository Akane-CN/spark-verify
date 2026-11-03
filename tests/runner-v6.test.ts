// Spec 0.2.0 runner preconditions that refuse a run before any devnet starts.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestText } from "../src/manifest";
import { readRepositoryBinaries } from "../src/runner";
import type { ManifestV6 } from "../src/types";

const manifest = (path: string) => parseManifestText(`[meta]
name = "binaries"
spec = "0.2.0"
[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
[replay]
dependencies = []
[setup]
accounts = 1
[setup.scripts.lock]
binary = "${path}"
hash_type = "data1"
[[assert.cell]]
lock = "lock"
count = 0
`, "verify.toml") as ManifestV6;

describe("repository binaries", () => {
  test("are read, hashed, and refused when OffCKB would not deploy them faithfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "binaries-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await mkdir(join(root, "build"));
      await writeFile(join(root, "build", "ok"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff]));
      await writeFile(join(root, "build", "ascii"), "only ascii bytes");
      await writeFile(join(root, "build", "empty"), "");
      await writeFile(join(root, "build", "huge"), Buffer.alloc(500 * 1024 + 1, 0xff));
      await writeFile(join(outside, "lock"), Buffer.from([0xff]));
      await symlink(join(outside, "lock"), join(root, "build", "escape"));
      await mkdir(join(root, "build", "dir"));
      const [binary] = await readRepositoryBinaries(root, manifest("build/ok"));
      expect(binary).toMatchObject({ name: "lock", path: "build/ok", hashType: "data1" });
      expect(binary!.bytes.length).toBe(5);
      await expect(readRepositoryBinaries(root, manifest("build/missing"))).rejects.toThrow("does not exist");
      await expect(readRepositoryBinaries(root, manifest("build/ascii"))).rejects.toThrow("no byte above 0x7f");
      await expect(readRepositoryBinaries(root, manifest("build/empty"))).rejects.toThrow("OffCKB 0.4.13 deploys 1..");
      await expect(readRepositoryBinaries(root, manifest("build/huge"))).rejects.toThrow("OffCKB 0.4.13 deploys 1..");
      await expect(readRepositoryBinaries(root, manifest("build/escape"))).rejects.toThrow("resolves outside the repository");
      await expect(readRepositoryBinaries(root, manifest("build/dir"))).rejects.toThrow("not a regular file");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
