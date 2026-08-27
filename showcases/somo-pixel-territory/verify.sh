#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

run_fixture() {
  local manifest=$1
  bun run src/cli.ts run "$manifest"
}

extract_digest() {
  local label=$1
  local output=$2
  local line
  while IFS= read -r line; do
    if [[ $line == "$label: "* ]]; then
      printf '%s\n' "${line#"$label: "}"
      return 0
    fi
  done <<<"$output"
  printf 'missing %s digest in output\n' "$label" >&2
  return 1
}

extract_report() {
  local output=$1
  local line
  while IFS= read -r line; do
    if [[ $line == "report: "* ]]; then
      printf '%s\n' "${line#"report: "}"
      return 0
    fi
  done <<<"$output"
  printf 'missing report path in output\n' >&2
  return 1
}

verify_report() {
  local output=$1
  local report
  report=$(extract_report "$output")
  bun -e '
    import { readFile } from "node:fs/promises";
    import { verifyEvidenceDigests } from "./src/report.ts";
    const path = process.argv[1];
    if (path === undefined) throw new Error("missing report path");
    const report = JSON.parse(await readFile(path, "utf8"));
    verifyEvidenceDigests(report);
  ' "$report"
}

verify_dynamic_scripts() {
  local output=$1
  local report
  report=$(extract_report "$output")
  bun -e '
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { dirname, join } from "node:path";

    const reportPath = process.argv[1];
    if (reportPath === undefined) throw new Error("missing report path");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const stepName = report.evidence.steps[0]?.name;
    if (typeof stepName !== "string") throw new Error("report has no first step name");
    const transaction = JSON.parse(
      await readFile(join(dirname(reportPath), "steps", `01-${stepName}`, "transaction.json"), "utf8"),
    );
    const cluster = report.environment.systemScripts.spore_cluster;
    const anyoneCanPay = report.environment.systemScripts.anyone_can_pay;
    const output = transaction.outputs[0];

    assert.equal(output.lock.code_hash, anyoneCanPay.codeHash);
    assert.equal(output.lock.hash_type, anyoneCanPay.hashType);
    assert.match(output.lock.args, /^0x[0-9a-f]{40}$/);
    assert.equal(output.type.code_hash, cluster.codeHash);
    assert.equal(output.type.hash_type, cluster.hashType);

    assert.notEqual(transaction.outputs_data[0], "0x");
    const assertDeps = (label, expectedDeps) => {
      for (const expected of expectedDeps) {
        const expectedIndex = `0x${BigInt(expected.outPoint.index).toString(16)}`;
        const expectedType = expected.depType === "depGroup" ? "dep_group" : expected.depType;
        assert.ok(transaction.cell_deps.some((actual) =>
          actual.out_point.tx_hash === expected.outPoint.txHash
            && actual.out_point.index === expectedIndex
            && actual.dep_type === expectedType
        ), `fresh OffCKB ${label} CellDep is missing from the transaction`);
      }
    };
    assertDeps("Cluster", cluster.cellDeps);
    assertDeps("ACP", anyoneCanPay.cellDeps);
  ' "$report"
}

verify_cleanup() {
  local accounts=.ckb-verify/offckb/accounts.json
  if [[ -e $accounts ]]; then
    printf 'OffCKB development account file remains after the run: %s\n' "$accounts" >&2
    return 1
  fi

  if compgen -G '.ckb-verify/runs/*/.report.json.pending' >/dev/null; then
    printf 'pending evidence report remains after the run\n' >&2
    return 1
  fi

  bun -e '
    import { createConnection } from "node:net";

    const isListening = (port) => new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (listening) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(listening);
      };
      socket.setTimeout(250, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });

    const open = [];
    for (const port of [8114, 28114]) {
      if (await isListening(port)) open.push(port);
    }
    if (open.length > 0) {
      console.error(`OffCKB listener remains after the run: ${open.join(", ")}`);
      process.exit(1);
    }
  '
}

committed_one=$(run_fixture showcases/somo-pixel-territory/verify.committed.toml)
printf '%s\n' "$committed_one"
[[ $committed_one == PASS:* ]]
verify_report "$committed_one"
verify_dynamic_scripts "$committed_one"
verify_cleanup

rejected=$(run_fixture showcases/somo-pixel-territory/verify.rejected.toml)
printf '%s\n' "$rejected"
[[ $rejected == PASS:* ]]
verify_report "$rejected"
verify_dynamic_scripts "$rejected"
verify_cleanup

set +e
assertion_failure=$(run_fixture showcases/somo-pixel-territory/verify.assertion-failure.toml 2>&1)
assertion_status=$?
set -e
printf '%s\n' "$assertion_failure"
if [[ $assertion_status -ne 1 || $assertion_failure != FAIL:* ]]; then
  printf 'expected assertion fixture to return FAIL with exit code 1, got %s\n' "$assertion_status" >&2
  exit 1
fi
verify_report "$assertion_failure"
verify_dynamic_scripts "$assertion_failure"
verify_cleanup

committed_two=$(run_fixture showcases/somo-pixel-territory/verify.committed.toml)
printf '%s\n' "$committed_two"
[[ $committed_two == PASS:* ]]
verify_report "$committed_two"
verify_dynamic_scripts "$committed_two"
verify_cleanup

outcome_one=$(extract_digest outcome "$committed_one")
outcome_two=$(extract_digest outcome "$committed_two")
environment_one=$(extract_digest environment "$committed_one")
environment_two=$(extract_digest environment "$committed_two")

if [[ $outcome_one != "$outcome_two" ]]; then
  printf 'committed outcome digest drifted:\n  %s\n  %s\n' "$outcome_one" "$outcome_two" >&2
  exit 1
fi
if [[ $environment_one != "$environment_two" ]]; then
  printf 'committed environment digest drifted:\n  %s\n  %s\n' "$environment_one" "$environment_two" >&2
  exit 1
fi

printf 'SOMO DEVNET ACCEPTANCE PASS\n'
printf 'stable outcome: %s\n' "$outcome_one"
printf 'stable environment: %s\n' "$environment_one"
