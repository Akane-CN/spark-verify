import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { join, resolve, parse, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { Header } from "tar";
import { isDeepStrictEqual } from "node:util";
import { sha256Bytes } from "./canonical";

export interface DebuggerByteIdentity {
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

export interface PinnedDebuggerAsset {
  readonly version: string;
  readonly platform: "linux";
  readonly architecture: "x64";
  readonly assetName: string;
  readonly sourceUrl: string;
  readonly archive: DebuggerByteIdentity;
  readonly executable: DebuggerByteIdentity;
}

const PIN: PinnedDebuggerAsset = Object.freeze({
  version: "1.1.1",
  platform: "linux",
  architecture: "x64",
  assetName: "ckb-debugger_v1.1.1_x86_64-unknown-linux-gnu.tar.gz",
  sourceUrl: "https://github.com/nervosnetwork/ckb-standalone-debugger/releases/download/v1.1.1/ckb-debugger_v1.1.1_x86_64-unknown-linux-gnu.tar.gz",
  archive: Object.freeze({ bytes: 2523369, sha256: "sha256:0dee02804af46386527c8bb94c2ee63592594ca1ec952ea42ffa9df07a9f005e" as const }),
  executable: Object.freeze({ bytes: 7582264, sha256: "sha256:24641357274ca464ecd86fd63b715ad96b5490d27b5ca029df37511e435d96f0" as const }),
});

// Explicit platform arguments also support verification of a recorded environment.
export function resolvePinnedDebuggerAsset(
  version: string, platform: NodeJS.Platform, arch: string,
): PinnedDebuggerAsset {
  if (version !== PIN.version || platform !== PIN.platform || arch !== PIN.architecture) {
    throw new Error(`no pinned debugger artifact for ${version} on ${platform}/${arch}`);
  }
  return PIN;
}

/** Path-free artifact observations, NOT an observed executable --version result. */
export interface DebuggerBinaryEvidence {
  readonly requestedVersion: string;
  readonly version: string;
  readonly platform: "linux";
  readonly architecture: "x64";
  readonly assetName: string;
  readonly sourceUrl: string;
  readonly archive: { readonly expected: DebuggerByteIdentity; readonly observed: DebuggerByteIdentity };
  readonly executable: { readonly expected: DebuggerByteIdentity; readonly observed: DebuggerByteIdentity };
}

// Pure consistency validation for future offline reports; no local-host defaults
// and no claim that a consistent report authenticates execution.
export function assertDebuggerBinaryEvidence(value: unknown): asserts value is DebuggerBinaryEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid debugger evidence");
  const record = value as Record<string, unknown>;
  if (typeof record.requestedVersion !== "string" || record.platform !== "linux" || record.architecture !== "x64") {
    throw new Error("invalid debugger evidence selection");
  }
  const pin = resolvePinnedDebuggerAsset(record.requestedVersion, record.platform, record.architecture);
  if (!isDeepStrictEqual(value, evidenceFor(pin, pin.archive, pin.executable))) {
    throw new Error("debugger evidence does not match source pins");
  }
}

export interface PreparedDebuggerBinary {
  readonly path: string;
  readonly directory: string;
  readonly evidence: DebuggerBinaryEvidence;
  /** Invalidate immediately and await removal of only this generated snapshot.
   * Concurrent/repeated success calls coalesce; failed removal can be retried.
   * The adapter must drain execution/revalidation before calling this on stop.
   */
  cleanup(): Promise<void>;
}

type SnapshotState = { pin: PinnedDebuggerAsset; path: string; directory: string; released: boolean };
const snapshots = new WeakMap<PreparedDebuggerBinary, SnapshotState>();

// This checks current bytes, not execution authenticity or an actively hostile
// same-UID writer. The adapter must call it before EVERY version/debug invocation.
export async function assertVerifiedDebuggerExecutable(prepared: PreparedDebuggerBinary, signal?: AbortSignal): Promise<void> {
  const state = snapshots.get(prepared);
  if (state === undefined || state.released) throw new Error("invalid or released debugger capability");
  checkpoint(signal);
  const directory = await directoryTree(state.directory, false, signal);
  if (directory === undefined || directory.uid !== process.getuid!() || (directory.mode & 0o777) !== 0o700) {
    throw new Error("unsafe debugger snapshot directory ownership or mode");
  }
  const file = await lstat(state.path);
  if ((file.mode & 0o7777) !== 0o500) throw new Error("unsafe debugger snapshot mode");
  verify(await readRegular(state.path, state.pin.executable.bytes, signal), state.pin.executable, "snapshot");
  checkpoint(signal);
  if (state.released) throw new Error("released debugger capability");
}

export interface PreparePinnedDebuggerBinaryOptions {
  version: string;
  /** Caller-controlled cache parent; the retained leaf is 1.1.1-linux-x64. */
  root: string;
  /** Caller-controlled execution parent, separate from the cache leaf. Only the
   * generated debugger-* child is transferred to cleanup(), never this parent.
   */
  snapshotRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
  downloadTimeoutMs?: number;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;
type PrivateWriter = (path: string, bytes: Uint8Array, mode: number) => Promise<void>;
type TestDependencies = { transport: Transport; write?: PrivateWriter; remove?: (path: string) => Promise<void> };
const removePrivate = (path: string) => rm(path, { recursive: true, force: true });
const writePrivate: PrivateWriter = (path, bytes, mode) => writeFile(path, bytes, { mode, flag: "wx" });

/** Never executes a binary. Only an absent cache leaf permits installation;
 * existing invalid/incomplete caches fail without repair or download fallback.
 * Owns staging/reservation/snapshot until successful return, and awaits all owned
 * cleanup on failure. Caller-created roots and successfully published caches stay.
 * Cancellation checkpoints cannot interrupt a filesystem syscall; this promise
 * waits for it and cleanup. Only the read-only download has a time-limit race.
 * Requires caller-controlled roots; does not defeat an actively hostile same UID.
 */
export function preparePinnedDebuggerBinary(options: PreparePinnedDebuggerBinaryOptions): Promise<PreparedDebuggerBinary> {
  return prepare(options, PIN, { transport: fetch });
}

/** @internal Code-only fixture seam, capped at 1 MiB per identity. No resolver,
 * extractor, path or production-pin override is accepted by preparation options.
 * Fixture evidence intentionally cannot satisfy the production evidence validator.
 */
export function debuggerBinaryTestOnly(
  identities: { archive: DebuggerByteIdentity; executable: DebuggerByteIdentity }, dependencies: TestDependencies,
) {
  for (const value of [identities.archive, identities.executable]) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 1_048_576 || !/^sha256:[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error("invalid debugger fixture identity");
    }
  }
  const pin = Object.freeze({ ...PIN,
    archive: Object.freeze({ ...identities.archive }), executable: Object.freeze({ ...identities.executable }),
  });
  const hooks = Object.freeze({ ...dependencies });
  return Object.freeze({ prepare: (options: PreparePinnedDebuggerBinaryOptions) => prepare(options, pin, hooks) });
}

function measure(bytes: Uint8Array): DebuggerByteIdentity {
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256Bytes(bytes) as `sha256:${string}` });
}

function verify(bytes: Uint8Array, expected: DebuggerByteIdentity, label: string): DebuggerByteIdentity {
  if (bytes.byteLength !== expected.bytes) throw new Error(`debugger ${label} size mismatch`);
  const observed = measure(bytes);
  if (observed.sha256 !== expected.sha256) throw new Error(`debugger ${label} checksum mismatch`);
  return observed;
}

function evidenceFor(pin: PinnedDebuggerAsset, archive: DebuggerByteIdentity, executable: DebuggerByteIdentity): DebuggerBinaryEvidence {
  return Object.freeze({
    requestedVersion: pin.version, version: pin.version, platform: pin.platform, architecture: pin.architecture,
    assetName: pin.assetName, sourceUrl: pin.sourceUrl,
    archive: Object.freeze({ expected: pin.archive, observed: archive }),
    executable: Object.freeze({ expected: pin.executable, observed: executable }),
  });
}

// This is deliberately NOT a general tar installer. Decode bounded bytes with
// tar's header codec, then copy only the two exact regular members into memory.
// No archive-supplied path, mode, uid or link ever reaches a filesystem writer.
function extract(archive: Buffer, pin: PinnedDebuggerAsset): { executable: Buffer; license: Buffer } {
  let bytes: Buffer;
  try { bytes = gunzipSync(archive, { maxOutputLength: pin.executable.bytes + 65_536 + 16_384 }); }
  catch (cause) { throw new Error("unsafe debugger tar: invalid or oversized gzip", { cause }); }
  const members = new Map<string, Buffer>();
  let ended = false;
  if (bytes.length % 512 !== 0) throw new Error("unsafe debugger tar: truncated block");
  for (let offset = 0; offset < bytes.length;) {
    const header = new Header(bytes, offset);
    if (header.nullBlock) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some(byte => byte !== 0)) {
        throw new Error("unsafe debugger tar: invalid trailer");
      }
      ended = true;
      break;
    }
    if (!header.cksumValid) throw new Error("unsafe debugger tar: header checksum mismatch");
    if ((header.path !== "ckb-debugger" && header.path !== "LICENSE") || members.has(header.path)) {
      throw new Error("unsafe debugger tar: unexpected or duplicate path");
    }
    if ((header.type !== "File" && header.type !== "OldFile") || header.linkpath) {
      throw new Error("unsafe debugger tar: nonregular entry");
    }
    const size = header.size;
    const limit = header.path === "ckb-debugger" ? pin.executable.bytes : 65_536;
    if (size === undefined || !Number.isSafeInteger(size) || size < 1 || size > limit) {
      throw new Error("unsafe debugger tar: member size mismatch");
    }
    offset += 512;
    const end = offset + Math.ceil(size / 512) * 512;
    if (end > bytes.length) throw new Error("unsafe debugger tar: truncated member");
    members.set(header.path, Buffer.from(bytes.subarray(offset, offset + size)));
    offset = end;
  }
  const executable = members.get("ckb-debugger");
  const license = members.get("LICENSE");
  if (!ended || executable === undefined || license === undefined) throw new Error("unsafe debugger tar: incomplete archive");
  return { executable, license };
}

function checkpoint(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("debugger preparation aborted");
}

// Only race read-only transport operations. No mutating worker is abandoned.
async function transportWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, canceled]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function download(pin: PinnedDebuggerAsset, transport: Transport, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  checkpoint(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("debugger download timed out")), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    const pending = transport(pin.sourceUrl, { signal: controller.signal, redirect: "follow", headers: { "user-agent": "ckb-verify" } });
    void pending.then(response => {
      if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
    }, () => {});
    const response = await transportWait(pending, controller.signal);
    checkpoint(controller.signal);
    reader = response.body?.getReader();
    if (!response.ok) throw new Error(`debugger archive HTTP ${response.status}`);
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) !== pin.archive.bytes)) {
      throw new Error("debugger archive Content-Length mismatch");
    }
    if (reader === undefined) throw new Error("debugger archive response has no body");
    while (true) {
      const { value, done } = await transportWait(reader.read(), controller.signal);
      checkpoint(controller.signal);
      if (done) break;
      length += value.byteLength;
      if (length > pin.archive.bytes) throw new Error("debugger archive size mismatch: byte limit exceeded");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    // Read-only cancellation may be uncooperative; it cannot perform phase writes.
    void reader?.cancel().catch(() => {});
  }
}

// Inspect every existing component without following directory symlinks.
async function directoryTree(path: string, create = false, signal?: AbortSignal): Promise<Stats | undefined> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  let result: Stats | undefined;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    checkpoint(signal);
    current = join(current, part);
    result = await lstat(current).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    checkpoint(signal);
    if (result === undefined) {
      if (!create) return undefined;
      await mkdir(current, { mode: 0o700 });
      checkpoint(signal);
      result = await lstat(current);
    }
    if (!result.isDirectory()) throw new Error("unsafe debugger directory type");
  }
  return result;
}

function regularFile(stat: Stats, limit: number): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.uid !== process.getuid!()) {
    throw new Error("unsafe debugger file type, links, owner or size");
  }
}

async function readRegular(path: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  checkpoint(signal);
  const before = await lstat(path);
  regularFile(before, limit);
  checkpoint(signal);
  // NONBLOCK closes the lstat/open FIFO race; NOFOLLOW closes the final symlink race.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let failed = false;
  let primaryError: unknown;
  try {
    const opened = await handle.stat();
    regularFile(opened, limit);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("unsafe debugger file changed during open");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      checkpoint(signal);
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    regularFile(after, limit);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("unsafe debugger file changed during read");
    }
    checkpoint(signal);
    return bytes.subarray(0, length);
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    try { await handle.close(); }
    catch (closeError) {
      if (failed) throw new AggregateError([primaryError, closeError], "debugger file read and close failed");
      throw closeError;
    }
  }
}

async function prepare(
  options: PreparePinnedDebuggerBinaryOptions, pin: PinnedDebuggerAsset, dependencies: TestDependencies,
): Promise<PreparedDebuggerBinary> {
  // Retain path/cancellation ownership across awaits; do not reopen caller options.
  options = { ...options, root: resolve(options.root), snapshotRoot: resolve(options.snapshotRoot) };
  resolvePinnedDebuggerAsset(options.version, options.platform ?? process.platform, options.arch ?? process.arch);
  const timeoutMs = options.downloadTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("invalid debugger download timeout");
  }
  checkpoint(options.signal);
  const cache = join(options.root, "1.1.1-linux-x64");
  const cached = await directoryTree(cache, false, options.signal);
  await directoryTree(options.snapshotRoot, false, options.signal);
  const archive = cached === undefined
    ? await download(pin, dependencies.transport, timeoutMs, options.signal)
    : await readRegular(join(cache, pin.assetName), pin.archive.bytes, options.signal);
  const archiveIdentity = verify(archive, pin.archive, "archive");
  const extracted = extract(archive, pin);
  const executable = cached === undefined ? extracted.executable : await readRegular(join(cache, "ckb-debugger"), pin.executable.bytes, options.signal);
  const evidence = evidenceFor(pin, archiveIdentity, verify(executable, pin.executable, "executable"));
  if (cached !== undefined) {
    const names = (await readdir(cache)).sort();
    if (!isDeepStrictEqual(names, [pin.assetName, "ckb-debugger", "LICENSE", "ckb-verify-provenance.json"].sort())) {
      throw new Error("debugger cache is incomplete or contains unexpected entries");
    }
    if (!isDeepStrictEqual(await readRegular(join(cache, "LICENSE"), 65_536, options.signal), extracted.license)) {
      throw new Error("debugger cached license mismatch");
    }
    const metadata: unknown = JSON.parse((await readRegular(join(cache, "ckb-verify-provenance.json"), 8192, options.signal)).toString("utf8"));
    if (!isDeepStrictEqual(metadata, evidence)) throw new Error("debugger cache evidence mismatch");
  }
  const write: PrivateWriter = async (path, bytes, mode) => {
    checkpoint(options.signal);
    await (dependencies.write ?? writePrivate)(path, bytes, mode);
    checkpoint(options.signal);
  };
  const remove = dependencies.remove ?? removePrivate;
  let staging: string | undefined;
  let reservation: string | undefined;
  let directory: string | undefined;
  try {
    if (cached === undefined) {
      await directoryTree(options.root, true, options.signal);
      checkpoint(options.signal);
      staging = await mkdtemp(join(options.root, ".install-debugger-"));
      checkpoint(options.signal);
      await write(join(staging, pin.assetName), archive, 0o600);
      await write(join(staging, "ckb-debugger"), executable, 0o500);
      await write(join(staging, "LICENSE"), extracted.license, 0o600);
      await write(join(staging, "ckb-verify-provenance.json"), Buffer.from(JSON.stringify(evidence)), 0o600);
      checkpoint(options.signal);
      // mkdir is exclusive: never rename over an unowned empty/incomplete cache.
      // A concurrent preparation sees the reservation as incomplete and fails.
      await mkdir(cache, { mode: 0o700 });
      reservation = cache;
      checkpoint(options.signal);
      await rename(staging, cache);
      reservation = undefined;
      staging = undefined; // Publication transfers ownership to the retained cache.
      checkpoint(options.signal);
    }
    await directoryTree(options.snapshotRoot, true, options.signal);
    checkpoint(options.signal);
    directory = await mkdtemp(join(options.snapshotRoot, "debugger-"));
    checkpoint(options.signal);
    const path = join(directory, "ckb-debugger");
    await write(path, executable, 0o500);
    const snapshotIdentity = verify(await readRegular(path, pin.executable.bytes, options.signal), pin.executable, "snapshot");
    const snapshotEvidence = evidenceFor(pin, archiveIdentity, snapshotIdentity);
    checkpoint(options.signal);
    const owned = directory;
    const state: SnapshotState = { pin, path, directory, released: false };
    let cleanup: Promise<void> | undefined;
    const prepared = Object.freeze({ path, directory, evidence: snapshotEvidence, cleanup: () => {
      state.released = true;
      cleanup ??= remove(owned).catch(error => { cleanup = undefined; throw error; });
      return cleanup;
    } });
    snapshots.set(prepared, state);
    await assertVerifiedDebuggerExecutable(prepared, options.signal);
    return prepared;
  } catch (error) {
    // Cleanup is never canceled or raced. Attempt every owned path even if one
    // removal fails, and let the caller observe both preparation and cleanup errors.
    const failures: unknown[] = [];
    for (const owned of [directory, staging, reservation]) {
      if (owned === undefined) continue;
      try { await remove(owned); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "debugger preparation and cleanup failed");
    throw error;
  }
}
