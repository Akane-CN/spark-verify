#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
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

committed_one=$(run_fixture fixtures/secp-transfer/verify.committed.toml)
printf '%s\n' "$committed_one"
[[ $committed_one == PASS:* ]]

rejected=$(run_fixture fixtures/secp-transfer/verify.rejected.toml)
printf '%s\n' "$rejected"
[[ $rejected == PASS:* ]]

set +e
assertion_failure=$(run_fixture fixtures/secp-transfer/verify.assertion-failure.toml 2>&1)
assertion_status=$?
set -e
printf '%s\n' "$assertion_failure"
if [[ $assertion_status -ne 1 || $assertion_failure != FAIL:* ]]; then
  printf 'expected assertion fixture to return FAIL with exit code 1, got %s\n' "$assertion_status" >&2
  exit 1
fi

committed_two=$(run_fixture fixtures/secp-transfer/verify.committed.toml)
printf '%s\n' "$committed_two"
[[ $committed_two == PASS:* ]]

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

printf 'DEVNET ACCEPTANCE PASS\n'
printf 'stable outcome: %s\n' "$outcome_one"
printf 'stable environment: %s\n' "$environment_one"
