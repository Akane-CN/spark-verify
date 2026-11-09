// The console page: one self-contained document (no external assets), served with a nonce CSP. Every value
// from a manifest or report is inserted with textContent, never as HTML: a pasted report is untrusted input.

export function renderPage(options: { token: string; nonce: string; version: string; project: string }): string {
  const boot = JSON.stringify({ token: options.token, version: options.version, project: options.project }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CKB Verify console</title>
<style nonce="${options.nonce}">${STYLE}</style>
</head>
<body>
<header class="top">
  <div class="brand"><span class="logo">✓</span> CKB Verify <span class="muted">console</span></div>
  <div class="project mono" id="project"></div>
</header>
<div class="layout">
  <aside class="side">
    <button class="primary wide" id="verify-open">Verify a report…</button>
    <h3>Manifests</h3><nav id="manifests" class="list"></nav>
    <h3>Runs <span class="muted" id="runs-count"></span></h3><nav id="runs" class="list"></nav>
  </aside>
  <main id="main"></main>
</div>
<script nonce="${options.nonce}">window.CKB_VERIFY = ${boot};</script>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = String.raw`
:root { --bg:#f6f7f9; --panel:#fff; --ink:#1b1f24; --muted:#5b6470; --line:#dde1e6; --accent:#2457d6; --accent-ink:#fff;
  --pass:#137333; --pass-bg:#e6f4ea; --fail:#b3261e; --fail-bg:#fce8e6; --warn:#8a5a00; --warn-bg:#fff4d6; --chip:#eef1f5; --code:#f2f4f7; }
@media (prefers-color-scheme: dark) { :root { --bg:#111418; --panel:#181c21; --ink:#e6e9ed; --muted:#9aa4b0; --line:#2a3038; --accent:#7aa2ff; --accent-ink:#0b1020;
  --pass:#7fd49a; --pass-bg:#11301c; --fail:#ff8a80; --fail-bg:#3a1512; --warn:#f0c46b; --warn-bg:#3a2c0b; --chip:#232931; --code:#1e2329; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
.mono, code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
.muted { color:var(--muted); font-weight:400; }
.top { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 18px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:2; }
.brand { font-weight:650; font-size:16px; } .logo { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:6px; background:var(--accent); color:var(--accent-ink); font-size:13px; margin-right:6px; }
.project { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.layout { display:grid; grid-template-columns:300px 1fr; min-height:calc(100vh - 47px); }
.side { border-right:1px solid var(--line); padding:14px; background:var(--panel); overflow:auto; max-height:calc(100vh - 47px); position:sticky; top:47px; }
.side h3 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:18px 0 6px; }
.list { display:flex; flex-direction:column; gap:2px; }
.item { text-align:left; border:0; background:transparent; color:var(--ink); padding:6px 8px; border-radius:6px; cursor:pointer; display:flex; gap:8px; align-items:center; justify-content:space-between; font:inherit; }
.item:hover { background:var(--chip); } .item.active { background:var(--chip); outline:1px solid var(--line); }
.item .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
main { padding:20px 26px; min-width:0; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:22px 0 8px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:650; white-space:nowrap; }
.pass { background:var(--pass-bg); color:var(--pass); } .fail { background:var(--fail-bg); color:var(--fail); } .warn { background:var(--warn-bg); color:var(--warn); } .neutral { background:var(--chip); color:var(--muted); }
.big { font-size:15px; padding:4px 12px; }
button { font:inherit; }
.primary, .secondary { border-radius:7px; padding:7px 12px; cursor:pointer; border:1px solid var(--accent); }
.primary { background:var(--accent); color:var(--accent-ink); } .secondary { background:transparent; color:var(--accent); }
.primary:disabled, .secondary:disabled { opacity:.5; cursor:not-allowed; } .wide { width:100%; }
.tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin:14px 0 4px; flex-wrap:wrap; }
.tab { border:0; background:transparent; padding:8px 12px; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; font:inherit; }
.tab.active { color:var(--ink); border-bottom-color:var(--accent); font-weight:600; }
table { border-collapse:collapse; width:100%; } th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); }
th { font-size:12px; color:var(--muted); font-weight:600; } td.k { color:var(--muted); width:170px; white-space:nowrap; }
pre { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow:auto; max-height:460px; margin:6px 0; white-space:pre-wrap; word-break:break-word; }
.flow { display:grid; grid-template-columns:1fr 34px 1fr; gap:8px; align-items:start; margin-top:10px; }
.arrow { align-self:center; text-align:center; color:var(--muted); font-size:22px; }
.col h4 { margin:0 0 6px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.cell { border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:8px; padding:7px 9px; margin-bottom:6px; background:var(--bg); }
.cell .cap { font-weight:650; } .cell .meta { color:var(--muted); font-size:12.5px; overflow-wrap:anywhere; }
.cell.unknown { border-left-color:var(--line); }
.chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; } .chip { background:var(--chip); border-radius:6px; padding:2px 7px; font-size:12px; }
.check { display:flex; gap:8px; align-items:baseline; } .ok { color:var(--pass); font-weight:700; } .no { color:var(--fail); font-weight:700; }
.hash { overflow-wrap:anywhere; }
textarea { width:100%; min-height:220px; background:var(--code); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:10px; font-family:ui-monospace,Menlo,monospace; font-size:12px; }
.stage { display:flex; gap:10px; padding:3px 0; } .stage .t { color:var(--muted); width:80px; flex:none; font-variant-numeric:tabular-nums; }
.error { border-color:var(--fail); } .hint { color:var(--muted); margin-top:6px; } .mt { margin-top:8px; }
.grid3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
details summary { cursor:pointer; color:var(--accent); margin:6px 0; }
@media (max-width: 860px) { .layout { grid-template-columns:1fr; } .project { display:none; } .side { position:static; max-height:none; border-right:0; border-bottom:1px solid var(--line); } .list { max-height:32vh; overflow:auto; } .flow { grid-template-columns:1fr; } .arrow { transform:rotate(90deg); } main { padding:16px; } }
`;

const SCRIPT = String.raw`
"use strict";
const BOOT = window.CKB_VERIFY;
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
/** replaceChildren would print null/false as text; drop them. */
function put(el, ...nodes) { el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false)); }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "x-ckb-verify-token": BOOT.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: "unreadable response" }));
  if (!response.ok) throw new Error(data && data.error ? data.error : "HTTP " + response.status);
  return data;
}
const verdictBadge = (v, big) => h("span", { class: "badge " + (v === "PASS" ? "pass" : v === "FAIL" ? "fail" : "neutral") + (big ? " big" : "") }, v || "no verdict");
const validBadge = (ok) => h("span", { class: "badge " + (ok ? "pass" : "fail") }, ok ? "VALID offline" : "INVALID");
const mark = (ok) => h("span", { class: ok ? "ok" : "no" }, ok ? "✓" : "✗");
const kv = (rows) => h("table", {}, rows.map(([k, v]) => h("tr", {}, h("td", { class: "k" }, k), h("td", { class: "mono hash" }, v))));
function copyable(text) { return h("span", { class: "row" }, h("code", { class: "hash" }, text), h("button", { class: "secondary", onclick: () => navigator.clipboard && navigator.clipboard.writeText(text) }, "copy")); }

const STAGE_HINTS = [
  [/^manifest$/, "The manifest itself: fix verify.toml (run Validate to see each problem with its key path)."],
  [/^preflight$/, "Before any devnet: platform, pinned tool versions, repository binaries, or the source snapshot."],
  [/^devnet$/, "Starting the local OffCKB devnet: ports 8114/28114, tool downloads, or the patched OffCKB install. Not your project."],
  [/^setup$/, "Deploying the manifest's setup scripts or checking the devnet identity."],
  [/: command$/, "The step's own command failed or timed out: this is the project's code. See its stderr under the run's Logs."],
  [/: result$/, "The step's command wrote a malformed or missing result envelope (or a pure step wrote one)."],
  [/: submission$/, "Submitting the transaction or waiting for it: an RPC or debugger problem, not a failed claim."],
  [/: claims$|^final claims$/, "Reading chain state for the claims (node or indexer)."],
  [/^source guard$/, "Project files changed while the run was in progress."],
  [/^report$/, "Assembling or self-checking the report."],
  [/^cleanup$/, "Stopping the devnet or scrubbing evidence after the run."],
];
const stageHint = (stage) => { for (const [re, text] of STAGE_HINTS) if (re.test(stage)) return text; return ""; };

let state = { manifests: [], runs: [], job: null }, selected = null, poller = null;

async function refresh() {
  const data = await api("/api/state");
  state = data;
  $("project").textContent = data.project + "  ·  ckb-verify " + data.version;
  const m = $("manifests"); put(m, ...data.manifests.map((path) => {
    const slash = path.lastIndexOf("/"), file = path.slice(slash + 1), dir = slash < 0 ? "project root" : path.slice(0, slash);
    return h("button", { class: "item" + (selected && selected.kind === "manifest" && selected.id === path ? " active" : ""), title: path, onclick: () => openManifest(path) },
      h("span", { class: "label" }, h("span", { class: "mono" }, file), h("br"), h("span", { class: "muted mono" }, dir)));
  }));
  if (data.manifests.length === 0) put(m, h("div", { class: "muted" }, "No verify*.toml found in this project."));
  $("runs-count").textContent = data.runs.length ? "(" + data.runs.length + ")" : "";
  const r = $("runs"); put(r, ...data.runs.map((run) =>
    h("button", { class: "item" + (selected && selected.kind === "run" && selected.id === run.id ? " active" : ""), title: run.id, onclick: () => openRun(run.id) },
      h("span", { class: "label" }, (run.name || run.id.replace(/^\S+?-\d+-/, "")), h("br"), h("span", { class: "muted mono" }, run.id.slice(0, 19).replace("T", " "))),
      run.hasReport ? verdictBadge(run.verdict) : h("span", { class: "badge warn" }, "no verdict"))));
  if (data.runs.length === 0) put(r, h("div", { class: "muted" }, "No runs yet. Open a manifest and run it."));
  if (data.job && data.job.state === "running" && !poller) poller = setInterval(pollJob, 1000);
}

function welcome() {
  selected = null;
  put($("main"), 
    h("h1", {}, "Executable acceptance checks for CKB projects"),
    h("p", { class: "muted" }, "Pick a manifest to validate and run it on a fresh local devnet, open a run to read its report, or verify any report offline."),
    h("div", { class: "grid3" },
      h("div", { class: "card" }, h("b", {}, "1 · Validate and run"), h("p", {}, "A manifest (verify.toml) declares the steps and the outcomes they must produce. Validation runs nothing; a run starts a fresh OffCKB devnet and executes the manifest's commands.")),
      h("div", { class: "card" }, h("b", {}, "2 · Read the evidence"), h("p", {}, "Each run's report shows every transaction as input and output Cells, every claim as expected vs observed, and why a run failed when it did.")),
      h("div", { class: "card" }, h("b", {}, "3 · Verify offline"), h("p", {}, "Paste or upload someone else's report.json: its claims, verdict, and both digests are re-derived here without starting anything."))));
}

async function openManifest(path) {
  selected = { kind: "manifest", id: path }; refresh();
  const main = $("main"); put(main, h("p", { class: "muted" }, "Validating " + path + " …"));
  let data; try { data = await api("/api/manifest?path=" + encodeURIComponent(path)); } catch (e) { put(main, h("div", { class: "card error" }, e.message)); return; }
  const v = data.validation, s = v.manifest;
  const drift = h("input", { type: "checkbox", id: "drift" });
  const runButton = h("button", { class: "primary", disabled: !v.ok || (state.job && state.job.state === "running"), onclick: async () => {
    runButton.disabled = true;
    try { await api("/api/run", { manifest: path, allowVersionDrift: drift.checked }); await refresh(); pollJob(); if (!poller) poller = setInterval(pollJob, 1000); }
    catch (e) { alert(e.message); runButton.disabled = false; } } }, "Run on a fresh devnet");
  put(main, 
    h("div", { class: "row" }, h("h1", {}, s ? s.name : path), s ? h("span", { class: "badge neutral" }, "spec " + s.spec) : null, h("span", { class: "badge " + (v.ok ? "pass" : "fail") }, v.ok ? "valid" : "invalid")),
    h("div", { class: "muted mono" }, path),
    s && s.description ? h("p", {}, s.description) : null,
    v.problems.length ? h("div", { class: "card error" }, h("b", {}, "Problems"), h("ul", {}, v.problems.map((p) => h("li", { class: "mono" }, p)))) : null,
    s ? h("div", { class: "card" }, kv([
      ["accounts", String(s.accounts)],
      ["setup scripts", s.setupScripts.length ? s.setupScripts.map((x) => x.name + " (" + (x.kind === "binary" ? x.path + ", " + x.hashType : "builtin " + x.builtin) + ")").join("; ") : "none"],
      ["steps", s.steps.length ? s.steps.map((st) => st.name + " [" + st.kind + (st.expect ? ", expect " + st.expect.tx + (st.expect.errorCode !== undefined ? " code " + st.expect.errorCode : "") : "") + ", " + st.claims + " claim(s)]").join("; ") : "none"],
      ["final claims", String(s.finalClaims)], ["claims in total", String(s.claimCount)],
      ["toolchain", "CKB " + s.toolchain.ckb + ", OffCKB " + s.toolchain.offckb + (s.toolchain.ckbDebugger ? ", ckb-debugger " + s.toolchain.ckbDebugger : "")],
      ["sha256", s.sha256]])) : null,
    h("div", { class: "card" }, h("div", { class: "row" }, runButton, h("label", { class: "row" }, drift, "allow CKB version drift")),
      h("div", { class: "hint" }, "A run executes this manifest's commands from your repository (trusted code) on a fresh local devnet, then writes .ckb-verify/runs/<run>/report.json."),
      h("div", { id: "job" })),
    h("h2", {}, "verify.toml"), h("pre", {}, data.text));
  renderJob();
}

async function pollJob() {
  try {
    const job = await api("/api/job"); state.job = job; renderJob();
    if (!job || job.state !== "running") { clearInterval(poller); poller = null; await refresh(); }
  } catch (e) { /* the next tick retries */ }
}

function renderJob() {
  const box = $("job"); if (!box) return;
  const job = state.job;
  if (!job || !selected || job.manifest !== selected.id) { put(box); return; }
  const t0 = new Date(job.startedAt).getTime();
  const stages = job.stages.map((s) => h("div", { class: "stage" }, h("span", { class: "t" }, "+" + ((new Date(s.at).getTime() - t0) / 1000).toFixed(1) + " s"), h("span", { class: "mono" }, s.stage)));
  const header = job.state === "running" ? h("div", { class: "row" }, h("span", { class: "badge warn" }, "running"), h("button", { class: "secondary", onclick: () => api("/api/job/cancel", {}).catch((e) => alert(e.message)) }, "Cancel"))
    : job.state === "done" ? h("div", { class: "row" }, verdictBadge(job.result.verdict, true), h("button", { class: "primary", onclick: () => openRun(job.result.run) }, "Open the report"))
    : h("div", {}, h("div", { class: "row" }, h("span", { class: "badge fail" }, job.state === "cancelled" ? "cancelled" : "no verdict"),
        job.errorStage ? h("span", {}, "stopped at ", h("code", {}, job.errorStage)) : null),
        h("pre", {}, job.error || ""), job.errorStage ? h("div", { class: "hint" }, stageHint(job.errorStage)) : null);
  put(box, h("div", { class: "card" + (job.state === "error" ? " error" : "") }, header, h("div", { class: "muted mt" }, "Stages"), stages));
}

function claimsTable(claims, where) {
  if (!claims.length) return h("div", { class: "muted" }, "No claims.");
  return h("table", {}, h("tr", {}, where ? h("th", {}, "where") : null, h("th", {}, ""), h("th", {}, "claim"), h("th", {}, "expected"), h("th", {}, "observed")),
    claims.map((c) => h("tr", {}, where ? h("td", { class: "muted" }, c.where) : null, h("td", {}, mark(c.ok)), h("td", {}, h("b", {}, c.kind), " ", c.target),
      h("td", { class: "mono" }, c.expected), h("td", { class: "mono" + (c.ok ? "" : " no") }, c.observed, c.observationValid ? "" : " (observation invalid)"))));
}

function cellBox(cell, title) {
  if (!cell) return h("div", { class: "cell unknown" }, h("div", { class: "meta" }, title), h("div", { class: "meta" }, "Cell not retained in this report"));
  return h("div", { class: "cell" }, h("div", { class: "row" }, h("span", { class: "cap" }, cell.capacity + " CKB"), h("span", { class: "muted" }, title)),
    h("div", { class: "meta" }, "lock: ", h("b", {}, cell.lock)), cell.type ? h("div", { class: "meta" }, "type: ", h("b", {}, cell.type)) : null,
    cell.dataBytes !== null ? h("div", { class: "meta mono" }, "data " + cell.dataBytes + " B" + (cell.dataBytes ? ": " + cell.data : "")) : null,
    cell.origin ? h("div", { class: "meta" }, "from " + cell.origin) : null);
}

function stepCard(step) {
  const status = step.kind === "pure" ? h("span", { class: "badge neutral" }, "pure step") : h("span", { class: "badge " + (step.observed.status === "committed" ? "pass" : "warn") }, step.observed.status || "?");
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("b", {}, step.name), status, step.observed.cycles !== undefined ? h("span", { class: "muted" }, step.observed.cycles.toLocaleString() + " cycles") : null),
    step.checks.length ? h("div", { class: "mt" }, step.checks.map((c) => h("div", { class: "check" }, mark(c.ok), h("span", { class: "mono" }, c.label)))) : null,
    step.observed.rejection ? h("div", { class: "hint" }, "Observed: " + step.observed.rejection) : null,
    step.transaction ? h("div", {},
      h("div", { class: "muted mono hash mt" }, "tx " + step.transaction.hash),
      h("div", { class: "flow" },
        h("div", { class: "col" }, h("h4", {}, "inputs (" + step.transaction.inputs.length + ")"), step.transaction.inputs.map((i) => cellBox(i.cell, i.outPoint))),
        h("div", { class: "arrow" }, "→"),
        h("div", { class: "col" }, h("h4", {}, "outputs (" + step.transaction.outputs.length + ")"), step.transaction.outputs.map((o, k) => cellBox(o, "output " + k)))),
      h("div", { class: "chips" }, h("span", { class: "muted" }, "cell deps:"), step.transaction.cellDeps.map((d) => h("span", { class: "chip mono" }, d)), h("span", { class: "chip" }, step.transaction.witnesses + " witness(es)"))) : null,
    step.claims.length ? h("div", { class: "mt" }, h("div", { class: "muted" }, "Claims after this step"), claimsTable(step.claims)) : null);
}

function failures(view) {
  const out = [];
  for (const s of view.steps) { for (const c of s.checks) if (!c.ok) out.push('step "' + s.name + '": ' + c.label + (s.observed.rejection ? " — observed " + s.observed.rejection : s.observed.status ? " — observed " + s.observed.status : ""));
    for (const c of s.claims) if (!c.ok) out.push('step "' + s.name + '": ' + c.kind + " " + c.target + " — expected " + c.expected + ", observed " + c.observed); }
  for (const c of view.assertions) if (!c.ok) out.push("final: " + c.kind + " " + c.target + " — expected " + c.expected + ", observed " + c.observed);
  return out;
}

function reportPanels(view, inspection, extra) {
  const allClaims = [...view.steps.flatMap((s) => s.claims.map((c) => ({ ...c, where: 'step "' + s.name + '"' }))), ...view.assertions.map((c) => ({ ...c, where: "final" }))];
  const fails = failures(view);
  const overview = () => [
    h("div", { class: "card" }, kv([["manifest", view.name], ["spec / report", view.spec + " / " + view.schema], ["created", view.createdAt]]),
      h("div", { class: "mt" }, h("div", {}, "outcome digest"), copyable(view.digests.outcome), h("div", { class: "mt" }, "environment digest"), copyable(view.digests.environment))),
    h("div", { class: "card" + (inspection.valid ? "" : " error") }, h("div", { class: "row" }, validBadge(inspection.valid), h("span", { class: "muted" }, "claims, verdict, and both digests re-derived from the report's own evidence")),
      inspection.problems.length ? h("ul", {}, inspection.problems.map((p) => h("li", { class: "mono" }, p))) : null),
    h("div", { class: "card" }, h("div", { class: "row" }, h("b", {}, "Replay"), h("span", { class: "badge " + (view.replay.status === "stable" ? "pass" : "warn") }, view.replay.status)),
      view.replay.reasons.length ? h("ul", {}, view.replay.reasons.map((r) => h("li", {}, h("code", {}, r.code), " (" + r.scope + "): " + r.detail))) : h("div", { class: "muted" }, "No reasons: stable under the recorded inputs and the author's declaration.")),
    fails.length ? h("div", { class: "card error" }, h("b", {}, "What failed"), h("ul", {}, fails.map((f) => h("li", {}, f)))) : null,
    extra ? extra() : null];
  const tabs = [["Overview", overview], ["Steps", () => view.steps.length ? view.steps.map(stepCard) : [h("div", { class: "muted" }, "No steps.")]],
    ["Claims", () => [claimsTable(allClaims, true)]],
    ["Environment", () => [h("div", { class: "card" }, kv(view.environment)), view.setupScripts.length ? h("div", { class: "card" }, h("b", {}, "Setup scripts"),
      h("table", {}, h("tr", {}, h("th", {}, "name"), h("th", {}, "kind"), h("th", {}, "hash type"), h("th", {}, "code hash"), h("th", {}, "detail")),
        view.setupScripts.map((s) => h("tr", {}, h("td", {}, s.name), h("td", {}, s.kind), h("td", {}, s.hashType), h("td", { class: "mono hash" }, s.codeHash), h("td", { class: "mono hash" }, s.detail))))) : null]]];
  return tabs;
}

function tabbed(tabs) {
  const body = h("div", {});
  const bar = h("div", { class: "tabs" });
  const show = (i) => { [...bar.children].forEach((b, k) => b.classList.toggle("active", k === i)); Promise.resolve(tabs[i][1]()).then((nodes) => put(body, ...[nodes].flat().filter(Boolean))); };
  tabs.forEach(([name], i) => bar.appendChild(h("button", { class: "tab", onclick: () => show(i) }, name)));
  show(0);
  return [bar, body];
}

async function openRun(id) {
  selected = { kind: "run", id }; refresh();
  const main = $("main"); put(main, h("p", { class: "muted" }, "Loading " + id + " …"));
  let data;
  try { data = await api("/api/run?id=" + encodeURIComponent(id)); }
  catch (e) {
    put(main, h("h1", {}, id), h("div", { class: "card error" }, e.message), h("h2", {}, "Logs"), h("div", { id: "logs" }));
    renderLogs(id, $("logs")); return;
  }
  const view = data.view;
  const others = state.runs.filter((r) => r.hasReport && r.id !== id).sort((a, b) => (b.name === view.name) - (a.name === view.name));
  const compare = () => {
    const select = h("select", {}, others.map((r) => h("option", { value: r.id }, (r.name || "?") + " · " + r.id.slice(0, 19) + " · " + (r.verdict || ""))));
    const out = h("div", {});
    return h("div", { class: "card" }, h("b", {}, "Compare with another run"),
      others.length ? h("div", { class: "row mt" }, select, h("button", { class: "secondary", onclick: async () => {
        try { const c = await api("/api/compare", { a: id, b: select.value });
          put(out, h("div", { class: "row" }, h("span", { class: "badge " + (c.outcomeEqual ? "pass" : "warn") }, c.outcomeEqual ? "same outcome digest" : "different outcome"),
            h("span", { class: "badge " + (c.environmentEqual ? "pass" : "neutral") }, c.environmentEqual ? "same environment" : "different environment"), c.sameManifest ? null : h("span", { class: "badge warn" }, "different manifest")),
            c.differences.length ? h("ul", {}, c.differences.map((d) => h("li", { class: "mono" }, d))) : h("div", { class: "muted" }, "Every claim and step agrees."));
        } catch (e) { put(out, h("div", { class: "no" }, e.message)); } } }, "Compare")) : h("div", { class: "muted" }, "No other run to compare with."), out);
  };
  const tabs = reportPanels(view, data.inspection, compare);
  tabs.push(["Logs", () => { const box = h("div", {}); renderLogs(id, box); return [box]; }]);
  tabs.push(["JSON", () => [h("pre", {}, JSON.stringify(data.report, null, 2))]]);
  put(main, h("div", { class: "row" }, h("h1", {}, view.name), verdictBadge(view.verdict, true), validBadge(data.inspection.valid)), h("div", { class: "muted mono" }, id), ...tabbed(tabs));
}

async function renderLogs(id, box) {
  try {
    const data = await api("/api/logs?id=" + encodeURIComponent(id));
    put(box, ...(data.steps.length ? data.steps.map((s) => h("div", { class: "card" }, h("b", { class: "mono" }, s.step),
      Object.keys(s.files).length ? Object.entries(s.files).map(([name, text]) => h("details", { open: name === "stderr.txt" && text.trim() !== "" }, h("summary", {}, name), h("pre", {}, text))) : h("div", { class: "muted" }, "no output")))
      : [h("div", { class: "muted" }, "No step output was recorded (the run stopped before its first step).")]));
  } catch (e) { put(box, h("div", { class: "no" }, e.message)); }
}

function openVerify() {
  selected = null; refresh();
  const area = h("textarea", { placeholder: "Paste a report.json here, or choose a file." });
  const file = h("input", { type: "file", accept: ".json,application/json", onchange: async () => { if (file.files[0]) area.value = await file.files[0].text(); } });
  const out = h("div", {});
  put($("main"), h("h1", {}, "Verify a report offline"),
    h("p", { class: "muted" }, "Nothing is executed: the report's claims, verdict, and both digests are re-derived from its own retained evidence, and it is checked against the published schema."),
    h("div", { class: "card" }, file, area, h("div", { class: "row mt" }, h("button", { class: "primary", onclick: async () => {
      try { const data = await api("/api/verify", { report: area.value });
        put(out, h("div", { class: "row" }, h("h1", {}, data.view.name), verdictBadge(data.view.verdict, true), validBadge(data.inspection.valid)), ...tabbed(reportPanels(data.view, data.inspection)));
      } catch (e) { put(out, h("div", { class: "card error" }, e.message)); } } }, "Verify"))), out);
}

$("verify-open").addEventListener("click", openVerify);
welcome();
refresh().catch((e) => put($("main"), h("div", { class: "card error" }, e.message)));
`;
