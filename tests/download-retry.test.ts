// Bounded retries of the two pinned release downloads: which failures are retried, how often, and that a
// retried download still goes through the same length and checksum checks.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { sha256Bytes } from "../src/canonical";
import { createCkbArchiveDownloader, type PinnedCkbAsset } from "../src/ckb-binary";
import * as debuggerBinary from "../src/debugger-binary";
import { DOWNLOAD_RETRY_DELAYS_MS, abortableSleep, isTransient, markTransient, retryTransient, retryableHttpStatus } from "../src/download-retry";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const bytes = new TextEncoder().encode("pinned archive bytes");
const asset: PinnedCkbAsset = {
  version: "0.209.0", assetName: "fixture.tar.gz", packageName: "fixture",
  archiveSha256: sha256Bytes(bytes) as `sha256:${string}`, archiveBytes: bytes.byteLength, format: "tar.gz",
};

/** A fetch stand-in that answers each call with the next scripted response or thrown error; the last entry
 * repeats. Entries are factories because a Response body can be read only once. */
function scripted(responses: Array<() => Response | Error>) {
  const waits: number[] = [];
  let calls = 0;
  const request = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!();
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const sleep = async (milliseconds: number) => { waits.push(milliseconds); };
  return { request, sleep, waits, calls: () => calls };
}

describe("retry policy", () => {
  test("only 408, 429, and 5xx are retryable statuses", () => {
    expect([408, 429, 500, 502, 503, 504, 599].every(retryableHttpStatus)).toBe(true);
    expect([200, 301, 400, 401, 403, 404, 410, 499, 600].some(retryableHttpStatus)).toBe(false);
    expect(DOWNLOAD_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 10_000]);
  });

  test("an unmarked failure is final on the first attempt", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    await expect(retryTransient(async () => { attempts += 1; throw new Error("checksum mismatch"); },
      { delaysMs: [1, 1], sleep: async (ms) => { sleeps.push(ms); } })).rejects.toThrow("checksum mismatch");
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a transient failure is retried once per delay, then reported with the attempt count", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const failure = retryTransient(async () => { attempts += 1; throw markTransient(new Error("HTTP 504")); },
      { delaysMs: [3, 7], sleep: async (ms) => { sleeps.push(ms); } });
    await expect(failure).rejects.toThrow("HTTP 504 (after 3 attempts)");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([3, 7]);
  });

  test("with no delays the original error is rethrown unchanged", async () => {
    const original = markTransient(new Error("HTTP 503"));
    expect(isTransient(original)).toBe(true);
    expect(await retryTransient(async () => { throw original; }, { delaysMs: [] }).catch((error) => error)).toBe(original);
  });

  test("a caller's cancellation stops the wait and the retries", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = retryTransient(async () => { attempts += 1; throw markTransient(new Error("HTTP 502")); },
      { delaysMs: [60_000], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));   // the first attempt has failed; the wait is running
    controller.abort(new Error("cancelled by the caller"));
    await expect(pending).rejects.toThrow("cancelled by the caller");
    expect(attempts).toBe(1);
    await expect(abortableSleep(60_000, controller.signal)).rejects.toThrow("cancelled by the caller");
  });
});

describe("CKB archive download", () => {
  test("recovers from HTTP 504 and a network error, and returns the bytes of the successful attempt", async () => {
    const f = scripted([() => new Response("gateway timeout", { status: 504 }), () => new TypeError("fetch failed"), () => new Response(bytes)]);
    const download = createCkbArchiveDownloader({ fetch: f.request, sleep: f.sleep });
    expect(Buffer.from(await download("https://example.invalid/a", asset)).equals(Buffer.from(bytes))).toBe(true);
    expect(f.calls()).toBe(3);
    expect(f.waits).toEqual([2_000, 5_000]);
  });

  test("over real HTTP: two 504 responses, then the archive", async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      requests += 1;
      return requests <= 2 ? new Response("gateway timeout", { status: 504 }) : new Response(bytes);
    } });
    try {
      const waits: number[] = [];
      const download = createCkbArchiveDownloader({ sleep: async (milliseconds) => { waits.push(milliseconds); } });
      const received = await download(`http://127.0.0.1:${server.port}/fixture.tar.gz`, asset);
      expect(Buffer.from(received).equals(Buffer.from(bytes))).toBe(true);
      expect(requests).toBe(3);
      expect(waits).toEqual([2_000, 5_000]);
    } finally { server.stop(true); }
  });

  test("gives up after four attempts and says so", async () => {
    const f = scripted([() => new Response("", { status: 504 })]);
    const download = createCkbArchiveDownloader({ fetch: f.request, sleep: f.sleep });
    await expect(download("https://example.invalid/a", asset)).rejects.toThrow("CKB archive download failed with HTTP 504 (after 4 attempts)");
    expect(f.calls()).toBe(4);
    expect(f.waits).toEqual([2_000, 5_000, 10_000]);
  });

  test.each([404, 403])("does not retry HTTP %d", async (status) => {
    const f = scripted([() => new Response("", { status })]);
    const download = createCkbArchiveDownloader({ fetch: f.request, sleep: f.sleep });
    await expect(download("https://example.invalid/a", asset)).rejects.toThrow(`CKB archive download failed with HTTP ${status}`);
    expect(f.calls()).toBe(1);
  });

  test("does not retry a length mismatch or an oversized body", async () => {
    const wrongLength = scripted([() => new Response(bytes, { headers: { "content-length": "1" } })]);
    await expect(createCkbArchiveDownloader({ fetch: wrongLength.request, sleep: wrongLength.sleep })("https://example.invalid/a", asset))
      .rejects.toThrow("Content-Length mismatch");
    expect(wrongLength.calls()).toBe(1);
    const oversized = scripted([() => new Response(new Uint8Array(bytes.byteLength + 1))]);
    await expect(createCkbArchiveDownloader({ fetch: oversized.request, sleep: oversized.sleep })("https://example.invalid/a", asset))
      .rejects.toThrow("exceeded pinned byte length");
    expect(oversized.calls()).toBe(1);
  });

  test("does not retry its own time limit", async () => {
    let calls = 0;
    const hanging = ((_url: string, init: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(init.signal!.reason)); });
    }) as unknown as typeof fetch;
    const download = createCkbArchiveDownloader({ fetch: hanging, timeoutMs: 10, sleep: async () => {} });
    await expect(download("https://example.invalid/a", asset)).rejects.toThrow("CKB archive download timed out");
    expect(calls).toBe(1);
  });
});

describe("debugger archive download", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "debugger-retry-"));
    directories.push(root);
    const binary = Buffer.from("fixture bytes, deliberately not an executable\n");
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "ckb-debugger"), binary);
    await writeFile(join(source, "LICENSE"), "fixture license\n");
    const archivePath = join(root, "fixture.tar.gz");
    await tar.c({ cwd: source, file: archivePath, gzip: true, portable: true }, ["ckb-debugger", "LICENSE"]);
    const archive = await readFile(archivePath);
    const identity = (value: Uint8Array) => ({ bytes: value.byteLength, sha256: sha256Bytes(value) as `sha256:${string}` });
    const options = { version: "1.1.1", platform: "linux" as const, arch: "x64", root: join(root, "cache"), snapshotRoot: join(root, "runs") };
    const harness = (responses: Array<() => Response | Error>, retryDelaysMs?: readonly number[]) => {
      const f = scripted(responses);
      return { ...f, prepare: () => debuggerBinary.debuggerBinaryTestOnly({ archive: identity(archive), executable: identity(binary) }, {
        transport: f.request as unknown as (url: string, init: RequestInit) => Promise<Response>, sleep: f.sleep,
        ...(retryDelaysMs === undefined ? {} : { retryDelaysMs }),
      }).prepare(options) };
    };
    return { archive, harness };
  }

  test("recovers from HTTP 504 and a network error, then installs the verified archive", async () => {
    const f = await fixture();
    const h = f.harness([() => new Response("", { status: 504 }), () => new TypeError("fetch failed"), () => new Response(f.archive)], [4, 9]);
    const prepared = await h.prepare();
    expect(h.calls()).toBe(3);
    expect(h.waits).toEqual([4, 9]);
    await prepared.cleanup();
  });

  test("gives up after the configured attempts and says so", async () => {
    const f = await fixture();
    const h = f.harness([() => new Response("", { status: 503 })], [1, 1, 1]);
    await expect(h.prepare()).rejects.toThrow("debugger archive HTTP 503 (after 4 attempts)");
    expect(h.calls()).toBe(4);
  });

  test("does not retry HTTP 404 or a corrupted archive", async () => {
    const f = await fixture();
    const missing = f.harness([() => new Response("", { status: 404 })], [1, 1]);
    await expect(missing.prepare()).rejects.toThrow("debugger archive HTTP 404");
    expect(missing.calls()).toBe(1);
    const damaged = Buffer.from(f.archive); damaged[damaged.length - 1]! ^= 1;
    const corrupted = f.harness([() => new Response(damaged)], [1, 1]);
    await expect(corrupted.prepare()).rejects.toThrow("checksum mismatch");
    expect(corrupted.calls()).toBe(1);
  });

  test("the fixture seam makes a single attempt unless delays are given", async () => {
    const f = await fixture();
    const h = f.harness([() => new Response("", { status: 503 })]);
    await expect(h.prepare()).rejects.toThrow("debugger archive HTTP 503");
    expect(h.calls()).toBe(1);
  });
});
