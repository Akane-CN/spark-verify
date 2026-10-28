#!/usr/bin/env bash
# One non-publishing maintenance cycle: frozen tree, dependency gate, regression, docs, pack with
# checksums, and optionally the installed-consumer acceptance matrix. Writes a Markdown record.
# Never tags, never publishes, never pushes.
set -uo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1
CONSUMER=0; OUT="rehearsal-$(date -u +%Y%m%dT%H%M%SZ).md"
while (( $# > 0 )); do
  case $1 in
    --consumer) CONSUMER=1 ;;
    --out) OUT=$2; shift ;;
    *) printf 'usage: %s [--consumer] [--out <file>]\n' "$0" >&2; exit 2 ;;
  esac
  shift
done
ROWS=(); FAILED=0
step() { # name command...
  local name=$1; shift
  local log; log=$(mktemp)
  local start; start=$(date +%s)
  if "$@" >"$log" 2>&1; then ROWS+=("| $name | \`$*\` | PASS | $(( $(date +%s) - start ))s |"); printf '[PASS] %s\n' "$name"
  else ROWS+=("| $name | \`$*\` | FAIL | $(( $(date +%s) - start ))s |"); printf '[FAIL] %s\n' "$name"; tail -20 "$log"; FAILED=1; fi
  rm -f "$log"
}
HEAD=$(git rev-parse HEAD)
if [[ -n $(git status --porcelain) ]]; then echo "working tree is not clean; a rehearsal needs a frozen candidate"; exit 1; fi
step frozen-tree git status --porcelain
step dependency-install bun install --frozen-lockfile
step supply-chain-gate bun run check:supply-chain
step regression bun run check
step documentation ./scripts/validate-docs.sh --examples
step showcase-secp-transfer bun run showcase:secp-transfer
rm -rf dist && mkdir -p dist
step pack bun pm pack --destination dist
(cd dist && sha256sum ./*.tgz > SHA256SUMS)
VERSION=$(bun run src/cli.ts --version)
TGZ=$(ls dist/*.tgz 2>/dev/null | head -1)
if (( CONSUMER )); then step consumer-acceptance scripts/acceptance-matrix.sh --consumer --results dist/acceptance-consumer.md; fi
{
  printf '# Release rehearsal (no publication)\n\n'
  printf -- '- candidate: `%s`\n- version: `%s`\n- platform: %s %s, bun %s, node %s\n- tarball: `%s`\n- tarball sha256: `%s`\n- date: %s\n\n' \
    "$HEAD" "$VERSION" "$(uname -s)" "$(uname -m)" "$(bun --version)" "$(node --version)" "${TGZ:-none}" \
    "$( [[ -n $TGZ ]] && sha256sum "$TGZ" | cut -d' ' -f1 || echo none)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '| step | command | result | time |\n| --- | --- | --- | --- |\n%s\n' "$(printf '%s\n' "${ROWS[@]}")"
  if (( CONSUMER )) && [[ -f dist/acceptance-consumer.md ]]; then printf '\n## Installed-consumer acceptance\n\n'; cat dist/acceptance-consumer.md; fi
  printf '\nNo tag, release, or package was published by this rehearsal.\n'
} > "$OUT"
printf '\nrecord: %s\n' "$OUT"
(( FAILED )) && { echo "REHEARSAL FAILED"; exit 1; }
echo "REHEARSAL PASS"
