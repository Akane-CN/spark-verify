import { afterEach, describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as tar from "tar";
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

async function archiveFixture(platform: "linux" | "darwin" | "win32" = "linux", arch = "x64") {
  const root = await mkdtemp(join(tmpdir(), "ckb-verify-ckb-binary-"));
  directories.push(root);
  const format = resolvePinnedCkbAsset("0.209.0", platform, arch).format;
  const packageName = "fixture";
  const binaryName = platform === "win32" ? "ckb.exe" : "ckb";
  const binaryBytes = new TextEncoder().encode("original binary from the pinned archive");
  const source = join(root, "source");
  await mkdir(join(source, packageName), { recursive: true });
  await writeFile(join(source, packageName, binaryName), binaryBytes);
  const archivePath = join(root, `fixture.${format}`);
  if (format === "tar.gz") {
    await tar.c({ cwd: source, file: archivePath, gzip: true }, [packageName]);
  } else {
    const zip = new AdmZip();
    zip.addFile(`${packageName}/${binaryName}`, Buffer.from(binaryBytes));
    await writeFile(archivePath, zip.toBuffer());
  }
  const bytes = await readFile(archivePath);
  const asset: PinnedCkbAsset = {
    version: "0.209.0",
    assetName: `fixture.${format}`,
    packageName,
    archiveSha256: sha256Bytes(bytes) as `sha256:${string}`,
    archiveBytes: bytes.byteLength,
    format,
  };
  let downloads = 0;
  const options = {
    version: asset.version,
    root: join(root, "cache"),
    platform,
    arch,
    resolveAsset: () => asset,
    download: async () => {
      downloads += 1;
      return bytes;
    },
  };
  return { root, bytes, binaryBytes, asset, options, downloadCount: () => downloads };
}

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

  test("installs only verified bytes and revalidates cached identity without downloading", async () => {
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
    // A cache hit must derive identity from the pinned archive again.
    expect(extractions).toBe(2);

    await writeFile(first.path, "tampered binary");
    const repaired = await installPinnedCkbBinary(options);
    expect(repaired).toEqual(first);
    expect(downloads).toBe(2);
    expect(extractions).toBe(3);
  });

  test("rejects joint tampering of a cached binary and its mutable provenance digest", async () => {
    const { options, asset, binaryBytes, downloadCount } = await archiveFixture();
    const original = await installPinnedCkbBinary(options);
    expect(original.binarySha256).toBe(sha256Bytes(binaryBytes) as `sha256:${string}`);
    const tamperedBytes = new TextEncoder().encode("attacker-controlled binary");
    await writeFile(original.path, tamperedBytes);
    const metadataPath = join(options.root, asset.version, "ckb-verify-provenance.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, binarySha256: sha256Bytes(tamperedBytes) }));

    const repaired = await installPinnedCkbBinary(options);

    expect(repaired).toEqual(original);
    expect(await readFile(repaired.path)).toEqual(Buffer.from(binaryBytes));
    expect(downloadCount()).toBe(2);
  });

  test.each(["ckb", "ckb-verify-provenance.json", "fixture.tar.gz", "."])(
    "does not reuse a cache with a symlink at %s",
    async (entry) => {
      const { root, options, asset } = await archiveFixture();
      await installPinnedCkbBinary(options);
      const target = join(options.root, asset.version, entry);
      const redirected = join(root, "redirected");
      await rename(target, redirected);
      await symlink(redirected, target, entry === "." ? "dir" : "file");

      await expect(installPinnedCkbBinary({
        ...options,
        download: async () => { throw new Error("untrusted cache cannot be repaired offline"); },
      })).rejects.toThrow("untrusted cache cannot be repaired offline");
      expect(await readdir(options.root)).toEqual([asset.version]);
    },
  );

  test.each([
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ] as const)("revalidates actual %s/%s fixture archive bytes offline", async (platform, arch) => {
    const { options, asset, bytes, binaryBytes, downloadCount } = await archiveFixture(platform, arch);
    const installed = await installPinnedCkbBinary(options);
    const retained = await readFile(join(options.root, asset.version, asset.assetName));
    expect(retained).toEqual(bytes);
    expect(installed.archiveSha256).toBe(sha256Bytes(retained) as `sha256:${string}`);
    expect(installed.binarySha256).toBe(sha256Bytes(binaryBytes) as `sha256:${string}`);

    expect(await installPinnedCkbBinary({
      ...options,
      download: async () => { throw new Error("network must not be used for a valid cache"); },
    })).toEqual(installed);
    expect(downloadCount()).toBe(1);
    expect(await readdir(options.root)).toEqual([asset.version]);
  });

  test.each(["missing", "short", "oversized", "changed"])(
    "refuses retained archive damage (%s) before extracting cached bytes",
    async (damage) => {
      const { options, asset, bytes } = await archiveFixture();
      await installPinnedCkbBinary(options);
      const retainedPath = join(options.root, asset.version, asset.assetName);
      if (damage === "missing") {
        await rm(retainedPath);
      } else if (damage === "short") {
        await writeFile(retainedPath, bytes.subarray(1));
      } else if (damage === "oversized") {
        await writeFile(retainedPath, Buffer.concat([bytes, Buffer.from([0])]));
      } else {
        const changed = Buffer.from(bytes);
        changed[0] = changed[0]! ^ 0xff;
        await writeFile(retainedPath, changed);
      }
      let extractions = 0;

      await expect(installPinnedCkbBinary({
        ...options,
        download: async () => { throw new Error("no verified archive available offline"); },
        extract: async () => { extractions += 1; },
      })).rejects.toThrow("no verified archive available offline");
      expect(extractions).toBe(0);
      expect(await readdir(options.root)).toEqual([asset.version]);
    },
  );

  test.each(["source pin", "attacker digest"])("rejects coordinated tampering advertising %s", async (advertised) => {
    const { options, asset } = await archiveFixture("darwin");
    const original = await installPinnedCkbBinary(options);
    const malicious = Buffer.from("attacker-controlled binary");
    const zip = new AdmZip();
    zip.addFile(`${asset.packageName}/ckb`, malicious);
    const replacementArchive = zip.toBuffer();
    const installDir = join(options.root, asset.version);
    await writeFile(original.path, malicious);
    await writeFile(join(installDir, asset.assetName), replacementArchive);
    const metadataPath = join(installDir, "ckb-verify-provenance.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, JSON.stringify({
      ...metadata,
      binarySha256: sha256Bytes(malicious),
      archiveSha256: advertised === "source pin" ? asset.archiveSha256 : sha256Bytes(replacementArchive),
      expectedArchiveSha256: advertised === "source pin" ? asset.archiveSha256 : sha256Bytes(replacementArchive),
    }));

    await expect(installPinnedCkbBinary({
      ...options,
      download: async () => { throw new Error("untrusted cache cannot be repaired offline"); },
    })).rejects.toThrow("untrusted cache cannot be repaired offline");
    expect(await readdir(options.root)).toEqual([asset.version]);
  });

  test("removes verification staging when cached archive extraction fails", async () => {
    const { options, asset } = await archiveFixture();
    const original = await installPinnedCkbBinary(options);
    const originalBytes = await readFile(original.path);
    await expect(installPinnedCkbBinary({
      ...options,
      extract: async () => { throw new Error("extraction failed"); },
      download: async () => { throw new Error("replacement unavailable"); },
    })).rejects.toThrow("replacement unavailable");
    expect(await readFile(original.path)).toEqual(originalBytes);
    expect(await readdir(options.root)).toEqual([asset.version]);
  });

  test("keeps the previous install intact when a replacement fails verification", async () => {
    const { options, asset } = await archiveFixture();
    const original = await installPinnedCkbBinary(options);
    const damaged = Buffer.from("cached binary was modified");
    await writeFile(original.path, damaged);
    const metadataPath = join(options.root, asset.version, "ckb-verify-provenance.json");
    const metadata = await readFile(metadataPath);

    await expect(installPinnedCkbBinary({ ...options, download: async () => new Uint8Array() }))
      .rejects.toThrow("CKB archive size mismatch");
    expect(await readFile(original.path)).toEqual(damaged);
    expect(await readFile(metadataPath)).toEqual(metadata);
    expect(await readdir(options.root)).toEqual([asset.version]);
  });

  test.each(["ckb", "ckb-verify-provenance.json", "fixture.tar.gz"])(
    "does not reuse a cache with a directory at %s",
    async (entry) => {
      const { options, asset } = await archiveFixture();
      await installPinnedCkbBinary(options);
      const target = join(options.root, asset.version, entry);
      await rm(target);
      await mkdir(target);

      await expect(installPinnedCkbBinary({
        ...options,
        download: async () => { throw new Error("untrusted cache cannot be repaired offline"); },
      })).rejects.toThrow("untrusted cache cannot be repaired offline");
      expect(await readdir(options.root)).toEqual([asset.version]);
    },
  );

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
