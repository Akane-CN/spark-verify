import AdmZip from "adm-zip";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import { sha256Bytes } from "./canonical";

export type SupportedPlatform = "linux" | "darwin" | "win32";
export type SupportedArchitecture = "x64" | "arm64";

export interface PinnedCkbAsset {
  version: string;
  assetName: string;
  packageName: string;
  archiveSha256: `sha256:${string}`;
  archiveBytes: number;
  format: "tar.gz" | "zip";
}

export interface InstalledCkbBinary {
  path: string;
  version: string;
  platform: NodeJS.Platform;
  architecture: string;
  asset: string;
  sourceUrl: string;
  expectedArchiveSha256: `sha256:${string}`;
  archiveSha256: `sha256:${string}`;
  binarySha256: `sha256:${string}`;
}

export type CkbArchiveDownloader = (url: string, asset: PinnedCkbAsset) => Promise<Uint8Array>;
export type CkbArchiveExtractor = (
  archivePath: string,
  destination: string,
  asset: PinnedCkbAsset,
) => Promise<void>;

export interface InstallPinnedCkbBinaryOptions {
  version: string;
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
  resolveAsset?: (version: string, platform: NodeJS.Platform, arch: string) => PinnedCkbAsset;
  download?: CkbArchiveDownloader;
  extract?: CkbArchiveExtractor;
}

const PINNED_CKB_ASSETS: Record<string, PinnedCkbAsset> = {
  "0.209.0:linux:x64": {
    version: "0.209.0",
    assetName: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable.tar.gz",
    packageName: "ckb_v0.209.0_x86_64-unknown-linux-gnu-portable",
    archiveSha256: "sha256:11c29c752293dbad1504ead2ec14f85e9b732f09e51a87d318d9ccf46d3f5e34",
    archiveBytes: 32_908_291,
    format: "tar.gz",
  },
  "0.209.0:linux:arm64": {
    version: "0.209.0",
    assetName: "ckb_v0.209.0_aarch64-unknown-linux-gnu.tar.gz",
    packageName: "ckb_v0.209.0_aarch64-unknown-linux-gnu",
    archiveSha256: "sha256:200f85591d0f38ece71ccd8911f227943430bb575971348bc837d5e43cfcf472",
    archiveBytes: 32_954_715,
    format: "tar.gz",
  },
  "0.209.0:darwin:x64": {
    version: "0.209.0",
    assetName: "ckb_v0.209.0_x86_64-apple-darwin-portable.zip",
    packageName: "ckb_v0.209.0_x86_64-apple-darwin-portable",
    archiveSha256: "sha256:bdc9dbab594eb9148270889d0604961e5c468d95550e3372930ddf36bc2d32b2",
    archiveBytes: 28_883_274,
    format: "zip",
  },
  "0.209.0:darwin:arm64": {
    version: "0.209.0",
    assetName: "ckb_v0.209.0_aarch64-apple-darwin.zip",
    packageName: "ckb_v0.209.0_aarch64-apple-darwin",
    archiveSha256: "sha256:e344be338058a399c3756ef0fdfd2b387466730d4e3eeab96bc957e382a150cb",
    archiveBytes: 27_621_590,
    format: "zip",
  },
  "0.209.0:win32:x64": {
    version: "0.209.0",
    assetName: "ckb_v0.209.0_x86_64-pc-windows-msvc.zip",
    packageName: "ckb_v0.209.0_x86_64-pc-windows-msvc",
    archiveSha256: "sha256:7801672e4a181326423beb222cf48d71a9c579808943399b51ebc1cd42856401",
    archiveBytes: 27_425_347,
    format: "zip",
  },
};

export function resolvePinnedCkbAsset(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PinnedCkbAsset {
  const asset = PINNED_CKB_ASSETS[`${version}:${platform}:${arch}`];
  if (asset !== undefined) return asset;
  throw new Error(`no pinned CKB release archive for ${version} on ${platform}/${arch}`);
}

export function verifyPinnedCkbArchive(asset: PinnedCkbAsset, bytes: Uint8Array): `sha256:${string}` {
  if (bytes.byteLength !== asset.archiveBytes) {
    throw new Error(
      `CKB archive size mismatch for ${asset.assetName}: expected ${asset.archiveBytes}, observed ${bytes.byteLength}`,
    );
  }
  const observed = sha256Bytes(bytes) as `sha256:${string}`;
  if (observed !== asset.archiveSha256) {
    throw new Error(
      `CKB archive checksum mismatch for ${asset.assetName}: expected ${asset.archiveSha256}, observed ${observed}`,
    );
  }
  return observed;
}

export type ArchiveEntryKind = "file" | "directory" | "symlink" | "hardlink" | "device";

export function assertSafeArchiveEntry(entryPath: string, kind: ArchiveEntryKind): void {
  const canonicalPath = entryPath.replaceAll("\\", "/");
  const segments = canonicalPath.split("/").filter((segment) => segment !== "");
  if (
    canonicalPath.length === 0 ||
    canonicalPath.includes("\0") ||
    canonicalPath.startsWith("/") ||
    /^[A-Za-z]:/.test(canonicalPath) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe archive path: ${entryPath}`);
  }
  if (kind !== "file" && kind !== "directory") {
    throw new Error(`unsafe archive entry type ${kind}: ${entryPath}`);
  }
}

function tarEntryKind(type: string): ArchiveEntryKind {
  if (type === "Directory") return "directory";
  if (type === "File" || type === "OldFile" || type === "ContiguousFile") return "file";
  if (type === "SymbolicLink") return "symlink";
  if (type === "Link") return "hardlink";
  return "device";
}

function zipEntryKind(entry: AdmZip.IZipEntry): ArchiveEntryKind {
  const unixFileType = (entry.attr >>> 16) & 0o170000;
  if (unixFileType === 0o120000) return "symlink";
  if (entry.isDirectory && (unixFileType === 0 || unixFileType === 0o040000)) return "directory";
  if (!entry.isDirectory && (unixFileType === 0 || unixFileType === 0o100000)) return "file";
  return "device";
}

function releaseUrl(asset: PinnedCkbAsset): string {
  return `https://github.com/nervosnetwork/ckb/releases/download/v${asset.version}/${asset.assetName}`;
}

async function downloadPinnedArchive(url: string, asset: PinnedCkbAsset): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("CKB archive download timed out")), 120_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "ckb-verify" },
    });
    if (!response.ok) throw new Error(`CKB archive download failed with HTTP ${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number.parseInt(contentLength, 10) !== asset.archiveBytes) {
      throw new Error(
        `CKB archive Content-Length mismatch for ${asset.assetName}: expected ${asset.archiveBytes}, observed ${contentLength}`,
      );
    }
    if (response.body === null) throw new Error("CKB archive response has no body");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let observedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      observedBytes += value.byteLength;
      if (observedBytes > asset.archiveBytes) {
        await reader.cancel("archive exceeded pinned byte length");
        throw new Error(`CKB archive exceeded pinned byte length ${asset.archiveBytes}`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(observedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

async function extractArchive(
  archivePath: string,
  destination: string,
  asset: PinnedCkbAsset,
): Promise<void> {
  if (asset.format === "tar.gz") {
    await tar.x({
      cwd: destination,
      file: archivePath,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => {
        const kind =
          "type" in entry
            ? tarEntryKind(String(entry.type))
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : entry.isSymbolicLink()
                  ? "symlink"
                  : "device";
        assertSafeArchiveEntry(entryPath, kind);
        return true;
      },
    });
    return;
  }
  const zip = new AdmZip(archivePath);
  for (const entry of zip.getEntries()) {
    assertSafeArchiveEntry(entry.entryName, zipEntryKind(entry));
  }
  zip.extractAllTo(destination, true);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readCachedBinary(
  installDir: string,
  binaryPath: string,
  asset: PinnedCkbAsset,
  sourceUrl: string,
  platform: NodeJS.Platform,
  architecture: string,
): Promise<InstalledCkbBinary | undefined> {
  try {
    const metadataValue: unknown = JSON.parse(await readFile(join(installDir, "ckb-verify-provenance.json"), "utf8"));
    if (!isObject(metadataValue)) return undefined;
    const metadata = metadataValue as Partial<InstalledCkbBinary> & { schema?: unknown };
    if (
      metadata.schema !== "ckb-verify-ckb-binary/1" ||
      metadata.version !== asset.version ||
      metadata.platform !== platform ||
      metadata.architecture !== architecture ||
      metadata.asset !== asset.assetName ||
      metadata.sourceUrl !== sourceUrl ||
      metadata.expectedArchiveSha256 !== asset.archiveSha256 ||
      metadata.archiveSha256 !== asset.archiveSha256 ||
      typeof metadata.binarySha256 !== "string"
    ) {
      return undefined;
    }
    const binaryStat = await lstat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) return undefined;
    const binarySha256 = sha256Bytes(await readFile(binaryPath)) as `sha256:${string}`;
    if (binarySha256 !== metadata.binarySha256) return undefined;
    return {
      path: binaryPath,
      version: asset.version,
      platform,
      architecture,
      asset: asset.assetName,
      sourceUrl,
      expectedArchiveSha256: asset.archiveSha256,
      archiveSha256: asset.archiveSha256,
      binarySha256,
    };
  } catch {
    return undefined;
  }
}

export async function installPinnedCkbBinary(
  options: InstallPinnedCkbBinaryOptions,
): Promise<InstalledCkbBinary> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolveAsset = options.resolveAsset ?? resolvePinnedCkbAsset;
  const asset = resolveAsset(options.version, platform, arch);
  if (asset.version !== options.version) {
    throw new Error(`resolved CKB asset version ${asset.version} does not match requested ${options.version}`);
  }
  const sourceUrl = releaseUrl(asset);
  const installDir = join(options.root, asset.version);
  const binaryPath = join(installDir, platform === "win32" ? "ckb.exe" : "ckb");
  const cached = await readCachedBinary(installDir, binaryPath, asset, sourceUrl, platform, arch);
  if (cached !== undefined) return cached;

  await mkdir(options.root, { recursive: true });
  const staging = await mkdtemp(join(options.root, `.install-${asset.version}-`));
  try {
    const download = options.download ?? downloadPinnedArchive;
    const bytes = await download(sourceUrl, asset);
    const archiveSha256 = verifyPinnedCkbArchive(asset, bytes);
    const archivePath = join(staging, asset.assetName);
    const extractDir = join(staging, "extract");
    await mkdir(extractDir, { recursive: true });
    await writeFile(archivePath, bytes);
    await (options.extract ?? extractArchive)(archivePath, extractDir, asset);

    const extractedRoot = join(extractDir, asset.packageName);
    const extractedBinary = join(extractedRoot, platform === "win32" ? "ckb.exe" : "ckb");
    const extractedStat = await lstat(extractedBinary);
    if (!extractedStat.isFile() || extractedStat.isSymbolicLink()) {
      throw new Error(`verified CKB archive did not contain a regular binary at ${asset.packageName}`);
    }
    if (platform !== "win32") await chmod(extractedBinary, 0o755);
    const binarySha256 = sha256Bytes(await readFile(extractedBinary)) as `sha256:${string}`;
    const result: InstalledCkbBinary = {
      path: binaryPath,
      version: asset.version,
      platform,
      architecture: arch,
      asset: asset.assetName,
      sourceUrl,
      expectedArchiveSha256: asset.archiveSha256,
      archiveSha256,
      binarySha256,
    };
    await writeFile(
      join(extractedRoot, "ckb-verify-provenance.json"),
      `${JSON.stringify({ schema: "ckb-verify-ckb-binary/1", ...result, path: undefined }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rm(installDir, { force: true, recursive: true });
    await rename(extractedRoot, installDir);
    return result;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}
