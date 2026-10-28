import { afterEach, expect, spyOn, test } from "bun:test";
import * as debuggerBinary from "../src/debugger-binary";
import * as fs from "node:fs/promises";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import * as tar from "tar";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

function identity(bytes: Uint8Array) {
  return { bytes: bytes.byteLength, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "debugger-binary-"));
  directories.push(root);
  const binary = Buffer.from("fixture bytes, deliberately not an executable\n");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "ckb-debugger"), binary);
  await writeFile(join(source, "LICENSE"), "fixture license\n");
  const archivePath = join(root, "fixture.tar.gz");
  await tar.c({ cwd: source, file: archivePath, gzip: true, portable: true }, ["ckb-debugger", "LICENSE"]);
  const archive = await readFile(archivePath);
  const options = { version: "1.1.1", platform: "linux" as const, arch: "x64", root: join(root, "cache"), snapshotRoot: join(root, "runs") };
  let downloads = 0;
  const transport = async () => { downloads++; return new Response(archive); };
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(archive), executable: identity(binary) }, { transport });
  const cache = join(options.root, "1.1.1-linux-x64");
  return { root, source, binary, archive, options, cache, harness, transport, downloads: () => downloads };
}

test.each(["short", "oversized", "hash"])("checks archive %s before parsing or writing", async damage => {
  const f = await fixture();
  const bytes = damage === "short" ? Buffer.alloc(f.archive.length - 1)
    : Buffer.alloc(f.archive.length + (damage === "oversized" ? 1 : 0));
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => new Response(bytes),
  });
  await expect(harness.prepare(f.options)).rejects.toThrow(damage === "hash" ? "archive checksum mismatch" : "archive size mismatch");
  expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
});

test.each(["size", "checksum"])("enforces the independent executable %s pin", async damage => {
  const f = await fixture();
  const executable = damage === "size" ? { ...identity(f.binary), bytes: f.binary.length + 1 }
    : identity(Buffer.alloc(f.binary.length));
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable }, { transport: f.transport });
  await expect(harness.prepare(f.options)).rejects.toThrow(`executable ${damage} mismatch`);
  expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
});

test("stops reading immediately when streamed bytes exceed the pin", async () => {
  const f = await fixture();
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(Buffer.alloc(f.archive.length + 1));
      else controller.error(new Error("read beyond byte limit"));
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => new Response(body),
  });
  await expect(harness.prepare(f.options)).rejects.toThrow("archive size mismatch");
  expect(pulls).toBe(1);
  expect(canceled).toBe(true);
});

test.each(["HTTP", "length", "malformed length", "body"])("refuses invalid download %s", async kind => {
  const f = await fixture();
  const response = kind === "body" ? new Response(null) : new Response(f.archive, {
    status: kind === "HTTP" ? 503 : 200,
    headers: kind.includes("length") ? { "content-length": kind === "length" ? "1" : `${f.archive.length}junk` } : {},
  });
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => response,
  });
  await expect(harness.prepare(f.options)).rejects.toThrow(kind.includes("length") ? "Content-Length" : kind);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test.each(["headers", "body"])("times out an uncooperative %s transport without late writes", async phase => {
  const f = await fixture();
  const gate = deferred<Response>();
  let observedSignal: AbortSignal | null | undefined;
  let cancelObserved = false;
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    cancel() { cancelObserved = true; },
  });
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async (_url, init) => {
      observedSignal = init.signal;
      return phase === "headers" ? gate.promise : new Response(body);
    },
  });
  let settled = false;
  const pending = harness.prepare({ ...f.options, downloadTimeoutMs: 10 });
  const result = pending.then(async value => { settled = true; await value.cleanup(); return "resolved"; }, error => {
    settled = true; return String(error);
  });
  await Bun.sleep(35);
  const settledWithinBound = settled;
  const abortedBeforeSettlement = observedSignal?.aborted;
  if (phase === "headers") gate.resolve(new Response(body));
  if (!cancelObserved) { bodyController.enqueue(f.archive); bodyController.close(); }
  const message = await result;
  await Bun.sleep(5);
  expect(settledWithinBound).toBe(true);
  expect(abortedBeforeSettlement).toBe(true);
  expect(message).toContain("download timed out");
  expect(cancelObserved).toBe(true);
  expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
});

test("rejects nonfinite or out-of-policy timeouts before I/O", async () => {
  const f = await fixture();
  for (const downloadTimeoutMs of [0, -1, NaN, Infinity, 0.5, 120001]) {
    await expect(f.harness.prepare({ ...f.options, downloadTimeoutMs })).rejects.toThrow("invalid debugger download timeout");
  }
  expect(f.downloads()).toBe(0);
});

type TarMember = { path: string; type?: tar.Header["type"]; bytes?: Buffer; size?: number; linkpath?: string };
function generatedTar(entries: TarMember[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.bytes ?? Buffer.from("fixture license\n");
    const header = new tar.Header({ path: entry.path, type: entry.type ?? "File", mode: 0o644,
      size: entry.size ?? body.length, ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }) });
    const block = Buffer.alloc(512);
    header.encode(block);
    blocks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function unsafeTar(f: Awaited<ReturnType<typeof fixture>>, archive: Buffer, message: string) {
  // Archive is trusted for this test so the SAME production extractor is exercised.
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(archive), executable: identity(f.binary) }, {
    transport: async () => new Response(Uint8Array.from(archive)),
  });
  await expect(harness.prepare(f.options)).rejects.toThrow(message);
  expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
}

test.each(["ckb-debugger", "LICENSE", "unexpected", "../escape", "/absolute", "pkg/../../escape", "./LICENSE", "C:\\escape", "folder\\escape"])(
  "rejects real tar duplicate or unexpected path %s", async path => {
    const f = await fixture();
    await unsafeTar(f, generatedTar([{ path: "ckb-debugger", bytes: f.binary }, { path: "LICENSE" }, { path }]), "unsafe debugger tar");
  },
);

test.each(["SymbolicLink", "Link", "Directory", "FIFO", "CharacterDevice", "BlockDevice", "ContiguousFile", "ExtendedHeader", "GlobalExtendedHeader"] as const)(
  "rejects real tar nonregular entry %s", async type => {
    const f = await fixture();
    await unsafeTar(f, generatedTar([{ path: "ckb-debugger", bytes: f.binary },
      { path: "LICENSE", type, ...(type === "SymbolicLink" || type === "Link" ? { linkpath: "ckb-debugger" } : {}) }]), "unsafe debugger tar");
  },
);

test.each(["missing license", "checksum", "truncated", "trailer", "license size", "expanded limit"])(
  "rejects malformed or unbounded tar: %s", async kind => {
    const f = await fixture();
    let entries: TarMember[] = [{ path: "ckb-debugger", bytes: f.binary }, { path: "LICENSE" }];
    if (kind === "missing license") entries = entries.slice(0, 1);
    if (kind === "license size") entries[1] = { path: "LICENSE", size: 65537 };
    let raw = gunzipSync(generatedTar(entries));
    if (kind === "checksum") raw[148] = raw[148]! ^ 1;
    if (kind === "truncated") raw = raw.subarray(0, 1550);
    if (kind === "trailer") raw[raw.length - 1] = 1;
    if (kind === "expanded limit") raw = Buffer.concat([raw, Buffer.alloc(200000)]);
    await unsafeTar(f, gzipSync(raw), "unsafe debugger tar");
  },
);

test("warm preparation remeasures cached bytes offline into a different private snapshot", async () => {
  const f = await fixture();
  const cold = await f.harness.prepare(f.options);
  const offline = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => { throw new Error("offline: must not download"); },
  });
  const warm = await offline.prepare(f.options);
  expect(warm.evidence).toEqual(cold.evidence);
  expect(warm.path).not.toBe(cold.path);
  expect((await lstat(warm.path)).ino).not.toBe((await lstat(cold.path)).ino);
  expect(await readFile(warm.path)).toEqual(f.binary);
  await cold.cleanup();
  expect(await readFile(warm.path)).toEqual(f.binary);
  await warm.cleanup();
  expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
  expect(await readdir(f.options.snapshotRoot)).toEqual([]);
});

test.each(["before", "headers", "body"])("honors caller cancellation %s download", async phase => {
  const f = await fixture();
  const controller = new AbortController();
  const entered = deferred<void>();
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  let canceled = false;
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async (_url, init) => {
      calls++; signal = init.signal; entered.resolve();
      if (phase === "before") return new Response(f.archive);
      if (phase === "headers") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ cancel() { canceled = true; } }));
    },
  });
  if (phase === "before") controller.abort(new Error("caller stopped"));
  const pending = harness.prepare({ ...f.options, signal: controller.signal, downloadTimeoutMs: 50 });
  if (phase !== "before") { await entered.promise; await Bun.sleep(1); controller.abort(new Error("caller stopped")); }
  await expect(pending).rejects.toThrow("caller stopped");
  if (phase === "before") expect(calls).toBe(0);
  else expect(signal?.aborted).toBe(true);
  if (phase === "body") expect(canceled).toBe(true);
  expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
});

test.each(["missing metadata", "malformed metadata", "changed metadata", "missing license", "changed license", "extra entry", "missing archive", "short archive", "changed archive", "binary and metadata", "all identities"])(
  "fails existing damaged cache without repair: %s", async kind => {
    const f = await fixture();
    const prepared = await f.harness.prepare(f.options);
    await prepared.cleanup();
    const metadataPath = join(f.cache, "ckb-verify-provenance.json");
    if (kind === "missing metadata") await rm(metadataPath);
    if (kind === "malformed metadata") await writeFile(metadataPath, "{");
    if (kind === "changed metadata") await writeFile(metadataPath, JSON.stringify({ ...prepared.evidence, version: "latest" }));
    if (kind === "missing license") await rm(join(f.cache, "LICENSE"));
    if (kind === "changed license") await writeFile(join(f.cache, "LICENSE"), "changed");
    if (kind === "extra entry") await writeFile(join(f.cache, "extra"), "unexpected");
    if (kind === "missing archive") await rm(join(f.cache, PIN.assetName));
    if (kind === "short archive") await writeFile(join(f.cache, PIN.assetName), f.archive.subarray(1));
    if (kind === "changed archive") await writeFile(join(f.cache, PIN.assetName), Buffer.alloc(f.archive.length));
    if (kind === "binary and metadata" || kind === "all identities") {
      const malicious = Buffer.alloc(f.binary.length, 1);
      const changed = structuredClone(prepared.evidence);
      await chmod(join(f.cache, "ckb-debugger"), 0o600);
      await writeFile(join(f.cache, "ckb-debugger"), malicious);
      const metadata = { ...changed, executable: { expected: identity(malicious), observed: identity(malicious) } };
      if (kind === "all identities") {
        const archive = generatedTar([{ path: "ckb-debugger", bytes: malicious }, { path: "LICENSE" }]);
        await writeFile(join(f.cache, PIN.assetName), archive);
        Object.assign(metadata, { archive: { expected: identity(archive), observed: identity(archive) } });
      }
      await writeFile(metadataPath, JSON.stringify(metadata));
    }
    const before = await readdir(f.cache);
    await expect(f.harness.prepare(f.options)).rejects.toThrow();
    expect(f.downloads()).toBe(1);
    expect(await readdir(f.cache)).toEqual(before);
    expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
    expect(await readdir(f.options.snapshotRoot)).toEqual([]);
  },
);

test.each(["ckb-debugger", "LICENSE", "ckb-verify-provenance.json", "ckb-debugger_v1.1.1_x86_64-unknown-linux-gnu.tar.gz"].flatMap(entry =>
  ["symlink", "hardlink", "directory"].map(kind => [entry, kind] as const)))(
  "rejects unsafe cache file %s as %s", async (entry, kind) => {
    const f = await fixture();
    await (await f.harness.prepare(f.options)).cleanup();
    const path = join(f.cache, entry);
    const other = join(f.root, "other");
    if (kind === "hardlink") await link(path, other);
    else {
      await rename(path, other);
      if (kind === "symlink") await symlink(other, path);
      else await mkdir(path);
    }
    await expect(f.harness.prepare(f.options)).rejects.toThrow("unsafe debugger");
    expect(f.downloads()).toBe(1);
    expect(await readdir(f.options.snapshotRoot)).toEqual([]);
    expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
  },
);

test.each(["install", "cache root", "snapshot root", "ancestor"])("rejects symlinked %s before reads or writes", async kind => {
  const f = await fixture();
  await (await f.harness.prepare(f.options)).cleanup();
  const path = kind === "install" ? f.cache : kind === "cache root" ? f.options.root
    : kind === "snapshot root" ? f.options.snapshotRoot : f.root;
  const other = `${path}-redirected`;
  if (kind === "ancestor") directories.push(other);
  await rename(path, other);
  await symlink(other, path);
  await expect(f.harness.prepare(f.options)).rejects.toThrow("unsafe debugger directory");
  expect(f.downloads()).toBe(1);
});

test.each([0, 1, 2, 3, 4])("cancellation after private write %i prevents later writes and cleans owned work", async phase => {
  const f = await fixture();
  const controller = new AbortController();
  const writes: string[] = [];
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: f.transport,
    write: async (path, bytes, mode) => {
      await writeFile(path, bytes, { mode, flag: "wx" });
      writes.push(path);
      if (writes.length === phase + 1) controller.abort(new Error("stop after filesystem work"));
    },
  });
  await expect(harness.prepare({ ...f.options, signal: controller.signal })).rejects.toThrow("stop after filesystem work");
  expect(writes.length).toBe(phase + 1);
  expect(await readdir(f.options.root)).toEqual(phase === 4 ? ["1.1.1-linux-x64"] : []);
  if (phase === 4) expect(await readdir(f.options.snapshotRoot)).toEqual([]);
});

test("remeasures the written snapshot before transferring cleanup ownership", async () => {
  const f = await fixture();
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: f.transport,
    write: async (path, bytes, mode) => {
      await writeFile(path, path.startsWith(f.options.snapshotRoot + "/") ? Buffer.alloc(bytes.length) : bytes, { mode, flag: "wx" });
    },
  });
  await expect(harness.prepare(f.options)).rejects.toThrow("snapshot checksum mismatch");
  expect(await readdir(f.options.snapshotRoot)).toEqual([]);
  expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
});

test.each(["bytes", "symlink", "hardlink", "directory", "missing", "released", "writable", "public directory", "directory link"])(
  "revalidation rejects snapshot %s after preparation", async kind => {
    const f = await fixture();
    const prepared = await f.harness.prepare(f.options);
    await debuggerBinary.assertVerifiedDebuggerExecutable(prepared);
    const other = join(f.root, "other");
    if (kind === "bytes") {
      await chmod(prepared.path, 0o700);
      await writeFile(prepared.path, Buffer.alloc(f.binary.length));
      await chmod(prepared.path, 0o500);
    } else if (kind === "hardlink") await link(prepared.path, other);
    else if (kind === "released") await prepared.cleanup();
    else if (kind === "writable") await chmod(prepared.path, 0o700);
    else if (kind === "public directory") await chmod(prepared.directory, 0o755);
    else if (kind === "directory link") { await rename(prepared.directory, other); await symlink(other, prepared.directory); }
    else {
      await rename(prepared.path, other);
      if (kind === "symlink") await symlink(other, prepared.path);
      if (kind === "directory") await mkdir(prepared.path);
    }
    await expect(debuggerBinary.assertVerifiedDebuggerExecutable(prepared)).rejects.toThrow();
    await prepared.cleanup();
    expect(await readFile(join(f.cache, "ckb-debugger"))).toEqual(f.binary);
  },
);

test("path-free evidence validation uses the recorded platform, not the verifier host", () => {
  const evidence = { requestedVersion: PIN.version, version: PIN.version, platform: PIN.platform,
    architecture: PIN.architecture, assetName: PIN.assetName, sourceUrl: PIN.sourceUrl,
    archive: { expected: PIN.archive, observed: PIN.archive }, executable: { expected: PIN.executable, observed: PIN.executable } };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    expect(() => debuggerBinary.assertDebuggerBinaryEvidence(evidence)).not.toThrow();
    for (const key of ["requestedVersion", "version", "platform", "architecture", "assetName", "sourceUrl"]) {
      expect(() => debuggerBinary.assertDebuggerBinaryEvidence({ ...evidence, [key]: "untrusted" })).toThrow();
    }
    for (const component of ["archive", "executable"] as const) {
      for (const identityKey of ["expected", "observed"] as const) {
        for (const invalid of [{ bytes: 1, sha256: PIN[component].sha256 }, { ...PIN[component], sha256: `sha256:${"0".repeat(64)}` }]) {
          expect(() => debuggerBinary.assertDebuggerBinaryEvidence({ ...evidence,
            [component]: { ...evidence[component], [identityKey]: invalid } })).toThrow();
        }
      }
    }
    for (const invalid of [null, [], {}, { ...evidence, path: "/private/path" }]) {
      expect(() => debuggerBinary.assertDebuggerBinaryEvidence(invalid)).toThrow();
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
});

test("fixture identities are small, immutable snapshots and cannot replace production pins", async () => {
  const f = await fixture();
  const identities = { archive: identity(f.archive), executable: identity(f.binary) };
  const harness = debuggerBinary.debuggerBinaryTestOnly(identities, { transport: f.transport });
  identities.archive.bytes++;
  identities.executable.sha256 = `sha256:${"0".repeat(64)}`;
  const prepared = await harness.prepare(f.options);
  await debuggerBinary.assertVerifiedDebuggerExecutable(prepared);
  expect(() => debuggerBinary.assertDebuggerBinaryEvidence(prepared.evidence)).toThrow();
  await prepared.cleanup();
  for (const invalid of [-1, 0, Infinity, NaN, 0.5, 1048577]) {
    expect(() => debuggerBinary.debuggerBinaryTestOnly({ archive: { ...identity(f.archive), bytes: invalid }, executable: identity(f.binary) }, { transport: f.transport })).toThrow("fixture identity");
  }
  expect(() => debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: { bytes: 1, sha256: "sha256:invalid" } }, { transport: f.transport })).toThrow("fixture identity");
  expect(debuggerBinary.resolvePinnedDebuggerAsset("1.1.1", "linux", "x64")).toEqual(PIN);
});

test.each([false, true])("drains unabortable %s snapshot/file work before failure cleanup settles", async snapshot => {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const controller = new AbortController();
  let settled = false;
  let writes = 0;
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: f.transport,
    write: async (path, bytes, mode) => {
      writes++;
      if (writes === (snapshot ? 5 : 1)) { entered.resolve(); await release.promise; }
      await writeFile(path, bytes, { mode, flag: "wx" });
    },
  });
  const pending = harness.prepare({ ...f.options, signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  controller.abort(new Error("drained cancellation"));
  await Bun.sleep(15);
  const returnedTooEarly = settled;
  release.resolve();
  await expect(pending).rejects.toThrow("drained cancellation");
  expect(returnedTooEarly).toBe(false);
  expect(writes).toBe(snapshot ? 5 : 1);
  expect(await readdir(f.options.root)).toEqual(snapshot ? ["1.1.1-linux-x64"] : []);
  if (snapshot) expect(await readdir(f.options.snapshotRoot)).toEqual([]);
  await Bun.sleep(5);
  expect(writes).toBe(snapshot ? 5 : 1);
});

test("warm snapshot uses checked bytes even if the cache changes before its write", async () => {
  const f = await fixture();
  await (await f.harness.prepare(f.options)).cleanup();
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => { throw new Error("no download"); },
    write: async (path, bytes, mode) => {
      await chmod(join(f.cache, "ckb-debugger"), 0o700);
      await writeFile(join(f.cache, "ckb-debugger"), Buffer.alloc(f.binary.length));
      await writeFile(path, bytes, { mode, flag: "wx" });
    },
  });
  const prepared = await harness.prepare(f.options);
  expect(await readFile(prepared.path)).toEqual(f.binary);
  await debuggerBinary.assertVerifiedDebuggerExecutable(prepared);
  await expect(f.harness.prepare(f.options)).rejects.toThrow("executable checksum mismatch");
  await prepared.cleanup();
});

test.each(["empty cache", "file cache", "FIFO archive", "oversized metadata"])("fails closed for %s without fallback", async kind => {
  const f = await fixture();
  if (kind === "empty cache") await mkdir(f.cache, { recursive: true });
  else if (kind === "file cache") { await mkdir(f.options.root); await writeFile(f.cache, "not a directory"); }
  else {
    await (await f.harness.prepare(f.options)).cleanup();
    if (kind === "oversized metadata") await writeFile(join(f.cache, "ckb-verify-provenance.json"), Buffer.alloc(8193));
    else {
      const path = join(f.cache, PIN.assetName);
      await rm(path);
      expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    }
  }
  const downloads = f.downloads();
  await expect(f.harness.prepare(f.options)).rejects.toThrow();
  expect(f.downloads()).toBe(downloads);
  expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
});

test("preparation drains failure cleanup and preserves both primary and cleanup errors", async () => {
  const f = await fixture();
  const release = deferred<void>();
  let cleaning = false;
  let settled = false;
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: f.transport,
    write: async (path, bytes, mode) => {
      await writeFile(path, bytes, { mode, flag: "wx" });
      throw new Error("primary write failure");
    },
    remove: async path => {
      cleaning = true;
      await release.promise;
      await rm(path, { recursive: true, force: true });
      throw new Error("cleanup failure");
    },
  });
  const result = harness.prepare(f.options).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  await Bun.sleep(25);
  const prematurelySettled = settled;
  release.resolve();
  const error = await result;
  expect(cleaning).toBe(true);
  expect(prematurelySettled).toBe(false);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map(String)).toEqual(["Error: primary write failure", "Error: cleanup failure"]);
  expect(await readdir(f.options.root)).toEqual([]);
});

test.each([
  ["both failures", true, new Error("primary descriptor read failure"), true],
  ["undefined primary plus close failure", true, undefined, true],
  ["primary-only failure", true, new Error("primary descriptor read failure"), false],
  ["undefined primary-only failure", true, undefined, false],
  ["close-only failure", false, undefined, true],
  ["successful bytes", false, undefined, false],
] as const)("descriptor close is drained and preserves %s", async (_case, failRead, primary, failClose) => {
  const f = await fixture();
  await (await f.harness.prepare(f.options)).cleanup();
  const target = join(f.cache, PIN.assetName);
  const cleanup = new Error("descriptor cleanup failure");
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalOpen = fs.open;
  const handleMocks: Array<{ mockRestore(): void }> = [];
  let opened: fs.FileHandle | undefined;
  let realClose: (() => Promise<void>) | undefined;
  let closePending: Promise<void> | undefined;
  let reads = 0;
  let closes = 0;
  let closed = false;
  let settled = false;
  const mockedOpen = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) {
      opened = handle;
      const close = handle.close.bind(handle);
      realClose = close;
      if (failRead) handleMocks.push(spyOn(handle, "read").mockImplementation(async () => { reads++; throw primary; }));
      handleMocks.push(spyOn(handle, "close").mockImplementation(() => {
        closes++;
        closePending = (async () => {
          entered.resolve();
          await release.promise;
          await close();
          closed = true;
          if (failClose) throw cleanup;
        })();
        return closePending;
      }));
    }
    return handle;
  });
  const result = f.harness.prepare(f.options).then(value => {
    settled = true; return { ok: true as const, value };
  }, (error: unknown) => {
    settled = true; return { ok: false as const, error };
  });
  try {
    await Promise.race([entered.promise, result.then(() => { throw new Error("preparation settled before descriptor close"); })]);
    await Bun.sleep(10);
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    release.resolve();
    const outcome = await result;
    expect(closed).toBe(true);
    expect(opened?.fd).toBe(-1);
    expect(closes).toBe(1);
    expect(reads).toBe(failRead ? 1 : 0);
    expect(f.downloads()).toBe(1);
    if (outcome.ok) {
      expect(failRead || failClose).toBe(false);
      expect(await readFile(outcome.value.path)).toEqual(f.binary);
    } else if (failRead && failClose) {
      expect(outcome.error).toBeInstanceOf(AggregateError);
      const errors = (outcome.error as AggregateError).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBe(primary);
      expect(errors[1]).toBe(cleanup);
    } else {
      expect(failRead || failClose).toBe(true);
      expect(outcome.error).toBe(failRead ? primary : cleanup);
    }
  } finally {
    release.resolve();
    try {
      const outcome = await result;
      if (outcome.ok) await outcome.value.cleanup();
    } finally {
      try {
        await closePending?.catch(() => {});
        if (opened && opened.fd !== -1) await realClose!();
      } finally {
        for (const mock of handleMocks) mock.mockRestore();
        mockedOpen.mockRestore();
      }
    }
  }
});

test("snapshot cleanup coalesces and never reclaims a path after ownership ended", async () => {
  const f = await fixture();
  const release = deferred<void>();
  let removals = 0;
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: f.transport,
    remove: async path => { removals++; await release.promise; await rm(path, { recursive: true, force: true }); },
  });
  const prepared = await harness.prepare(f.options);
  const first = prepared.cleanup();
  const second = prepared.cleanup();
  release.resolve();
  await Promise.all([first, second]);
  expect(first).toBe(second);
  expect(removals).toBe(1);
  await expect(debuggerBinary.assertVerifiedDebuggerExecutable(prepared)).rejects.toThrow("released");
  await mkdir(prepared.directory);
  await writeFile(join(prepared.directory, "new-owner"), "preserved");
  await prepared.cleanup();
  expect(await readFile(join(prepared.directory, "new-owner"), "utf8")).toBe("preserved");
  expect(removals).toBe(1);
});

test("never replaces an incomplete cache that appeared while downloading", async () => {
  const f = await fixture();
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => { await mkdir(f.cache, { recursive: true }); return new Response(f.archive); },
  });
  await expect(harness.prepare(f.options)).rejects.toThrow();
  expect(await readdir(f.cache)).toEqual([]);
  expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
});

test("production preparation cannot substitute fixture pins through input options", async () => {
  const f = await fixture();
  let calls = 0;
  const fakeFetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(String(url)).toBe(PIN.sourceUrl);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(f.archive);
  }, { preconnect: () => {} });
  const transport = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  try {
    const options = { ...f.options, resolveAsset: () => ({ ...PIN, archive: identity(f.archive), executable: identity(f.binary) }) };
    await expect(debuggerBinary.preparePinnedDebuggerBinary({ ...options, version: "latest" })).rejects.toThrow("no pinned debugger artifact");
    expect(calls).toBe(0);
    await expect(debuggerBinary.preparePinnedDebuggerBinary(options)).rejects.toThrow("archive size mismatch");
    expect(calls).toBe(1);
    expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
    expect(Object.isFrozen(debuggerBinary.resolvePinnedDebuggerAsset("1.1.1", "linux", "x64").archive)).toBe(true);
  } finally { transport.mockRestore(); }
});

test("failed cleanup stays invalid, permits a bounded retry, and rejects fabricated capabilities", async () => {
  const f = await fixture();
  let calls = 0;
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: f.transport,
    remove: async path => {
      if (++calls === 1) throw new Error("transient removal failure");
      await rm(path, { recursive: true, force: true });
    },
  });
  const prepared = await harness.prepare(f.options);
  await expect(debuggerBinary.assertVerifiedDebuggerExecutable({ ...prepared })).rejects.toThrow("invalid");
  const aborted = AbortSignal.abort(new Error("stop validation"));
  await expect(debuggerBinary.assertVerifiedDebuggerExecutable(prepared, aborted)).rejects.toThrow("stop validation");
  await expect(prepared.cleanup()).rejects.toThrow("transient removal failure");
  await expect(debuggerBinary.assertVerifiedDebuggerExecutable(prepared)).rejects.toThrow("released");
  await prepared.cleanup();
  expect(calls).toBe(2);
  expect(await readdir(f.options.snapshotRoot)).toEqual([]);
});

test("captures ownership paths before asynchronous work can mutate caller options", async () => {
  const f = await fixture();
  const options = { ...f.options };
  const harness = debuggerBinary.debuggerBinaryTestOnly({ archive: identity(f.archive), executable: identity(f.binary) }, {
    transport: async () => {
      options.root = join(f.root, "mutated-cache");
      options.snapshotRoot = join(f.root, "mutated-snapshots");
      return new Response(f.archive);
    },
  });
  const prepared = await harness.prepare(options);
  expect(prepared.directory.startsWith(f.options.snapshotRoot + "/")).toBe(true);
  expect(await readdir(f.root)).not.toContain("mutated-cache");
  expect(await readdir(f.root)).not.toContain("mutated-snapshots");
  await prepared.cleanup();
});

const PIN = {
  version: "1.1.1",
  platform: "linux",
  architecture: "x64",
  assetName: "ckb-debugger_v1.1.1_x86_64-unknown-linux-gnu.tar.gz",
  sourceUrl: "https://github.com/nervosnetwork/ckb-standalone-debugger/releases/download/v1.1.1/ckb-debugger_v1.1.1_x86_64-unknown-linux-gnu.tar.gz",
  archive: { bytes: 2523369, sha256: "sha256:0dee02804af46386527c8bb94c2ee63592594ca1ec952ea42ffa9df07a9f005e" },
  executable: { bytes: 7582264, sha256: "sha256:24641357274ca464ecd86fd63b715ad96b5490d27b5ca029df37511e435d96f0" },
} as const;

test("selects only the exact source-pinned debugger artifact", () => {
  expect(debuggerBinary.resolvePinnedDebuggerAsset("1.1.1", "linux", "x64")).toEqual(PIN);
});

test.each([
  ["latest", "linux", "x64"], ["1.1.0", "linux", "x64"], ["v1.1.1", "linux", "x64"],
  ["1.1.1", "darwin", "x64"], ["1.1.1", "win32", "x64"], ["1.1.1", "linux", "arm64"],
] as const)("rejects unsupported selection %s/%s/%s", (version, platform, arch) => {
  expect(() => debuggerBinary.resolvePinnedDebuggerAsset(version, platform, arch))
    .toThrow("no pinned debugger artifact");
});

test("cold preparation retains the archive and returns a measured private snapshot without execution", async () => {
  const f = await fixture();
  const prepared = await f.harness.prepare(f.options);
  expect(await readFile(prepared.path)).toEqual(f.binary);
  expect(dirname(prepared.path)).toBe(prepared.directory);
  expect(prepared.directory.startsWith(`${f.options.snapshotRoot}/`)).toBe(true);
  expect((await lstat(prepared.directory)).mode & 0o777).toBe(0o700);
  const snapshot = await lstat(prepared.path);
  const cached = await lstat(join(f.cache, "ckb-debugger"));
  expect(snapshot.ino).not.toBe(cached.ino);
  expect(snapshot.nlink).toBe(1);
  expect(snapshot.mode & 0o777).toBe(0o500);
  expect(await readFile(join(f.cache, PIN.assetName))).toEqual(f.archive);
  expect(prepared.evidence).toEqual({
    requestedVersion: "1.1.1", version: "1.1.1", platform: "linux", architecture: "x64",
    assetName: PIN.assetName, sourceUrl: PIN.sourceUrl,
    archive: { expected: identity(f.archive), observed: identity(f.archive) },
    executable: { expected: identity(f.binary), observed: identity(f.binary) },
  });
  expect(JSON.stringify(prepared.evidence)).not.toContain(f.root);
  expect(f.downloads()).toBe(1);
  expect(await readdir(f.options.root)).toEqual(["1.1.1-linux-x64"]);
  await prepared.cleanup();
  await prepared.cleanup();
  expect(await readdir(f.options.snapshotRoot)).toEqual([]);
  expect(await readFile(join(f.cache, "ckb-debugger"))).toEqual(f.binary);
});

test("preparation rejects unsupported identity before transport or filesystem work", async () => {
  const f = await fixture();
  for (const selection of [{ version: "latest" }, { platform: "darwin" as const }, { arch: "arm64" }]) {
    await expect(f.harness.prepare({ ...f.options, ...selection })).rejects.toThrow("no pinned debugger artifact");
  }
  expect(f.downloads()).toBe(0);
  expect((await readdir(f.root)).sort()).toEqual(["fixture.tar.gz", "source"]);
});
