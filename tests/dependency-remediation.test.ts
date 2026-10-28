import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(new URL("../node_modules/@offckb/cli/build/index.js", import.meta.url));
const requireFromBundle = createRequire(bundlePath);

// Evaluate only the active redirect-library import and its module, never OffCKB's
// CLI entrypoint (which could start a devnet or change the user's OffCKB state).
function loadActiveRedirectLibrary(): {
  http: { get: typeof import("node:http").get };
} {
  const bundle = readFileSync(bundlePath, "utf8");
  const imports = [...bundle.matchAll(/followRedirects = ([^;\n]+);/g)];
  expect(imports).toHaveLength(1);
  const builtins: Record<number, string> = {
    87016: "node:url", 58611: "node:http", 65692: "node:https",
    2203: "node:stream", 42613: "node:assert", 73462: "debug",
  };
  function loadModule(id: number): unknown {
    const builtin = builtins[id];
    if (builtin !== undefined) return requireFromBundle(builtin);
    if (id !== 230 && id !== 77969) throw new Error(`unexpected redirect dependency ${id}`);
    const sections = bundle.split(`/***/ ${id}:\n`);
    expect(sections).toHaveLength(2);
    const factory = sections[1]!.split("\n\n/***/ }),")[0]!;
    const body = factory.slice(factory.indexOf("\n\n") + 2);
    const module = { exports: {} };
    new Function("module", "__nccwpck_require__", body)(module, loadModule);
    return module.exports;
  }
  return new Function("require", "__nccwpck_require__", `return ${imports[0]![1]};`)(
    requireFromBundle, loadModule,
  );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected loopback TCP server");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

test.each(["object", "array"])("OffCKB's active redirect import strips cross-origin %s credential headers", async form => {
  const redirects = loadActiveRedirectLibrary();
  const target = createServer((req, res) => { req.resume(); res.end(JSON.stringify(req.headers)); });
  const targetPort = await listen(target);
  const origin = createServer((req, res) => {
    req.resume();
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/target` });
    res.end();
  });
  try {
    const originPort = await listen(origin);
    const headers = {
      Authorization: "synthetic-auth", Cookie: "synthetic-cookie", "Proxy-Authorization": "synthetic-proxy",
      "X-Api^Key": "synthetic-caret", "X-Token|Secret": "synthetic-pipe", "X-Keep": "kept",
    };
    const received = await new Promise<IncomingHttpHeaders>((resolve, reject) => {
      const request = redirects.http.get({
        hostname: "127.0.0.1", port: originPort, path: "/", agent: false,
        headers: form === "array" ? Object.entries(headers).flat() : headers,
        // This dependency extends node:http RequestOptions.
        ...{ sensitiveHeaders: ["X-Api^Key", "X-Token|Secret"] },
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve(JSON.parse(body) as IncomingHttpHeaders); } catch (error) { reject(error); }
        });
      });
      request.on("error", reject);
      request.setTimeout(2000, () => request.destroy(new Error("redirect test timed out")));
    });
    expect(received["x-keep"]).toBe("kept");
    expect(received.host).toBe(`127.0.0.1:${targetPort}`);
    for (const name of Object.keys(headers).filter(name => name !== "X-Keep")) {
      expect(received[name.toLowerCase()], `${form} leaked ${name}`).toBeUndefined();
    }
  } finally {
    await Promise.all([close(origin), close(target)]);
  }
});

test("Ajv's resolved URI parser does not turn an encoded scheme into a live javascript URL", () => {
  const requireFromAjv = createRequire(requireFromBundle.resolve("ajv"));
  const uri = requireFromAjv("fast-uri") as { normalize: (input: string) => string };
  expect(uri.normalize("%6Aavascript:alert(1)")).not.toBe("javascript:alert(1)");
});
