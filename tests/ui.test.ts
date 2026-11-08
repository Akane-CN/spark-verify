// `ckb-verify ui`: the local console's API over real report fixtures, its access checks, and a run driven
// through an injected runner (no devnet).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunManifestOptions, RunManifestResult } from "../src/runner";
import { startUi, type UiServer } from "../src/ui/server";
import { buildReportView, compareReports, formatCkb } from "../src/ui/view-model";

const fixtures = join(import.meta.dir, "fixtures", "report-v4");
let project: string, server: UiServer;
const servers: UiServer[] = [];

async function call(path: string, init: { method?: string; body?: unknown; token?: string | null; host?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers["x-ckb-verify-token"] = init.token ?? server.token;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.host !== undefined) headers.host = init.host;
  const response = await fetch(new URL(path, server.url), { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const text = await response.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json, text };
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "ckb-verify-ui-"));
  await mkdir(join(project, "showcases", "demo"), { recursive: true });
  await writeFile(join(project, "verify.toml"), (await readFile(join(import.meta.dir, "..", "verify.toml"), "utf8")));
  await writeFile(join(project, "showcases", "demo", "verify.broken.toml"), "[meta]\nname = 1\n");
  await mkdir(join(project, "node_modules", "x"), { recursive: true });
  await writeFile(join(project, "node_modules", "x", "verify.toml"), "ignored");
  for (const [id, name] of [["2026-11-03T18-24-26-378Z-1-repository-script-committed", "committed"], ["2026-11-03T18-25-39-308Z-2-repository-script-rejected", "rejected"],
    ["2026-11-03T18-27-25-326Z-3-repository-script-node-rejected", "node-rejected"]] as const) {
    await mkdir(join(project, ".ckb-verify", "runs", id, "steps", "01-create"), { recursive: true });
    await copyFile(join(fixtures, `${name}.json`), join(project, ".ckb-verify", "runs", id, "report.json"));
    await writeFile(join(project, ".ckb-verify", "runs", id, "steps", "01-create", "stderr.txt"), "producer log line\n");
  }
  await mkdir(join(project, ".ckb-verify", "runs", "2026-11-03T19-00-00-000Z-4-no-verdict", "steps", "01-x"), { recursive: true });
  server = await startUi({ projectRoot: project, port: 0 });
  servers.push(server);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await rm(project, { recursive: true, force: true });
});

describe("console access", () => {
  test("serves the page with a nonce CSP and requires the token on every API call", async () => {
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(await page.text()).toContain(server.token);
    expect((await call("/api/state", { token: null })).status).toBe(403);
    expect((await call("/api/state", { token: "wrong" })).status).toBe(403);
    expect((await call("/api/state")).status).toBe(200);
  });

  test("refuses foreign Host names (DNS rebinding) unless explicitly allowed", async () => {
    expect((await call("/api/state", { host: "evil.example:1234" })).status).toBe(421);
    expect((await call("/", { host: `localhost:${server.port}` })).status).toBe(200);
    const proxied = await startUi({ projectRoot: project, port: 0, allowHosts: ["preview.example"] });
    servers.push(proxied);
    const response = await fetch(proxied.url, { headers: { host: "preview.example" } });
    expect(response.status).toBe(200);
  });

  test("never reads a file outside the listed manifests and run directories", async () => {
    expect((await call("/api/manifest?path=../../etc/passwd")).status).toBe(404);
    expect((await call("/api/manifest?path=node_modules/x/verify.toml")).status).toBe(404);
    expect((await call("/api/run?id=../../etc")).status).toBe(404);
    expect((await call("/api/logs?id=..")).status).toBe(404);
  });
});

describe("console data", () => {
  test("lists manifests (ignoring node_modules) and runs, newest first", async () => {
    const { json } = await call("/api/state");
    expect(json.manifests).toEqual(["verify.toml", "showcases/demo/verify.broken.toml"]);
    expect(json.runs.map((r: any) => [r.verdict ?? null, r.hasReport])).toEqual([[null, false], ["PASS", true], ["PASS", true], ["PASS", true]]);
    expect(json.job).toBeNull();
  });

  test("validates a manifest without running it", async () => {
    const good = await call("/api/manifest?path=verify.toml");
    expect(good.json.validation.ok).toBe(true);
    const broken = await call("/api/manifest?path=showcases/demo/verify.broken.toml");
    expect(broken.json.validation.ok).toBe(false);
    expect(broken.json.validation.problems.length).toBeGreaterThan(0);
  });

  test("opens a run: verified offline, transactions drawn with named scripts", async () => {
    const { json } = await call("/api/run?id=2026-11-03T18-25-39-308Z-2-repository-script-rejected");
    expect(json.inspection.valid).toBe(true);
    const step = json.view.steps[1];
    expect(step.checks).toEqual([
      { label: "expect.tx = rejected", ok: true },
      { label: "expect.error.code = 42", ok: true },
      { label: "expect.error.group = lock witness_lock args 0x01", ok: true },
    ]);
    expect(step.observed.rejection).toContain("script error 42 from the lock script witness_lock(0x01)");
    // The input is output 0 of the create step, recognized across steps.
    expect(step.transaction.inputs[0].cell.origin).toBe('output 0 of "create protected cells"');
    expect(step.transaction.inputs[0].cell.lock).toBe("witness_lock(0x01)");
    expect(json.view.steps[0].transaction.outputs[0]).toMatchObject({ capacity: "300", lock: "witness_lock(0x01)" });
  });

  test("a run without a report says so and still shows its logs", async () => {
    expect((await call("/api/run?id=2026-11-03T19-00-00-000Z-4-no-verdict")).status).toBe(404);
    const logs = await call("/api/logs?id=2026-11-03T18-24-26-378Z-1-repository-script-committed");
    expect(logs.json.steps[0].files["stderr.txt"]).toBe("producer log line\n");
  });

  test("verifies a pasted report offline and catches a tampered verdict", async () => {
    const text = await readFile(join(fixtures, "committed.json"), "utf8");
    expect((await call("/api/verify", { body: { report: text } })).json.inspection.valid).toBe(true);
    const tampered = JSON.parse(text); tampered.verdict = "FAIL";
    const bad = await call("/api/verify", { body: { report: JSON.stringify(tampered) } });
    expect(bad.json.inspection.valid).toBe(false);
    expect((await call("/api/verify", { body: { report: "not json" } })).status).toBe(400);
  });

  test("compares two runs claim by claim", async () => {
    const { json } = await call("/api/compare", { body: { a: "2026-11-03T18-24-26-378Z-1-repository-script-committed", b: "2026-11-03T18-25-39-308Z-2-repository-script-rejected" } });
    expect(json.sameManifest).toBe(false);
    expect(json.outcomeEqual).toBe(false);
    expect(json.differences.length).toBeGreaterThan(0);
  });
});

describe("console runs", () => {
  test("starts one run at a time, reports its stages, and links the report", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = async (options: RunManifestOptions): Promise<RunManifestResult> => {
      options.onStage?.("preflight"); options.onStage?.("devnet");
      await gate;
      const reportPath = join(project, ".ckb-verify", "runs", "2026-11-03T18-24-26-378Z-1-repository-script-committed", "report.json");
      return { verdict: "PASS", reportPath, report: JSON.parse(await readFile(reportPath, "utf8")) };
    };
    const ui = await startUi({ projectRoot: project, port: 0, runManifest: fake });
    servers.push(ui); server = ui;
    expect((await call("/api/run", { body: { manifest: "../outside.toml" } })).status).toBe(404);
    const started = await call("/api/run", { body: { manifest: "verify.toml" } });
    expect(started.status).toBe(202);
    expect((await call("/api/run", { body: { manifest: "verify.toml" } })).status).toBe(409);
    expect((await call("/api/job")).json.stages.map((s: any) => s.stage)).toEqual(["preflight", "devnet"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const done = (await call("/api/job")).json;
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({ verdict: "PASS", run: "2026-11-03T18-24-26-378Z-1-repository-script-committed" });
  });

  test("a failed run carries the stage it stopped in", async () => {
    const fake = async (options: RunManifestOptions): Promise<RunManifestResult> => {
      options.onStage?.('step "mint": command');
      const error = new Error("step mint exited 1");
      Object.defineProperty(error, "ckbVerifyStage", { value: 'step "mint": command' });
      throw error;
    };
    const ui = await startUi({ projectRoot: project, port: 0, runManifest: fake });
    servers.push(ui); server = ui;
    await call("/api/run", { body: { manifest: "verify.toml" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await call("/api/job")).json).toMatchObject({ state: "error", error: "step mint exited 1", errorStage: 'step "mint": command' });
  });
});

describe("view model", () => {
  test("formats shannons exactly and degrades on unknown shapes", () => {
    expect(formatCkb("29999900000")).toBe("299.999");
    expect(formatCkb("30000000000")).toBe("300");
    expect(formatCkb("1")).toBe("0.00000001");
    expect(buildReportView({}).steps).toEqual([]);
    expect(buildReportView(null).verdict).toBe("?");
  });

  test("identical reports compare equal", async () => {
    const report = JSON.parse(await readFile(join(fixtures, "committed.json"), "utf8"));
    expect(compareReports(report, report)).toEqual({ sameManifest: true, outcomeEqual: true, environmentEqual: true, differences: [] });
  });
});

describe("console host wildcard", () => {
  test("--allow-host '*' accepts any Host name (explicit opt-in for a proxy)", async () => {
    const open = await startUi({ projectRoot: project, port: 0, allowHosts: ["*"] });
    servers.push(open);
    expect((await fetch(open.url, { headers: { host: "anything.example" } })).status).toBe(200);
  });
});
