#!/usr/bin/env bash
# Trusted-code harness. Each status is collected before deciding case success.
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
const [name, exit, output] = process.argv.slice(2);
assert(["committed", "wrong-type", "wrong-data", "missing-dep", "ordinary-cell", "wrong-args"].includes(name));
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
assert.equal(report.schema, "ckb-verify-report/2");
assert.equal(report.verdict, positive ? "PASS" : "FAIL");
assert.equal(report.digests.outcome, field("outcome"));
assert.equal(report.digests.environment, field("environment"));
assert.equal(report.evidence.manifestText, await readFile(`showcases/cell-properties/verify.${name}.toml`, "utf8"));
assert.equal(report.evidence.steps.length, 1);
assert.equal(report.evidence.assertions.length, 0);
const step = report.evidence.steps[0], [cell, deps] = step.claims;
assert.equal(step.name, "deposit");
assert.equal(step.expectedStatus, "committed");
assert.equal(step.observedStatus, "committed");
assert.equal(step.claims.length, 2);
assert.equal(cell.kind, "cell"); assert.equal(deps.kind, "cell_deps");
assert.equal(cell.observationValid, true);
assert.equal(cell.observed.state, "live"); assert.equal(cell.observed.count, 1);
assert.equal(cell.expected.count, 1);
assert.deepEqual(cell.target, { step: "deposit", index: 0 });
assert.deepEqual(deps.target, { step: "deposit" });
assert.deepEqual(deps.expected.contains, { kind: "builtin", name: "dao" });
const plain = name === "missing-dep" || name === "ordinary-cell";
const tx = step.transaction, outputCell = tx.outputs[0];
assert.equal(BigInt(outputCell.capacity), BigInt(plain ? 100 : 200) * 100_000_000n);
assert.equal(tx.outputs_data[0], plain ? "0x" : "0x0000000000000000");
assert(deps.observed.present.length > 0);
assert(deps.observed.present.every(present => present === !plain));
assert.equal(deps.ok, !plain);
if (plain) {
  assert.equal(outputCell.type ?? null, null);
  if (name === "missing-dep") {
    assert.equal(cell.ok, true);
    assert.deepEqual(cell.expected, { count: 1 });
    assert.deepEqual(cell.observed, { state: "live", count: 1 });
  } else {
    assert.equal(cell.ok, false);
    assert.equal(cell.observed.type, null); assert.equal(cell.observed.dataBytes, 0);
  }
} else {
  const dao = report.environment.devnet.systemScripts.dao;
  assert.deepEqual(outputCell.type, { code_hash: dao.codeHash, hash_type: dao.hashType, args: "0x" });
  assert.equal(cell.observed.type.argsBytes, 0); assert.equal(cell.observed.dataBytes, 8);
  assert.equal(cell.ok, positive);
  if (name === "wrong-type") {
    assert.equal(cell.observed.type.identity.kind, "raw");
    assert.equal(cell.expected.type.name, "spore");
    assert.equal(cell.expected.type.argsBytes, 0); assert.equal(cell.expected.data.minBytes, 1);
  } else {
    assert.deepEqual(cell.observed.type.identity, { kind: "builtin", name: "dao" });
    assert.equal(cell.expected.type.argsBytes, name === "wrong-args" ? 1 : 0);
    assert.equal(cell.expected.data.minBytes, name === "wrong-data" ? 9 : 1);
  }
}
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
// Bun reports an unavailable address family without an errno code, so a failed
// "::" probe counts as a listener only when IPv6 can bind at all (same rule as
// the runner preflight in src/runtime-ownership.ts).
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
import { canonicalSha256 } from "./src/canonical.ts";
const paths = process.argv.slice(2);
assert.equal(paths.length, 2);
assert.notEqual(await realpath(paths[0]), await realpath(paths[1]), "repeat must have a distinct canonical report");
const reports = [];
for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  verifyReport(report);
  assert.equal(report.schema, "ckb-verify-report/2"); assert.equal(report.verdict, "PASS");
  reports.push(report);
}
const [a, b] = reports;
assert.equal(a.digests.outcome, b.digests.outcome, "committed outcome drift");
// Compare unchanged provenance separately; do not scrub or rehash either artifact.
const { devnet: firstDevnet, ...firstInputs } = a.environment;
const { devnet: secondDevnet, ...secondInputs } = b.environment;
assert.deepEqual(firstInputs, secondInputs, "non-devnet environment drift");
assert.equal(firstDevnet.network, secondDevnet.network);
const sameBindings = canonicalSha256(firstDevnet) === canonicalSha256(secondDevnet);
if (sameBindings) assert.equal(a.digests.environment, b.digests.environment, "repeated environment drift");
else assert.notEqual(a.digests.environment, b.digests.environment, "distinct environments must not be hidden");
console.log(JSON.stringify({ comparison: sameBindings ? "equal-environment" : "recorded-devnet-difference",
  outcome: a.digests.outcome, reports: paths, environments: reports.map(report => ({
    digest: report.digests.environment, devnet: report.environment.devnet })) }, null, 2));
REPEAT_CHECK
}

run_case() {
  local name=$1 output status report audit files ports
  output=$(run_fixture "showcases/cell-properties/verify.$name.toml" 2>&1); status=$?
  printf '%s\n' "$output"
  report=$(audit_report "$name" "$status" "$output"); audit=$?
  # Never let secondary parsing/auditing skip either independent closeout check.
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
  if (( status == 0 && ${ACCEPTANCE_READY:-0} == 1 )); then
    printf 'CELL-PROPERTIES DEVNET ACCEPTANCE PASS\n'
  fi
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
  for name in wrong-type wrong-data missing-dep ordinary-cell wrong-args; do
    run_case "$name" || return 1
  done
  run_case committed || return 1
  second=$LAST_REPORT
  compare_repeat "$first" "$second" || return 1
  ACCEPTANCE_READY=1
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
