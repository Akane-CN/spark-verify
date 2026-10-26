import { createServer } from "node:net";

// Linux abstract sockets live in the network namespace, not a checkout, HOME,
// UID or temp directory. Never version this name while these ports are shared.
const RUNTIME_NAMESPACE = "\0ckb-verify-offckb-8114-28114";

export interface RuntimeOwnership {
  release(): Promise<void>;
}

export async function assertRuntimePortsAvailable(ports: readonly number[] = [8114, 28114]): Promise<void> {
  for (const port of ports) {
    for (const host of ["0.0.0.0", "::"]) {
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port, exclusive: true, ipv6Only: true }, resolve);
        });
      } catch (error) {
        throw new Error(`OffCKB runtime busy: cannot reserve port ${port} on ${host}; inspect the existing listener and stop it yourself only if it is yours, then retry. No process was stopped.`, { cause: error });
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
}

export async function acquireRuntimeOwnership(): Promise<RuntimeOwnership> {
  if (process.platform !== "linux" || process.arch !== "x64" || typeof Bun === "undefined") {
    throw new Error("OffCKB runtime ownership requires Linux x64 with Bun; other runtimes/platforms are not supported.");
  }
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
