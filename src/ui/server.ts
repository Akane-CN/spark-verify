// `ckb-verify ui`: a local, interactive console over the same runner and verifier the CLI uses. It lists the
// project's manifests and runs, validates a manifest, starts a run and shows its stages live, draws a report
// (transactions as input/output Cells, claims as expected vs observed), verifies any pasted report offline,
// and compares two runs. It binds 127.0.0.1 only, answers only to its own Host names, and requires a
// per-server token on every API call, so another web page cannot drive it.
import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { inspectReport, validateManifestFile } from "../offline";
import { runFailureStage, runManifest as defaultRunManifest, type RunManifestOptions, type RunManifestResult } from "../runner";
import { VERSION } from "../version";
import { renderPage } from "./page";
import { buildReportView, compareReports } from "./view-model";

export interface UiOptions {
  projectRoot: string;
  port?: number;
  /** Extra Host header names to accept (for a trusted reverse proxy); 127.0.0.1 and localhost always work.
   * `"*"` accepts any Host and so gives up the DNS-rebinding check: only for a proxy you control. */
  allowHosts?: readonly string[];
  /** Injected in tests; defaults to the real runner. */
  runManifest?: (options: RunManifestOptions) => Promise<RunManifestResult>;
}

export interface UiServer { url: string; port: number; token: string; stop(): Promise<void> }

interface Job {
  id: number; manifest: string; startedAt: string; state: "running" | "done" | "error" | "cancelled";
  stages: Array<{ stage: string; at: string }>;
  result?: { verdict: string; run: string; digests: { outcome: string; environment: string } };
  error?: string; errorStage?: string;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const IGNORED = ["node_modules/", ".ckb-verify/", ".git/", "dist/", "coverage/"];
const MAX_BODY = 32 * 1024 * 1024;
const MAX_LOG = 64 * 1024;

async function readCapped(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}\n… (${text.length - MAX_LOG} more characters in ${basename(path)})` : text;
  } catch { return null; }
}

export async function startUi(options: UiOptions): Promise<UiServer> {
  const root = await realpath(resolve(options.projectRoot));
  const runsDir = join(root, ".ckb-verify", "runs");
  const token = randomBytes(24).toString("hex");
  const run = options.runManifest ?? defaultRunManifest;
  let job: Job | undefined;
  let controller: AbortController | undefined;
  let nextJob = 1;

  async function manifests(): Promise<string[]> {
    const found = new Set<string>();
    for (const pattern of ["verify*.toml", "**/verify*.toml"]) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, followSymlinks: false, dot: false })) {
        const rel = path.split(sep).join("/");
        if (!IGNORED.some((prefix) => rel.startsWith(prefix) || rel.includes(`/${prefix}`))) found.add(rel);
        if (found.size >= 300) break;
      }
    }
    return [...found].sort((a, b) => (a === "verify.toml" ? -1 : b === "verify.toml" ? 1 : a.localeCompare(b)));
  }

  /** Only a manifest the project actually contains, resolved inside the project. */
  async function manifestPath(rel: unknown): Promise<string> {
    if (typeof rel !== "string" || !(await manifests()).includes(rel)) throw new HttpError(404, "unknown manifest");
    const absolute = await realpath(join(root, rel));
    if (!absolute.startsWith(`${root}${sep}`)) throw new HttpError(404, "unknown manifest");
    return absolute;
  }

  async function runDir(id: unknown): Promise<string> {
    if (typeof id !== "string" || !RUN_ID.test(id)) throw new HttpError(404, "unknown run");
    const dir = join(runsDir, id);
    const info = await lstat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) throw new HttpError(404, "unknown run");
    return dir;
  }

  async function readReport(id: unknown): Promise<unknown> {
    const dir = await runDir(id);
    const text = await readFile(join(dir, "report.json"), "utf8").catch(() => null);
    if (text === null) throw new HttpError(404, "this run has no report (it ended without a verdict)");
    try { return JSON.parse(text); } catch { throw new HttpError(422, "report.json is not valid JSON"); }
  }

  async function runs(): Promise<unknown[]> {
    const names = (await readdir(runsDir).catch(() => [] as string[])).filter((name) => RUN_ID.test(name)).sort().reverse().slice(0, 150);
    const entries: unknown[] = [];
    for (const name of names) {
      const text = await readFile(join(runsDir, name, "report.json"), "utf8").catch(() => null);
      if (text === null) { entries.push({ id: name, hasReport: false }); continue; }
      try {
        const report = JSON.parse(text) as Record<string, any>;
        entries.push({ id: name, hasReport: true, schema: report.schema, verdict: report.verdict, createdAt: report.createdAt,
          name: report.evidence?.name ?? report.outcomeClaims?.name, spec: report.evidence?.spec ?? report.outcomeClaims?.spec });
      } catch { entries.push({ id: name, hasReport: true, unreadable: true }); }
    }
    return entries;
  }

  async function startJob(rel: unknown, allowVersionDrift: boolean): Promise<Job> {
    if (job?.state === "running") throw new HttpError(409, "a run is already in progress");
    const absolute = await manifestPath(rel);
    controller = new AbortController();
    const current: Job = { id: nextJob++, manifest: rel as string, startedAt: new Date().toISOString(), state: "running", stages: [] };
    job = current;
    const signal = controller.signal;
    void (async () => {
      try {
        const result = await run({
          manifestPath: absolute, projectRoot: root, signal, ...(allowVersionDrift ? { allowVersionDrift: true } : {}),
          onStage: (stage) => { current.stages.push({ stage, at: new Date().toISOString() }); },
        });
        current.result = { verdict: result.verdict, run: basename(dirname(result.reportPath)), digests: result.report.digests };
        current.state = "done";
      } catch (error) {
        current.state = signal.aborted ? "cancelled" : "error";
        current.error = error instanceof Error ? error.message : String(error);
        const stage = runFailureStage(error);
        if (stage !== undefined) current.errorStage = stage;
      }
    })();
    return current;
  }

  const allowedHosts = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4173,
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? "";
      const hostName = host.replace(/:\d+$/, "");
      // DNS rebinding: a foreign name resolving to 127.0.0.1 must not reach the console.
      const extra = options.allowHosts ?? [];
      if (!allowedHosts.has(host) && !extra.includes("*") && !extra.includes(hostName) && !extra.includes(host)) {
        return new Response("unknown host", { status: 421 });
      }
      try {
        if (url.pathname === "/" && request.method === "GET") {
          const nonce = randomBytes(16).toString("base64");
          return new Response(renderPage({ token, nonce, version: VERSION, project: root }), { headers: {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          } });
        }
        if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
        if (request.headers.get("x-ckb-verify-token") !== token) return json({ error: "missing or wrong console token" }, 403);
        const body = async (): Promise<Record<string, unknown>> => {
          const length = Number(request.headers.get("content-length") ?? "0");
          if (length > MAX_BODY) throw new HttpError(413, "request body too large");
          const text = await request.text();
          if (text.length > MAX_BODY) throw new HttpError(413, "request body too large");
          try { const value = JSON.parse(text); if (value !== null && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* below */ }
          throw new HttpError(400, "request body must be a JSON object");
        };
        const route = `${request.method} ${url.pathname}`;
        if (route === "GET /api/state") {
          return json({ version: VERSION, project: root, manifests: await manifests(), runs: await runs(), job: job ?? null });
        }
        if (route === "GET /api/manifest") {
          const absolute = await manifestPath(url.searchParams.get("path"));
          const validation = await validateManifestFile(absolute);
          return json({ path: url.searchParams.get("path"), text: await readFile(absolute, "utf8"), validation });
        }
        if (route === "GET /api/run") {
          const id = url.searchParams.get("id");
          const report = await readReport(id);
          const inspection = inspectReport(report);
          return json({ id, view: buildReportView(report), inspection: { valid: inspection.valid, problems: inspection.problems, recomputed: inspection.digests.recomputed }, report });
        }
        if (route === "GET /api/logs") {
          const dir = await runDir(url.searchParams.get("id"));
          const stepsDir = join(dir, "steps");
          const steps = [];
          for (const name of (await readdir(stepsDir).catch(() => [] as string[])).sort()) {
            const files: Record<string, string> = {};
            for (const file of ["stdout.txt", "stderr.txt", "debugger.txt", "rpc-error.json", "test-tx-pool-error.json"]) {
              const text = await readCapped(join(stepsDir, name, file));
              if (text !== null && text !== "") files[file] = text;
            }
            steps.push({ step: name, files });
          }
          return json({ id: url.searchParams.get("id"), hasReport: await lstat(join(dir, "report.json")).then(() => true, () => false), steps });
        }
        if (route === "POST /api/verify") {
          const { report } = await body();
          let parsed: unknown = report;
          if (typeof report === "string") { try { parsed = JSON.parse(report); } catch { throw new HttpError(400, "the pasted text is not JSON"); } }
          const inspection = inspectReport(parsed);
          return json({ view: buildReportView(parsed), inspection: { valid: inspection.valid, problems: inspection.problems, recomputed: inspection.digests.recomputed, stored: inspection.digests.stored } });
        }
        if (route === "POST /api/compare") {
          const { a, b } = await body();
          return json(compareReports(await readReport(a), await readReport(b)));
        }
        if (route === "POST /api/run") {
          const { manifest, allowVersionDrift } = await body();
          return json(await startJob(manifest, allowVersionDrift === true), 202);
        }
        if (route === "GET /api/job") return json(job ?? null);
        if (route === "POST /api/job/cancel") {
          if (job?.state !== "running") throw new HttpError(409, "no run in progress");
          controller?.abort();
          return json({ cancelling: job.id }, 202);
        }
        return json({ error: "not found" }, 404);
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    },
  });
  const port = server.port ?? options.port ?? 4173;
  for (const name of ["127.0.0.1", "localhost"]) allowedHosts.add(`${name}:${port}`);
  return {
    url: `http://127.0.0.1:${port}/`, port, token,
    async stop() {
      controller?.abort();
      server.stop(true);
    },
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

