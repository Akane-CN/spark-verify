import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../src/canonical";
import {
  assertSafeArchiveEntry,
  installPinnedCkbBinary,
  resolvePinnedCkbAsset,
  verifyPinnedCkbArchive,
  type PinnedCkbAsset,
} from "../src/ckb-binary";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("pinned CKB release assets", () => {
  test("selects the independently pinned portable Linux x64 archive", () => {
    expect(resolvePinnedCkbAsset("0.209.0", "linux", "x64")).toEqual({
      version: "0.209.0",
      assetName: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
      packageName: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable",
      archiveSha256: "sha256:11c29c752293dbad1504ead2ec14f85e9b732f09e51a87d318d9ccf46d3f5e34",
      archiveBytes: 32_908_291,
      format: "tar.gz",
    });
  });

  test("pins every OffCKB-supported platform to a GitHub release digest", () => {
    const cases = [
      ["linux", "arm64", "ckb_v0.209.0_aarch64-unknown-linux-gnu.tar.gz", "200f85591d0f38ece71ccd8911f227943430bb575971348bc837d5e43cfcf472"],
      ["darwin", "x64", "ckb_v0.209.0_x86_64-apple-darwin-portable.zip", "bdc9dbab594eb9148270889d0604961e5c468d95550e3372930ddf36bc2d32b2"],
      ["darwin", "arm64", "ckb_v0.209.0_aarch64-apple-darwin.zip", "e344be338058a399c3756ef0fdfd2b387466730d4e3eeab96bc957e382a150cb"],
      ["win32", "x64", "ckb_v0.209.0_x86_64-pc-windows-msvc.zip", "7801672e4a181326423beb222cf48d71a9c579808943399b51ebc1cd42856401"],
    ] as const;

    for (const [platform, arch, assetName, digest] of cases) {
      const asset = resolvePinnedCkbAsset("0.209.0", platform, arch);
      expect(asset.assetName).toBe(assetName);
      expect(asset.archiveSha256).toBe(`sha256:${digest}`);
    }
  });

  test("rejects archive bytes that do not match the pinned digest", () => {
    const bytes = new TextEncoder().encode("not a CKB archive");
    const asset = {
      ...resolvePinnedCkbAsset("0.209.0", "linux", "x64"),
      archiveBytes: bytes.byteLength,
    };

    expect(() => verifyPinnedCkbArchive(asset, bytes)).toThrow("CKB archive checksum mismatch");
  });

  test("rejects traversal paths and link-like archive entries", () => {
    expect(() => assertSafeArchiveEntry("ckb_v0.209.0/ckb", "file")).not.toThrow();
    expect(() => assertSafeArchiveEntry("ckb_v0.209.0/", "directory")).not.toThrow();

    for (const unsafePath of ["../ckb", "pkg/../../ckb", "/tmp/ckb", "C:\\tmp\\ckb", "\\\\server\\share\\ckb"]) {
      expect(() => assertSafeArchiveEntry(unsafePath, "file")).toThrow("unsafe archive path");
    }
    for (const unsafeKind of ["symlink", "hardlink", "device"] as const) {
      expect(() => assertSafeArchiveEntry("ckb_v0.209.0/ckb", unsafeKind)).toThrow("unsafe archive entry type");
    }
  });

  test("installs only verified bytes and reuses a binary whose recorded digest still matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-verify-ckb-binary-"));
    directories.push(root);
    const bytes = new TextEncoder().encode("verified archive fixture");
    const asset: PinnedCkbAsset = {
      version: "0.209.0",
      assetName: "fixture.tar.gz",
      packageName: "fixture",
      archiveSha256: sha256Bytes(bytes) as `sha256:${string}`,
      archiveBytes: bytes.byteLength,
      format: "tar.gz",
    };
    let downloads = 0;
    let extractions = 0;
    const options = {
      version: "0.209.0",
      root,
      platform: "linux" as const,
      arch: "x64",
      resolveAsset: () => asset,
      download: async () => {
        downloads += 1;
        return bytes;
      },
      extract: async (_archivePath: string, destination: string) => {
        extractions += 1;
        const packageRoot = join(destination, asset.packageName);
        await mkdir(packageRoot, { recursive: true });
        const binaryPath = join(packageRoot, "ckb");
        await writeFile(binaryPath, "fixture ckb binary");
        await chmod(binaryPath, 0o755);
      },
    };

    const first = await installPinnedCkbBinary(options);
    const second = await installPinnedCkbBinary(options);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: "0.209.0",
      platform: "linux",
      architecture: "x64",
      asset: "fixture.tar.gz",
      expectedArchiveSha256: asset.archiveSha256,
      archiveSha256: asset.archiveSha256,
      binarySha256: sha256Bytes(new TextEncoder().encode("fixture ckb binary")),
    });
    expect(first.path).toBe(join(root, "0.209.0", "ckb"));
    expect(downloads).toBe(1);
    expect(extractions).toBe(1);

    await writeFile(first.path, "tampered binary");
    const repaired = await installPinnedCkbBinary(options);
    expect(repaired).toEqual(first);
    expect(downloads).toBe(2);
    expect(extractions).toBe(2);
  });

  test("does not extract archive bytes until their pinned checksum passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ckb-verify-ckb-binary-"));
    directories.push(root);
    const bytes = new TextEncoder().encode("tampered");
    const asset: PinnedCkbAsset = {
      version: "0.209.0",
      assetName: "fixture.tar.gz",
      packageName: "fixture",
      archiveSha256: `sha256:${"0".repeat(64)}`,
      archiveBytes: bytes.byteLength,
      format: "tar.gz",
    };
    let extractions = 0;

    await expect(
      installPinnedCkbBinary({
        version: asset.version,
        root,
        resolveAsset: () => asset,
        download: async () => bytes,
        extract: async () => {
          extractions += 1;
        },
      }),
    ).rejects.toThrow("CKB archive checksum mismatch");
    expect(extractions).toBe(0);
  });
});
