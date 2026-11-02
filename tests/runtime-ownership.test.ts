import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import * as ownership from "../src/runtime-ownership";
import { OffckbDevnet } from "../src/offckb";

const directories: string[] = [];
const moduleUrl = new URL("../src/runtime-ownership.ts", import.meta.url).href;

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ckb-verify-ownership-"));
  directories.push(path);
  return path;
}

function owner(cwd: string) {
  return Bun.spawn([process.execPath, "-e", `
    import { acquireRuntimeOwnership } from ${JSON.stringify(moduleUrl)};
    const lease = await acquireRuntimeOwnership();
    await Bun.write("ready", "owned");
    await Bun.stdin.text();
    await lease.release();
  `], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

async function ready(child: ReturnType<typeof owner>, cwd: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await Bun.file(join(cwd, "ready")).exists()) && child.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
  expect(await Bun.file(join(cwd, "ready")).exists()).toBe(true);
}

async function contender(cwd: string) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { acquireRuntimeOwnership } from ${JSON.stringify(moduleUrl)};
    try {
      const lease = await acquireRuntimeOwnership();
      console.log("owned");
      await lease.release();
    } catch (error) { console.error(error.message); process.exitCode = 2; }
  `], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a losing adapter cannot run commands, install, or delete the owner's account file", async () => {
  const first = await directory();
  const sibling = await directory();
  const child = owner(first);
  try {
    await ready(child, first);
    for (const repositoryRoot of [first, sibling]) {
      const calls: string[] = [];
      const devnet = new OffckbDevnet({
        repositoryRoot, ckbVersion: "0.209.0", accountCount: 2,
        run: async () => {
          calls.push("command");
          return { stdout: "0.4.13\n", stderr: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
        },
        installCkbBinary: async () => { calls.push("install"); throw new Error("must not install"); },
      });
      await Bun.write(devnet.paths.accountsPath, "owner's accounts");
      await expect(devnet.start()).rejects.toThrow("runtime busy");
      await devnet.stop();
      expect(calls).toEqual([]);
      expect(await Bun.file(devnet.paths.accountsPath).text()).toBe("owner's accounts");
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

async function canListen(host: string): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: 0, host, ipv6Only: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const hasIpv6 = await canListen("::1");

test("port preflight passes on hosts without IPv6", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  const freePort = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await expect(ownership.assertRuntimePortsAvailable([freePort])).resolves.toBeUndefined();
});

test.each(["127.0.0.1", ...(hasIpv6 ? ["::1"] : [])])("port preflight refuses either foreign listener on %s without disturbing it", async (host) => {
  const server = createServer((socket) => socket.end("foreign listener\n"));
  await new Promise<void>((resolve) => server.listen({ port: 0, host, ipv6Only: true }, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  try {
    for (const ports of [[0, address.port], [address.port, 0]]) {
      await expect(ownership.assertRuntimePortsAvailable(ports)).rejects.toThrow(`port ${address.port}`);
      expect(server.listening).toBe(true);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("adapter preflight failure leaves runtime files untouched and releases ownership", async () => {
  const repositoryRoot = await directory();
  const calls: string[] = [];
  const devnet = new OffckbDevnet({
    repositoryRoot, ckbVersion: "0.209.0", accountCount: 2,
    preflight: async () => { calls.push("preflight"); throw new Error("foreign listener"); },
    run: async () => {
      calls.push("command");
      return { stdout: "0.4.13\n", stderr: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1 };
    },
    installCkbBinary: async () => { calls.push("install"); throw new Error("must not install"); },
  });
  await Bun.write(devnet.paths.accountsPath, "existing accounts");
  await expect(devnet.start()).rejects.toThrow("foreign listener");
  await devnet.stop();
  expect(calls).toEqual(["preflight"]);
  expect(await Bun.file(devnet.paths.accountsPath).text()).toBe("existing accounts");
  expect(await contender(repositoryRoot)).toMatchObject({ code: 0 });
});

test("the platform gate admits only Linux x64 under Bun", () => {
  expect(() => ownership.assertSupportedRuntimePlatform("linux", "x64", true)).not.toThrow();
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "arm64"]] as const) {
    expect(() => ownership.assertSupportedRuntimePlatform(platform, arch, true)).toThrow(`${platform}/${arch} is not supported`);
  }
  expect(() => ownership.assertSupportedRuntimePlatform("linux", "x64", false)).toThrow("linux/x64 without Bun");
});

test.each([['platform', 'darwin'], ['arch', 'arm64']] as const)(
  "ownership rejects unsupported %s=%s before binding", async (field, value) => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { acquireRuntimeOwnership } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process, ${JSON.stringify(field)}, { value: ${JSON.stringify(value)} });
      try { const lease = await acquireRuntimeOwnership(); await lease.release(); }
      catch (error) { console.error(error.message); process.exitCode = 2; }
    `], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(2);
    expect(stderr).toContain("Linux x64 with Bun");
  },
);

test("kernel reclaims a crashed owner without stale metadata or signaling other processes", async () => {
  const first = await directory();
  const sibling = await directory();
  const child = owner(first);
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "pipe" });
  try {
    await ready(child, first);
    child.kill("SIGKILL");
    await child.exited;
    expect(await contender(sibling)).toMatchObject({ code: 0, stdout: "owned\n" });
    expect(unrelated.exitCode).toBeNull();
    expect(await contender(first)).toMatchObject({ code: 0, stdout: "owned\n" });
  } finally {
    child.kill("SIGKILL");
    unrelated.kill("SIGKILL");
    await Promise.all([child.exited, unrelated.exited]);
  }
});

test("one kernel owner excludes processes in both the same and sibling checkout", async () => {
  const first = await directory();
  const sibling = await directory();
  const child = owner(first);
  try {
    await ready(child, first);
    for (const cwd of [first, sibling]) {
      const result = await contender(cwd);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("runtime busy");
      expect(result.stderr).toContain("8114/28114");
      expect(result.stderr).toContain("retry");
    }
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await contender(sibling)).toMatchObject({ code: 0, stdout: "owned\n" });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});
