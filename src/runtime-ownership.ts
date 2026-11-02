import { createServer } from "node:net";

// Linux abstract sockets live in the network namespace, not a checkout, HOME,
// UID or temp directory. Never version this name while these ports are shared.
const RUNTIME_NAMESPACE = "\0ckb-verify-offckb-8114-28114";

export interface RuntimeOwnership {
  release(): Promise<void>;
}

async function probeListen(host: string, port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true, ipv6Only: true }, resolve);
    });
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Bun reports an unavailable address family without an errno code, so a failed
// "::" probe is attributed to a listener only when IPv6 can bind at all.
async function ipv6Available(): Promise<boolean> {
  try {
    await probeListen("::", 0);
    return true;
  } catch {
    return false;
  }
}

export async function assertRuntimePortsAvailable(ports: readonly number[] = [8114, 28114]): Promise<void> {
  let ipv6: boolean | undefined;
  for (const port of ports) {
    for (const host of ["0.0.0.0", "::"]) {
      try {
        await probeListen(host, port);
      } catch (error) {
        if (host === "::" && (error as NodeJS.ErrnoException).code !== "EADDRINUSE" && !(ipv6 ??= await ipv6Available())) continue;
        throw new Error(`OffCKB runtime busy: cannot reserve port ${port} on ${host}; inspect the existing listener and stop it yourself only if it is yours, then retry. No process was stopped.`, { cause: error });
      }
    }
  }
}

/**
 * The only platform `run` supports. Called by the runner before it writes anything (run directory,
 * manifest copy, caches) and again when taking runtime ownership, so other platforms are refused
 * with no file or runtime mutation.
 */
export function assertSupportedRuntimePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  bun: boolean = typeof Bun !== "undefined",
): void {
  if (platform !== "linux" || arch !== "x64" || !bun) {
    throw new Error(`OffCKB runtime ownership requires Linux x64 with Bun; ${platform}/${arch}${bun ? "" : " without Bun"} is not supported.`);
  }
}

export async function acquireRuntimeOwnership(): Promise<RuntimeOwnership> {
  assertSupportedRuntimePlatform();
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new Error("OffCKB runtime busy (8114/28114): another ckb-verify owns this network namespace; wait for it to finish and retry. No runtime files were changed.")
        : error);
    });
    server.listen(RUNTIME_NAMESPACE, resolve);
  });
  server.unref();
  let released: Promise<void> | undefined;
  return {
    release() {
      released ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      return released;
    },
  };
}
