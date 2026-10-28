#!/usr/bin/env bash
# Repository-owned acceptance matrix: real ckb-verify processes on fresh OffCKB devnets, covering the
# scenarios unit tests cannot (cold/warm caches, concurrency, occupied ports, interruption, producer
# timeout, tampered debugger cache, download failure, offline re-verification). Source mode runs the
# checkout's CLI; --consumer packs the package, installs it into a clean separate project, proves the
# OffCKB patch gate, and runs the same matrix with the installed binary. Linux x64 / Bun 1.2.19 only.
set -uo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODE=source; RESULTS=""; KEEP=0
while (( $# > 0 )); do
  case $1 in
    --consumer) MODE=consumer ;;
    --results) RESULTS=$2; shift ;;
    --keep) KEEP=1 ;;
    *) printf 'usage: %s [--consumer] [--results <file>] [--keep]\n' "$0" >&2; exit 2 ;;
  esac
  shift
done
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ckb-verify-acceptance-XXXXXX")
cleanup_work() { (( KEEP )) || rm -rf "$WORK"; }
trap cleanup_work EXIT
ROWS=(); FAILED=0
record() { # name expected observed status
  ROWS+=("| $1 | $2 | $3 | $4 |"); printf '[%s] %s: %s (expected %s)\n' "$4" "$1" "$3" "$2"
  [[ $4 == PASS || $4 == NOTE ]] || FAILED=1
}
runner() { timeout --signal=INT --kill-after=15s 420s "${CLI[@]}" "$@"; }
run_manifest() { # manifest -> sets OUT STATUS REPORT OUTCOME ENVIRONMENT
  OUT=$(cd "$PROJECT" && runner run "$1" 2>&1); STATUS=$?
  REPORT=$(printf '%s\n' "$OUT" | sed -n 's/^report: //p' | head -1)
  OUTCOME=$(printf '%s\n' "$OUT" | sed -n 's/^outcome: //p' | head -1)
  ENVIRONMENT=$(printf '%s\n' "$OUT" | sed -n 's/^environment: //p' | head -1)
}
report_count() { find "$PROJECT/.ckb-verify/runs" -name report.json 2>/dev/null | wc -l; }
closeout_ok() { # accounts absent, no pending, both ports free
  [[ ! -e $PROJECT/.ckb-verify/offckb/accounts.json ]] || { echo "accounts.json remains"; return 1; }
  ! compgen -G "$PROJECT/.ckb-verify/runs/*/.report.json.pending" >/dev/null || { echo "pending report remains"; return 1; }
  bun -e 'import { createServer } from "node:net";
    for (const port of [8114, 28114]) await new Promise((resolve, reject) => {
      const s = createServer(); s.once("error", reject); s.listen({ host: "0.0.0.0", port }, () => s.close(resolve)); });' 2>&1 || { echo "port still bound"; return 1; }
}
field() { bun -e 'const r = JSON.parse(await Bun.file(process.argv[1]).text()); console.log(String(process.argv[2].split(".").reduce((v, k) => v?.[k], r)));' "$1" "$2"; }
port_listening() { bun -e 'import { createConnection } from "node:net"; const s = createConnection({ host: process.argv[2] ?? "127.0.0.1", port: Number(process.argv[1]) });
  s.setTimeout(300, () => { s.destroy(); process.exit(1); }); s.once("connect", () => { s.destroy(); process.exit(0); }); s.once("error", () => process.exit(1));' "$1" "${2:-127.0.0.1}"; }
wait_for_port() { local i; for i in $(seq 1 240); do port_listening "$1" && return 0; sleep 0.5; done; return 1; }

write_manifests() { # dir producer-prefix
  local dir=$1 prefix=$2
  local head='[meta]
name = "NAME"
spec = "0.1.0-draft.4"
description = "acceptance matrix fixture"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
DEBUGGER
[replay]
dependencies = []

[setup]
accounts = 2
'
  m() { printf '%s' "$head" | sed "s/NAME/$1/; s/^DEBUGGER$/$2/"; }
  { m matrix-committed ""; printf '\n[[step]]\nname = "transfer"\nrun = "%s committed"\ntimeout = "60s"\nexpect.tx = "committed"\n\n[[step.assert.cell]]\nout_point = { step = "transfer", index = 0 }\ncount = 1\n' "$prefix"; } > "$dir/committed.toml"
  { m matrix-rejected 'ckb-debugger = "1.1.1"'; printf '\n[[step]]\nname = "bad-signature"\nrun = "%s rejected"\ntimeout = "60s"\nexpect.tx = "rejected"\nexpect.error.code = -11\n' "$prefix"; } > "$dir/rejected.toml"
  { m matrix-assertion-failure ""; printf '\n[[step]]\nname = "transfer"\nrun = "%s committed"\ntimeout = "60s"\nexpect.tx = "committed"\n\n[[step.assert.cell]]\nout_point = { step = "transfer", index = 0 }\ncount = 0\n' "$prefix"; } > "$dir/assertion-failure.toml"
  { m matrix-producer-timeout ""; printf '\n[[step]]\nname = "stall"\nrun = "sleep 120"\ntimeout = "2s"\nexpect.tx = "committed"\n'; } > "$dir/producer-timeout.toml"
}

# ---------------------------------------------------------------- consumer setup
if [[ $MODE == consumer ]]; then
  echo "== packing and installing into a clean consumer project"
  DIST=$WORK/dist; mkdir -p "$DIST"
  (cd "$ROOT" && bun pm pack --destination "$DIST" >"$WORK/pack.log" 2>&1) || { cat "$WORK/pack.log"; echo "pack failed"; exit 1; }
  TGZ=$(ls "$DIST"/ckb-verify-*.tgz | head -1); PACKED_VERSION=$(basename "$TGZ" .tgz | sed 's/^ckb-verify-//')
  TGZ_SHA=$(sha256sum "$TGZ" | cut -d' ' -f1)
  PROJECT=$WORK/consumer; mkdir -p "$PROJECT/patches"
  cp "$ROOT/showcases/secp-transfer/produce.ts" "$PROJECT/produce.ts"
  # Bun refuses to install a package whose patchedDependencies file is absent from the installing
  # project, so the shipped patch is extracted from the tarball and declared before the first install.
  tar -xzf "$TGZ" -C "$PROJECT/patches" --strip-components=2 "package/patches/@offckb%2Fcli@0.4.13.patch"
  cat > "$PROJECT/package.json" <<JSON
{
  "name": "ckb-verify-consumer-acceptance",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.2.19",
  "dependencies": { "ckb-verify": "file:$TGZ", "@ckb-ccc/core": "1.14.0" },
  "patchedDependencies": { "@offckb/cli@0.4.13": "patches/@offckb%2Fcli@0.4.13.patch" },
  "overrides": { "adm-zip": "0.6.1", "fast-uri": "3.1.9", "follow-redirects": "1.16.1", "tar": "7.5.22" }
}
JSON
  (cd "$PROJECT" && git init -q && git config user.email acceptance@example.invalid && git config user.name acceptance && printf 'node_modules/\n.ckb-verify/\n' > .gitignore)
  (cd "$PROJECT" && bun install >"$WORK/install.log" 2>&1) || { cat "$WORK/install.log"; echo "install failed"; exit 1; }
  CLI=("$PROJECT/node_modules/.bin/ckb-verify")
  OBSERVED=$("${CLI[@]}" --version 2>&1)
  if [[ $OBSERVED == "$PACKED_VERSION" ]]; then record install "installed bin reports packed version $PACKED_VERSION" "$OBSERVED (tarball sha256 $TGZ_SHA)" PASS
  else record install "version $PACKED_VERSION" "$OBSERVED" FAIL; fi
  SHIPPED=$(cd "$PROJECT/node_modules/ckb-verify" && find . -type f | sed 's|^\./||' | sort)
  if grep -qE '^(tests/|showcases/|\.github/|docs/media/)' <<<"$SHIPPED"; then record tarball-contents "no tests, showcases, CI config, or media shipped" "unexpected files present" FAIL
  else record tarball-contents "no tests, showcases, CI config, or media shipped" "$(wc -l <<<"$SHIPPED") files, src/schemas/patches/docs only" PASS; fi
  PATCHED=$(grep -c 'require("adm-zip")' "$PROJECT/node_modules/@offckb/cli/build/index.js")
  ADM=$(field "$PROJECT/node_modules/@offckb/cli/node_modules/adm-zip/package.json" version 2>/dev/null || field "$PROJECT/node_modules/adm-zip/package.json" version)
  if [[ $PATCHED == 2 && $ADM == 0.6.1 ]]; then record patch-active-after-install "2 patched adm-zip callsites, adm-zip 0.6.1 resolved" "$PATCHED callsites, adm-zip $ADM" PASS
  else record patch-active-after-install "2 patched callsites, adm-zip 0.6.1" "$PATCHED callsites, adm-zip $ADM" FAIL; fi
  # Install-time gate: without the patch file the package manager refuses the install outright.
  NOPATCH=$WORK/consumer-without-patch; mkdir -p "$NOPATCH"
  printf '{"name":"no-patch","private":true,"dependencies":{"ckb-verify":"file:%s"}}\n' "$TGZ" > "$NOPATCH/package.json"
  if (cd "$NOPATCH" && bun install >"$WORK/nopatch.log" 2>&1); then record install-without-patch-file "bun install refuses (missing patch file)" "install succeeded" FAIL
  else record install-without-patch-file "bun install refuses (missing patch file)" "exit 1: $(grep -m1 -o 'could not find patch file[^ ]*' "$WORK/nopatch.log")" PASS; fi
  write_manifests "$PROJECT" "bun run produce.ts"
  (cd "$PROJECT" && git add -A && git commit -qm "consumer acceptance fixture")
  # Runtime gate: a package manager that ignores patchedDependencies leaves the bundled archive code
  # active. Simulate that bundle and prove the runner refuses before any devnet mutation.
  BUNDLE=$PROJECT/node_modules/@offckb/cli/build/index.js; cp "$BUNDLE" "$WORK/patched-bundle.js"
  sed -i 's/const adm_zip_1 = __importDefault(require("adm-zip"));/const adm_zip_1 = __importDefault(__nccwpck_require__(3858));/' "$BUNDLE"
  run_manifest committed.toml
  if (( STATUS == 2 )) && grep -q "not the verified patched build" <<<"$OUT" && [[ $(report_count) == 0 ]] && closeout_ok >/dev/null; then
    record unpatched-offckb-refused "exit 2, no verdict, no runtime mutation" "exit 2: $(grep -o 'OffCKB installation[^.]*' <<<"$OUT" | head -1 | cut -c1-100)" PASS
  else record unpatched-offckb-refused "exit 2 refusing unpatched bundle" "exit $STATUS: $(tail -1 <<<"$OUT" | cut -c1-120)" FAIL; fi
  cp "$WORK/patched-bundle.js" "$BUNDLE"
  CONSUMER_HEAD=$(cd "$PROJECT" && git rev-parse HEAD)
else
  PROJECT=$ROOT; CLI=(bun run "$ROOT/src/cli.ts")
  write_manifests "$WORK" "bun run showcases/secp-transfer/produce.ts"
  PACKED_VERSION=$(cd "$ROOT" && bun run src/cli.ts --version)
fi
MANIFESTS=$([[ $MODE == consumer ]] && echo "$PROJECT" || echo "$WORK")
SOURCE_HEAD=$(cd "$PROJECT" && git rev-parse HEAD)
echo "== platform: $(uname -s) $(uname -m), bun $(bun --version), node $(node --version), ckb-verify $PACKED_VERSION, project HEAD $SOURCE_HEAD, mode $MODE"

# ---------------------------------------------------------------- offline validate (nothing executed)
OUT=$(cd "$PROJECT" && runner validate "$MANIFESTS/committed.toml" 2>&1); STATUS=$?
if (( STATUS == 0 )) && grep -q "executed: nothing" <<<"$OUT"; then record validate-offline "exit 0 without execution" "exit 0" PASS; else record validate-offline "exit 0" "exit $STATUS" FAIL; fi

# ---------------------------------------------------------------- cold cache
rm -rf "$PROJECT/.ckb-verify"
T0=$(date +%s); run_manifest "$MANIFESTS/committed.toml"; T1=$(date +%s)
if (( STATUS == 0 )) && [[ $OUT == PASS:* && -f $REPORT ]] && closeout_ok >/dev/null; then
  FIRST_REPORT=$REPORT; FIRST_OUTCOME=$OUTCOME; FIRST_ENV=$ENVIRONMENT
  record committed-cold-cache "PASS exit 0, CKB download" "exit 0 in $((T1 - T0))s, outcome ${OUTCOME:0:23}…" PASS
else record committed-cold-cache "PASS exit 0" "exit $STATUS: $(tail -1 <<<"$OUT")" FAIL; FIRST_REPORT=""; FIRST_OUTCOME=""; fi
if [[ -n $FIRST_REPORT ]]; then
  RUNNER_VERSION=$(field "$FIRST_REPORT" environment.runner.version); SRC=$(field "$FIRST_REPORT" environment.provenance.source.gitCommit)
  DIRTY=$(field "$FIRST_REPORT" environment.provenance.source.dirty); REPLAY=$(field "$FIRST_REPORT" environment.provenance.replay.status)
  if [[ $RUNNER_VERSION == "$PACKED_VERSION" && $SRC == "$SOURCE_HEAD" ]]; then
    record report-identities "runner $PACKED_VERSION, source = project HEAD" "runner $RUNNER_VERSION, source ${SRC:0:12} dirty=$DIRTY replay=$REPLAY" PASS
  else record report-identities "runner $PACKED_VERSION, source $SOURCE_HEAD" "runner $RUNNER_VERSION, source $SRC" FAIL; fi
fi

# ---------------------------------------------------------------- warm cache + repeat + offline check-digest
T0=$(date +%s); run_manifest "$MANIFESTS/committed.toml"; T1=$(date +%s)
if (( STATUS == 0 )) && [[ $OUTCOME == "$FIRST_OUTCOME" ]] && closeout_ok >/dev/null; then
  record committed-warm-cache-repeat "PASS exit 0, equal outcome digest" "exit 0 in $((T1 - T0))s, outcome equal, environment $([[ $ENVIRONMENT == "$FIRST_ENV" ]] && echo equal || echo differs)" PASS
else record committed-warm-cache-repeat "PASS with equal outcome" "exit $STATUS, outcome ${OUTCOME:0:23}… vs ${FIRST_OUTCOME:0:23}…" FAIL; fi
if [[ -n $REPORT ]]; then
  OUT2=$(cd "$PROJECT" && runner check-digest "$REPORT" --outcome "$FIRST_OUTCOME" 2>&1); S2=$?
  if (( S2 == 0 )); then record check-digest-repeat "exit 0 against first outcome" "exit 0" PASS; else record check-digest-repeat "exit 0" "exit $S2: $(tail -1 <<<"$OUT2")" FAIL; fi
fi

# ---------------------------------------------------------------- rejected (debugger download) and assertion failure
run_manifest "$MANIFESTS/rejected.toml"
if (( STATUS == 0 )) && [[ $OUT == PASS:* ]] && [[ $(field "$REPORT" evidence.steps.0.rejection.code) == -11 ]] && closeout_ok >/dev/null; then
  record rejected-pinned-debugger "PASS exit 0, script error -11 via verified debugger" "exit 0, code $(field "$REPORT" evidence.steps.0.rejection.code), debugger $(field "$REPORT" environment.provenance.binaries.ckbDebugger.version)" PASS
else record rejected-pinned-debugger "PASS exit 0 with -11" "exit $STATUS: $(tail -1 <<<"$OUT")" FAIL; fi
run_manifest "$MANIFESTS/assertion-failure.toml"
if (( STATUS == 1 )) && [[ $OUT == FAIL:* && -f $REPORT ]] && closeout_ok >/dev/null; then
  OUT2=$(cd "$PROJECT" && runner digest "$REPORT" 2>&1); S2=$?
  if (( S2 == 0 )) && grep -q "^verdict: FAIL" <<<"$OUT2"; then record assertion-failure "FAIL exit 1; offline digest exit 0 with verdict FAIL" "exit 1; digest exit 0, verdict FAIL" PASS
  else record assertion-failure "digest exit 0 verdict FAIL" "digest exit $S2" FAIL; fi
  TAMPERED=$WORK/tampered-report.json; sed -E 's/"verdict": ?"FAIL"/"verdict": "PASS"/' "$REPORT" > "$TAMPERED"
  cmp -s "$REPORT" "$TAMPERED" && echo "tamper did not change the report" >&2
  OUT3=$(cd "$PROJECT" && runner digest "$TAMPERED" 2>&1); S3=$?
  if (( S3 == 1 )) && grep -q "^INVALID" <<<"$OUT3"; then record tampered-verdict-rejected "digest exit 1 INVALID" "exit 1" PASS; else record tampered-verdict-rejected "exit 1" "exit $S3" FAIL; fi
else record assertion-failure "FAIL exit 1" "exit $STATUS: $(tail -1 <<<"$OUT")" FAIL; fi

# ---------------------------------------------------------------- occupied port (foreign listener is never killed)
BEFORE=$(report_count)
bun -e 'import { createServer } from "node:net"; createServer().listen({ host: "127.0.0.1", port: 28114 }, () => console.log("held")); setTimeout(() => process.exit(0), 300000);' >"$WORK/listener.log" 2>&1 &
LISTENER=$!; for _ in $(seq 1 50); do grep -q held "$WORK/listener.log" 2>/dev/null && break; sleep 0.1; done
run_manifest "$MANIFESTS/committed.toml"
if (( STATUS == 2 )) && grep -q "runtime busy" <<<"$OUT" && kill -0 "$LISTENER" 2>/dev/null && [[ $(report_count) == "$BEFORE" ]]; then
  record occupied-port "exit 2 busy diagnostic, listener untouched, no report" "exit 2, listener alive" PASS
else record occupied-port "exit 2 busy, listener alive" "exit $STATUS: $(tail -1 <<<"$OUT")" FAIL; fi
kill "$LISTENER" 2>/dev/null; wait "$LISTENER" 2>/dev/null

# ---------------------------------------------------------------- concurrent runs: exclusion then reuse
BEFORE=$(report_count)
(cd "$PROJECT" && runner run "$MANIFESTS/committed.toml" >"$WORK/concurrent-a.log" 2>&1; echo $? >"$WORK/concurrent-a.status") &
A=$!; sleep 4
run_manifest "$MANIFESTS/committed.toml"; B_STATUS=$STATUS; B_OUT=$OUT
wait "$A"; A_STATUS=$(cat "$WORK/concurrent-a.status")
if (( A_STATUS == 0 && B_STATUS == 2 )) && grep -q "runtime busy" <<<"$B_OUT" && [[ $(report_count) == $((BEFORE + 1)) ]]; then
  record concurrent-exclusion "owner PASS exit 0; contender exit 2 busy; one report" "A exit 0, B exit 2" PASS
else record concurrent-exclusion "A exit 0, B exit 2 busy" "A exit $A_STATUS, B exit $B_STATUS: $(tail -1 <<<"$B_OUT")" FAIL; fi
run_manifest "$MANIFESTS/committed.toml"
if (( STATUS == 0 )) && closeout_ok >/dev/null; then record reuse-after-contention "PASS exit 0" "exit 0" PASS; else record reuse-after-contention "PASS exit 0" "exit $STATUS" FAIL; fi

# ---------------------------------------------------------------- interruption after the node is up
BEFORE=$(report_count)
# exec replaces the subshell so the signal reaches the runner process itself.
(cd "$PROJECT" && exec "${CLI[@]}" run "$MANIFESTS/committed.toml") >"$WORK/interrupt.log" 2>&1 &
I=$!
if wait_for_port 8114; then
  # While the node is up: the node RPC (8114) and the patched OffCKB proxy (28114) must answer on
  # loopback only, never on the host's routable address. Listener scope is not a sandbox.
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -z $HOST_IP ]]; then record loopback-only-listeners "8114/28114 unreachable on the routable address" "no routable address on this host" FAIL
  elif port_listening 8114 "$HOST_IP" || port_listening 28114 "$HOST_IP"; then record loopback-only-listeners "8114/28114 unreachable on $HOST_IP" "reachable on $HOST_IP" FAIL
  elif port_listening 28114; then record loopback-only-listeners "8114/28114 unreachable on $HOST_IP, reachable on 127.0.0.1" "both loopback only" PASS
  else record loopback-only-listeners "proxy reachable on 127.0.0.1" "28114 not listening on loopback" FAIL; fi
  sleep 1; kill -INT "$I"
else echo "node never listened" >&2; fi
wait "$I"; I_STATUS=$?
if (( I_STATUS == 130 )) && [[ $(report_count) == "$BEFORE" ]] && closeout_ok >/dev/null; then
  record sigint-cleanup "exit 130, no report, accounts removed, ports released" "exit 130, clean closeout" PASS
else record sigint-cleanup "exit 130 with clean closeout" "exit $I_STATUS, $(closeout_ok 2>&1 | tail -1)" FAIL; fi

# ---------------------------------------------------------------- producer timeout
BEFORE=$(report_count); T0=$(date +%s)
run_manifest "$MANIFESTS/producer-timeout.toml"; T1=$(date +%s)
if (( STATUS == 2 )) && grep -qi "timed out" <<<"$OUT" && [[ $(report_count) == "$BEFORE" ]] && closeout_ok >/dev/null; then
  record producer-timeout "exit 2 timed out, no report, clean closeout" "exit 2 in $((T1 - T0))s" PASS
else record producer-timeout "exit 2 timed out" "exit $STATUS: $(tail -1 <<<"$OUT")" FAIL; fi

# ---------------------------------------------------------------- tampered debugger cache
DBG=$PROJECT/.ckb-verify/offckb/cache/verified-debugger/1.1.1-linux-x64/ckb-debugger
if [[ -f $DBG ]]; then
  BEFORE=$(report_count); ORIGINAL=$(sha256sum "$DBG" | cut -d' ' -f1)
  for offset in 100 4096 65536; do # flip a byte that was not already 0xff
    printf '\xff' | dd of="$DBG" bs=1 seek=$offset conv=notrunc status=none
    [[ $(sha256sum "$DBG" | cut -d' ' -f1) != "$ORIGINAL" ]] && break
  done
  run_manifest "$MANIFESTS/rejected.toml"
  if (( STATUS == 2 )) && grep -qi "debugger" <<<"$OUT" && [[ $(report_count) == "$BEFORE" ]] && closeout_ok >/dev/null; then
    record tampered-debugger-cache "exit 2 no verdict, cache not repaired silently" "exit 2: $(grep -o 'debugger[^;]*' <<<"$OUT" | head -1 | cut -c1-80)" PASS
  else record tampered-debugger-cache "exit 2 refusing tampered cache" "exit $STATUS: $(tail -1 <<<"$OUT")" FAIL; fi
  rm -rf "$PROJECT/.ckb-verify/offckb/cache/verified-debugger"
  run_manifest "$MANIFESTS/rejected.toml"
  if (( STATUS == 0 )); then record debugger-reinstall-after-cleanup "PASS exit 0 after removing the tampered cache" "exit 0" PASS; else record debugger-reinstall-after-cleanup "PASS exit 0" "exit $STATUS" FAIL; fi
else record tampered-debugger-cache "cache present from rejected run" "no cache at $DBG" FAIL; fi

# ---------------------------------------------------------------- download failure on a cold cache, then recovery
rm -rf "$PROJECT/.ckb-verify"; BEFORE=0
OUT=$(cd "$PROJECT" && HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 NO_PROXY= no_proxy= runner run "$MANIFESTS/committed.toml" 2>&1); STATUS=$?
if (( STATUS == 2 )) && [[ $(report_count) == 0 ]] && closeout_ok >/dev/null; then
  record download-failure-cold "exit 2 no verdict, clean closeout" "exit 2: $(tail -1 <<<"$OUT" | cut -c1-90)" PASS
else record download-failure-cold "exit 2 without verdict" "exit $STATUS: $(tail -1 <<<"$OUT" | cut -c1-90)" FAIL; fi
run_manifest "$MANIFESTS/committed.toml"
if (( STATUS == 0 )) && closeout_ok >/dev/null; then record recovery-after-download-failure "PASS exit 0" "exit 0" PASS; else record recovery-after-download-failure "PASS exit 0" "exit $STATUS" FAIL; fi

# ---------------------------------------------------------------- final closeout
if MSG=$(closeout_ok 2>&1); then record final-closeout "no accounts/pending, ports free" "clean" PASS; else record final-closeout "clean" "$MSG" FAIL; fi

TABLE=$(printf '| case | expected | observed | result |\n| --- | --- | --- | --- |\n%s\n' "$(printf '%s\n' "${ROWS[@]}")")
HEADER="mode: $MODE; platform: $(uname -s) $(uname -m); bun $(bun --version); node $(node --version); ckb-verify $PACKED_VERSION; project HEAD $SOURCE_HEAD; $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '\n%s\n\n%s\n' "$HEADER" "$TABLE"
[[ -n $RESULTS ]] && printf '%s\n\n%s\n' "$HEADER" "$TABLE" > "$RESULTS"
if (( FAILED )); then echo "ACCEPTANCE MATRIX FAILED"; exit 1; fi
echo "ACCEPTANCE MATRIX PASS ($MODE)"
