#!/usr/bin/env bash
# Trusted-code harness for the spec 0.2.0 repository-script showcase: the runner deploys a lock script built
# from this repository, and every case below checks the verdict, the exit code, the offline verification,
# the published schema, cleanup, and the case's own evidence. Each status is collected before deciding.
set -uo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT" || exit 1
DIR=showcases/repository-script

run_fixture() {
  timeout --signal=INT --kill-after=15s 420s bun run src/cli.ts run "$1"
}

audit_report() {
  bun - "$@" <<'REPORT_AUDIT'
import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { verifyReport } from "./src/report.ts";
import { REPORT_SCHEMA_ID, schemaProblems } from "./src/schemas.ts";
const [name, exit, output, manifest] = process.argv.slice(2);
const expected = { committed: 0, rejected: 0, "wrong-group": 1, "node-rejected": 0, "node-rejected-code": 1, zero: 0, variant: 0 }[name];
assert.notEqual(expected, undefined, `unknown case ${name}`);
assert.equal(Number(exit), expected, "unexpected CLI exit");
assert(output.startsWith(expected === 0 ? "PASS: All declared claims passed in the recorded environment.\n" : "FAIL:"));
const field = (label) => {
  const lines = output.split("\n").filter((line) => line.startsWith(`${label}: `));
  assert.equal(lines.length, 1, `exactly one ${label} handle required`);
  return lines[0].slice(label.length + 2);
};
const path = field("report"), metadata = await lstat(path);
assert.equal(basename(path), "report.json");
assert(metadata.isFile() && metadata.nlink === 1, "canonical report must be a regular unlinked file");
const text = await readFile(path, "utf8"), report = JSON.parse(text);
verifyReport(report);
assert.deepEqual(schemaProblems(REPORT_SCHEMA_ID, report), []);
assert.equal(report.schema, "ckb-verify-report/4"); assert.equal(report.outcomeClaims.spec, "0.2.0");
assert.equal(report.environment.schema, "ckb-verify-environment/5"); assert.equal(report.environment.provenance.schema, "ckb-verify-provenance/4");
assert.equal(report.verdict, expected === 0 ? "PASS" : "FAIL");
assert.equal(report.digests.outcome, field("outcome")); assert.equal(report.digests.environment, field("environment"));
assert.equal(report.evidence.manifestText, await readFile(manifest, "utf8"));
assert.equal(report.environment.devnet.sealing.fingerprint, report.environment.provenance.devnet.defaultSealingFingerprint, "default sealing");
const steps = report.outcomeClaims.steps, scripts = report.outcomeClaims.setup.scripts;
const byName = Object.fromEntries(steps.map((s) => [s.name, s]));
assert.equal(scripts[0].name, "witness_lock"); assert.equal(scripts[0].kind, "binary");
const deployed = report.environment.devnet.scripts;
for (const s of deployed) if (s.kind === "binary") assert(s.size > 0 && s.cellDep.depType === "code");
if (name === "committed" || name === "variant") {
  assert.deepEqual(steps.map((s) => s.kind), ["pure", "transaction", "transaction"]);
  assert.equal(scripts[0].hashType, "type"); assert.notEqual(scripts[0].codeHash, scripts[0].dataHash);
  assert.equal(scripts[1].hashType, "data1"); assert.equal(scripts[1].codeHash, scripts[1].dataHash);
  assert.equal(scripts[2].kind, "builtin");
  assert.equal(byName["spend with matching witness"].observedStatus, "committed");
  assert(byName["spend with matching witness"].cycles > 0);
}
if (name === "rejected" || name === "wrong-group") {
  const s = byName["spend with wrong witness"];
  assert.equal(s.observedStatus, "rejected"); assert.equal(s.rejection.kind, "script"); assert.equal(s.rejection.code, 42);
  assert.equal(s.rejection.role, "lock"); assert.equal(s.rejection.script.codeHash, scripts[0].codeHash);
  assert.equal(report.evidence.steps[1].inputCells.length, 1);
  const groupMatches = s.expectedErrorGroup.resolved.codeHash === s.rejection.script.codeHash;
  assert.equal(groupMatches, name === "rejected", "the group pin decides this case");
}
if (name === "node-rejected" || name === "node-rejected-code") {
  const s = byName["spend the spent cell again"];
  assert.equal(s.observedStatus, "rejected"); assert.equal(s.rejection.kind, "node"); assert.equal(s.rejection.rpcCode, -301);
  assert.equal(s.expectedErrorCode, name === "node-rejected-code" ? 42 : undefined);
}
if (name === "zero") {
  assert.equal(report.outcomeClaims.setup.accounts, 0); assert.deepEqual(steps, []);
  assert.deepEqual(report.environment.devnet.accounts, []);
  assert.equal(scripts[0].hashType, "data2"); assert.equal(scripts[0].codeHash, scripts[0].dataHash);
}
assert.equal(report.environment.provenance.replay.status, "stable", JSON.stringify(report.environment.provenance.replay.reasons));
assert(!/privkey/i.test(text));
console.log(path);
REPORT_AUDIT
}

verify_files() {
  bun - <<'FILES_CHECK'
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
const metadata = async (path) => { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
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
const probe = (host, port) => new Promise((resolve) => {
  const server = createServer();
  server.once("error", (error) => resolve(error.code ?? "unavailable"));
  server.listen({ host, port, ipv6Only: true }, () => server.close((error) => resolve(error ? "close failed" : null)));
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

run_case() {
  local name=$1 manifest=${2:-$DIR/verify.$1.toml} output status report audit files ports
  output=$(run_fixture "$manifest" 2>&1); status=$?
  printf '%s\n' "$output"
  report=$(audit_report "$name" "$status" "$output" "$manifest"); audit=$?
  verify_files; files=$?
  verify_ports; ports=$?
  if (( audit != 0 || files != 0 || ports != 0 )); then
    printf 'case %s failed: cli=%s audit=%s files=%s ports=%s\n' "$name" "$status" "$audit" "$files" "$ports" >&2
    return 1
  fi
  LAST_REPORT=$report
}

# A case that must end without a verdict: exit 2, an ERROR line, and no report written anywhere.
run_no_verdict() {
  local name=$1 manifest=$2 pattern=$3 output status before after
  before=$(find .ckb-verify/runs -name report.json 2>/dev/null | wc -l)
  output=$(run_fixture "$manifest" 2>&1); status=$?
  printf '%s\n' "$output"
  after=$(find .ckb-verify/runs -name report.json 2>/dev/null | wc -l)
  if (( status != 2 )) || ! grep -q "$pattern" <<<"$output" || (( after != before )); then
    printf 'case %s failed: exit=%s reports %s->%s\n' "$name" "$status" "$before" "$after" >&2
    return 1
  fi
  verify_files && verify_ports
}

compare_reports() {
  bun - "$@" <<'COMPARE'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const [mode, ...paths] = process.argv.slice(2);
const [a, b, c] = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
// Two fresh devnets, same manifest and source: both digests repeat exactly.
assert.equal(a.digests.outcome, b.digests.outcome, "repeat outcome digest");
assert.equal(a.digests.environment, b.digests.environment, "repeat environment digest");
// A different binary under the same manifest text and name: the outcome digest changes, and only
// through the setup scripts' hashes and the code hashes they resolve to.
assert.notEqual(a.digests.outcome, c.digests.outcome, "a different binary must change the outcome digest");
assert.notEqual(a.outcomeClaims.setup.scripts[0].binarySha256, c.outcomeClaims.setup.scripts[0].binarySha256);
assert.deepEqual(a.outcomeClaims.steps.map((s) => s.claims.map((x) => x.ok)), c.outcomeClaims.steps.map((s) => s.claims.map((x) => x.ok)));
console.log(JSON.stringify({ mode, repeatOutcome: a.digests.outcome, repeatEnvironment: a.digests.environment, variantOutcome: c.digests.outcome }, null, 2));
COMPARE
}

closeout() {
  local status=$1 files ports
  trap - EXIT
  rm -rf "${TEMP:-}"
  verify_files; files=$?
  verify_ports; ports=$?
  if (( files != 0 || ports != 0 )); then status=1; fi
  if (( status == 0 && ${ACCEPTANCE_READY:-0} == 1 )); then printf 'REPOSITORY-SCRIPT DEVNET ACCEPTANCE PASS\n'; fi
  exit "$status"
}

main() {
  local first second variant name files ports
  trap 'closeout $?' EXIT
  TEMP=$(mktemp -d)
  verify_files; files=$?
  verify_ports; ports=$?
  (( files == 0 && ports == 0 )) || return 1
  bun run "$DIR/lock/build.ts" --check || return 1
  run_case committed || return 1
  first=$LAST_REPORT
  for name in rejected wrong-group node-rejected node-rejected-code zero; do
    run_case "$name" || return 1
  done
  run_no_verdict pure-writes-result "$DIR/verify.pure-writes-result.toml" "wrote CKB_VERIFY_RESULT" || return 1
  # Manifests outside the repository keep the source tree clean: the same text with a different binary
  # path, and a binary that does not exist (refused before any devnet starts).
  sed 's#build/witness_lock"#build/witness_lock_variant"#' "$DIR/verify.committed.toml" >"$TEMP/variant.toml"
  sed 's#build/witness_lock"#build/no_such_binary"#' "$DIR/verify.committed.toml" >"$TEMP/missing.toml"
  run_no_verdict missing-binary "$TEMP/missing.toml" "does not exist" || return 1
  run_case committed || return 1
  second=$LAST_REPORT
  run_case variant "$TEMP/variant.toml" || return 1
  variant=$LAST_REPORT
  compare_reports repeat-and-variant "$first" "$second" "$variant" || return 1
  ACCEPTANCE_READY=1
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
