#!/usr/bin/env bash
# Trusted-code harness for the v0.1 (spec 0.1.0) vocabulary fixture. Each status is collected before deciding case success.
set -uo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT" || exit 1

run_fixture() {
  timeout --signal=INT --kill-after=15s 300s bun run src/cli.ts run "$1"
}

audit_report() {
  bun - "$@" <<'REPORT_AUDIT'
import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { basename } from "node:path";
import { verifyReport } from "./src/report.ts";
import { MINT_AMOUNT, XUDT_CAPACITY_CKB } from "./showcases/vocabulary/produce.ts";
const [name, exit, output] = process.argv.slice(2);
assert(["committed", "cycles-too-low", "wrong-data", "wrong-capacity", "balance-short"].includes(name));
const positive = name === "committed";
assert.equal(Number(exit), positive ? 0 : 1, "unexpected CLI exit");
assert(output.startsWith(positive ? "PASS: All declared claims passed in the recorded environment.\n" : "FAIL:"));
const field = label => {
  const lines = output.split("\n").filter(line => line.startsWith(`${label}: `));
  assert.equal(lines.length, 1, `exactly one ${label} handle required`);
  return lines[0].slice(label.length + 2);
};
const path = field("report"), metadata = await lstat(path);
assert.equal(basename(path), "report.json");
assert(metadata.isFile() && metadata.nlink === 1, "canonical report must be a regular unlinked file");
const report = JSON.parse(await readFile(path, "utf8"));
verifyReport(report); // Every complete saved artifact, including valid FAIL.
assert.equal(report.schema, "ckb-verify-report/3");
assert.equal(report.environment.schema, "ckb-verify-environment/4");
assert.equal(report.environment.devnet.accounts.length, 2);
assert.equal(report.verdict, positive ? "PASS" : "FAIL");
assert.equal(report.digests.outcome, field("outcome"));
assert.equal(report.digests.environment, field("environment"));
assert.equal(report.evidence.manifestText, await readFile(`showcases/vocabulary/verify.${name}.toml`, "utf8"));
const step = report.outcomeClaims.steps[0];
assert.equal(step.name, "mint"); assert.equal(step.observedStatus, "committed");
assert(Number.isSafeInteger(step.cycles) && step.cycles > 0, "cycles recorded");
assert.deepEqual(step.expectedCycles, { gte: 1, lt: name === "cycles-too-low" ? 2 : 100_000_000 });
const [xudtCell, transferCell, deps] = step.claims;
const [filtered, absent, ckb, byAddress, udt] = report.outcomeClaims.assertions;
assert.equal(xudtCell.kind, "cell"); assert.equal(xudtCell.observed.state, "selected"); assert.equal(xudtCell.observed.count, 1);
assert.equal(xudtCell.observed.cells[0].capacity, (BigInt(XUDT_CAPACITY_CKB) * 100_000_000n).toString());
assert.equal(xudtCell.observed.cells[0].dataBytes, 16);
assert.equal(xudtCell.ok, name !== "wrong-data" && name !== "wrong-capacity");
assert.equal(transferCell.observed.count, 1); assert.equal(transferCell.observed.cells[0].capacity, "10000000000"); assert.equal(transferCell.ok, true);
assert.equal(deps.kind, "cell_deps"); assert(deps.observed.present.every(Boolean)); assert.equal(deps.ok, true);
assert.equal(filtered.observed.state, "selected"); assert(filtered.observed.count >= 1); assert.equal(filtered.ok, true);
assert.deepEqual(absent.observed, { state: "selected", count: 0, cells: [] }); assert.equal(absent.ok, true);
assert.equal(ckb.kind, "balance"); assert(BigInt(ckb.observed.total) >= 10_000_000_000n); assert.equal(ckb.ok, true);
assert.equal(byAddress.target.kind, "address"); assert.equal(byAddress.observed.total, ckb.observed.total); assert.equal(byAddress.ok, true);
assert.equal(udt.observed.total, MINT_AMOUNT.toString()); assert.equal(udt.observed.malformed.length, 0);
assert.equal(udt.ok, name !== "balance-short");
// Every retained indexer page is raw RPC output and carries no account secrets.
for (const claim of report.evidence.assertions) if (claim.input?.kind === "indexer") assert(claim.input.pages.length >= 1);
assert(!/privkey/i.test(await readFile(path, "utf8")));
console.log(path);
REPORT_AUDIT
}

verify_files() {
  bun - <<'FILES_CHECK'
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
const metadata = async path => {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const problems = [];
if (await metadata(".ckb-verify/offckb/accounts.json")) problems.push("development accounts remain");
async function visit(path) {
  const entry = await metadata(path);
  if (entry === null) return;
  if (!entry.isDirectory()) throw new Error(`unsupported evidence directory: ${path}`);
  for (const name of await readdir(path)) {
    const child = join(path, name), info = await lstat(child);
    if (info.isDirectory()) await visit(child);
    else if (!info.isFile() || info.nlink !== 1) problems.push(`unsupported evidence entry: ${child}`);
    else if (name === ".report.json.pending") problems.push(`pending report remains: ${child}`);
  }
}
await visit(".ckb-verify/runs");
if (problems.length) throw new Error(problems.join("; "));
FILES_CHECK
}

verify_ports() {
  bun - <<'PORTS_CHECK'
import { createServer } from "node:net";
const problems = [];
const probe = (host, port) => new Promise(resolve => {
  const server = createServer();
  server.once("error", error => resolve(error.code ?? "unavailable"));
  server.listen({ host, port, ipv6Only: true }, () => server.close(error => resolve(error ? "close failed" : null)));
});
let ipv6;
for (const port of [8114, 28114]) for (const host of ["0.0.0.0", "::"]) {
  const problem = await probe(host, port);
  if (problem === null) continue;
  if (host === "::" && problem !== "EADDRINUSE" && !(ipv6 ??= (await probe("::", 0)) === null)) continue;
  problems.push(`${host}:${port} ${problem}`);
}
if (problems.length) throw new Error(`ports not independently free: ${problems.join(", ")}`);
PORTS_CHECK
}

compare_repeat() {
  bun - "$@" <<'REPEAT_CHECK'
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { verifyReport } from "./src/report.ts";
const paths = process.argv.slice(2);
assert.equal(paths.length, 2);
assert.notEqual(await realpath(paths[0]), await realpath(paths[1]), "repeat must have a distinct canonical report");
const reports = [];
for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  verifyReport(report);
  assert.equal(report.schema, "ckb-verify-report/3"); assert.equal(report.verdict, "PASS");
  reports.push(report);
}
const [a, b] = reports;
// Balances aggregate every live Cell of a lock, including the fresh genesis Cells, so the outcome is
// repeatable only if the fresh devnets agree on those; the per-claim verdicts must repeat regardless.
assert.deepEqual(a.outcomeClaims.assertions.map(c => c.ok), b.outcomeClaims.assertions.map(c => c.ok));
assert.deepEqual(a.outcomeClaims.steps[0].claims.map(c => c.ok), b.outcomeClaims.steps[0].claims.map(c => c.ok));
console.log(JSON.stringify({ outcome: a.digests.outcome === b.digests.outcome ? "equal" : "differs", reports: paths,
  outcomes: reports.map(r => r.digests.outcome), environments: reports.map(r => r.digests.environment) }, null, 2));
REPEAT_CHECK
}

run_case() {
  local name=$1 output status report audit files ports
  output=$(run_fixture "showcases/vocabulary/verify.$name.toml" 2>&1); status=$?
  printf '%s\n' "$output"
  report=$(audit_report "$name" "$status" "$output"); audit=$?
  verify_files; files=$?
  verify_ports; ports=$?
  if (( audit != 0 || files != 0 || ports != 0 )); then
    printf 'case %s failed: cli=%s audit=%s files=%s ports=%s\n' "$name" "$status" "$audit" "$files" "$ports" >&2
    return 1
  fi
  LAST_REPORT=$report
}

closeout() {
  local status=$1 files ports
  trap - EXIT
  verify_files; files=$?
  verify_ports; ports=$?
  if (( files != 0 || ports != 0 )); then status=1; fi
  if (( status == 0 && ${ACCEPTANCE_READY:-0} == 1 )); then printf 'VOCABULARY DEVNET ACCEPTANCE PASS\n'; fi
  exit "$status"
}

main() {
  local first second name files ports
  trap 'closeout $?' EXIT
  verify_files; files=$?
  verify_ports; ports=$?
  (( files == 0 && ports == 0 )) || return 1
  run_case committed || return 1
  first=$LAST_REPORT
  for name in cycles-too-low wrong-data wrong-capacity balance-short; do
    run_case "$name" || return 1
  done
  run_case committed || return 1
  second=$LAST_REPORT
  compare_repeat "$first" "$second" || return 1
  ACCEPTANCE_READY=1
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
