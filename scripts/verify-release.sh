#!/usr/bin/env bash
# The release verification surface promised in docs/spark-proposal.md §8.B, run from a clean checkout:
# validate the included manifests, run the repository-root verify.toml, prove the positive, failing and
# script-rejection paths, repeat the clean case, show that equal outcomes do not imply equal environments,
# and recompute every report's digests offline. Writes a Markdown record. Never tags, publishes or pushes.
set -uo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1
OUT="verify-release-$(date -u +%Y%m%dT%H%M%SZ).md"
while (( $# > 0 )); do
  case $1 in
    --out) OUT=$2; shift ;;
    *) printf 'usage: %s [--out <file>]\n' "$0" >&2; exit 2 ;;
  esac
  shift
done
CLI=(bun run src/cli.ts)
ROWS=(); FAILED=0; PENDING=0
row() { ROWS+=("| $1 | $2 | $3 |"); printf '[%s] %s: %s\n' "$2" "$1" "$3"; [[ $2 == FAIL ]] && FAILED=1; [[ $2 == PENDING ]] && PENDING=$((PENDING + 1)); }
field() { # label text -> value of "label: value" line
  local line
  while IFS= read -r line; do
    if [[ $line == "$1: "* ]]; then printf '%s\n' "${line#"$1: "}"; return 0; fi
  done <<<"$2"
  return 1
}
report_field() { # report.json js-expression
  bun -e 'const r = JSON.parse(await Bun.file(process.argv[1]).text()); console.log(JSON.stringify(eval(process.argv[2])));' "$1" "$2"
}
MARKER=.verify-release-dirty-marker
trap 'rm -f "$MARKER"' EXIT
if [[ -n $(git status --porcelain) ]]; then echo "working tree is not clean; the release surface runs from a frozen checkout"; exit 1; fi
HEAD=$(git rev-parse HEAD)

# 1. validate every included manifest without executing anything
INVALID=()
for m in verify.toml showcases/*/verify*.toml; do "${CLI[@]}" validate "$m" >/dev/null 2>&1 || INVALID+=("$m"); done
if (( ${#INVALID[@]} == 0 )); then row "1 validate manifests" PASS "$(ls verify.toml showcases/*/verify*.toml | wc -l | tr -d ' ') manifests valid, nothing executed"
else row "1 validate manifests" FAIL "invalid: ${INVALID[*]}"; fi

# 2+3. run the repository-root manifest (dogfood) with the CLI from this checkout; PASS, exit 0
POSITIVE=$("${CLI[@]}" run verify.toml 2>&1); S=$?
POSITIVE_REPORT=$(field report "$POSITIVE" || true)
if [[ $S -eq 0 && $POSITIVE == PASS:* && -f $POSITIVE_REPORT && $(report_field "$POSITIVE_REPORT" 'r.verdict') == '"PASS"' ]]; then
  row "2 root verify.toml with this checkout's CLI" PASS "exit 0, verdict PASS, $POSITIVE_REPORT"
  row "3 positive example" PASS "verdict PASS, outcome $(field outcome "$POSITIVE")"
else row "2 root verify.toml with this checkout's CLI" FAIL "exit $S: $(printf '%s' "$POSITIVE" | tail -3 | tr '\n' ' ')"; row "3 positive example" FAIL "see 2"; fi

# 4. intentionally failing claim: exit 1 with a field-level expected/observed diff
FAILING=$("${CLI[@]}" run showcases/secp-transfer/verify.assertion-failure.toml 2>&1); S=$?
if [[ $S -eq 1 && $FAILING == FAIL:* && $FAILING == *"failed: "*"expected: "*"observed: "* ]]; then
  row "4 failing claim" PASS "exit 1; $(printf '%s' "$FAILING" | grep -c '^failed: ') failed field(s) printed with expected/observed"
else row "4 failing claim" FAIL "exit $S: $(printf '%s' "$FAILING" | tail -3 | tr '\n' ' ')"; fi
FAILING_REPORT=$(field report "$FAILING" || true)

# 5. script rejection with the expected group and error code
REJECTED=$("${CLI[@]}" run showcases/secp-transfer/verify.rejected.toml 2>&1); S=$?
REJECTED_REPORT=$(field report "$REJECTED" || true)
if [[ $S -eq 0 && $REJECTED == PASS:* && -f $REJECTED_REPORT ]]; then
  REJ=$(report_field "$REJECTED_REPORT" 'r.evidence.steps[0].rejection')
  CODE=$(report_field "$REJECTED_REPORT" 'r.evidence.steps[0].rejection.code')
  ROLE=$(report_field "$REJECTED_REPORT" 'r.evidence.steps[0].rejection.role')
  SCRIPT=$(report_field "$REJECTED_REPORT" 'r.evidence.steps[0].rejection.script.codeHash')
  if [[ $CODE == -11 && $ROLE == '"lock"' && $SCRIPT == '"0x'* ]]; then row "5 script rejection" PASS "code $CODE, group role $ROLE, script $SCRIPT"
  else row "5 script rejection" FAIL "rejection evidence $REJ"; fi
else row "5 script rejection" FAIL "exit $S: $(printf '%s' "$REJECTED" | tail -3 | tr '\n' ' ')"; fi

# 6. the clean positive case twice: equal outcome digests and environment fingerprints
SECOND=$("${CLI[@]}" run verify.toml 2>&1); S=$?
SECOND_REPORT=$(field report "$SECOND" || true)
if [[ $S -eq 0 && $(field outcome "$POSITIVE") == $(field outcome "$SECOND") && $(field environment "$POSITIVE") == $(field environment "$SECOND") ]]; then
  row "6 repeated clean run" PASS "outcome and environment digests equal across two fresh devnets"
else row "6 repeated clean run" FAIL "exit $S; outcome $(field outcome "$SECOND" || echo none) env $(field environment "$SECOND" || echo none)"; fi

# 7. tool-version drift: hard-fail by default, explicit allowance changes the fingerprint and taints replay
row "7 tool-version drift" PENDING "run --allow-version-drift is not implemented (RFC implementation matrix §2); the default hard-fail is exercised by the parser and setup pins"

# 8. equal outcomes must not imply equal environments: the same manifest on a dirty tree
printf 'created by scripts/verify-release.sh to demonstrate a dirty source tree\n' > "$MARKER"
DIRTY=$("${CLI[@]}" run verify.toml 2>&1); S=$?
rm -f "$MARKER"
DIRTY_REPORT=$(field report "$DIRTY" || true)
if [[ $S -eq 0 && $(field outcome "$POSITIVE") == $(field outcome "$DIRTY") && $(field environment "$POSITIVE") != $(field environment "$DIRTY") &&
      $(report_field "$DIRTY_REPORT" 'r.environment.provenance.replay.status') == '"tainted"' &&
      $(report_field "$DIRTY_REPORT" 'r.environment.provenance.replay.reasons.map(x => x.code).join(",")') == '"dirty_source"' ]]; then
  row "8 cross-environment case" PASS "equal outcome, different environment fingerprint, replay tainted: dirty_source"
else row "8 cross-environment case" FAIL "exit $S; outcome $(field outcome "$DIRTY" || echo none) env $(field environment "$DIRTY" || echo none)"; fi

# 9. recompute both hashes of every report offline
BAD=()
for r in "$POSITIVE_REPORT" "$FAILING_REPORT" "$REJECTED_REPORT" "$SECOND_REPORT" "$DIRTY_REPORT"; do
  [[ -f $r ]] || { BAD+=("missing:$r"); continue; }
  "${CLI[@]}" digest "$r" >/dev/null 2>&1 || BAD+=("$r")
done
if (( ${#BAD[@]} == 0 )); then row "9 recompute report hashes" PASS "5 reports re-derived offline (digest exit 0), including the FAIL report"
else row "9 recompute report hashes" FAIL "${BAD[*]}"; fi

{
  printf '# Release verification surface (no publication)\n\n'
  printf -- '- candidate: `%s`\n- version: `%s`\n- platform: %s %s, bun %s, node %s\n- date: %s\n\n' \
    "$HEAD" "$("${CLI[@]}" --version)" "$(uname -s)" "$(uname -m)" "$(bun --version)" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '| item | result | detail |\n| --- | --- | --- |\n%s\n' "$(printf '%s\n' "${ROWS[@]}")"
  printf '\nThe root manifest is dogfooding, not independent proof. Reports stay under `.ckb-verify/runs/`; nothing was tagged or published.\n'
} > "$OUT"
printf '\nrecord: %s\n' "$OUT"
if (( FAILED )); then echo "VERIFY RELEASE FAIL"; exit 1; fi
echo "VERIFY RELEASE PASS (pending items: $PENDING)"
