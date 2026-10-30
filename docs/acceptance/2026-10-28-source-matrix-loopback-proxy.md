# Source-checkout acceptance matrix after the loopback proxy bind, 2026-10-28

Produced by `scripts/acceptance-matrix.sh` on a clean checkout with the OffCKB patch that binds the RPC proxy (28114) to 127.0.0.1. The `loopback-only-listeners` row now asserts that neither 8114 nor 28114 answers on the host's routable address while the node is up; it previously recorded the wildcard proxy bind as a documented limitation.

mode: source; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.0.2; project HEAD e69af1268e07a0bc8bbcb04a0dde5e92e50a7212; 2026-10-28T20:27:34Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 24s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.0.2, source = project HEAD | runner 0.0.2, source e69af1268e07 dirty=false replay=stable | PASS |
| committed-warm-cache-repeat | PASS exit 0, equal outcome digest | exit 0 in 21s, outcome equal, environment equal | PASS |
| check-digest-repeat | exit 0 against first outcome | exit 0 | PASS |
| rejected-pinned-debugger | PASS exit 0, script error -11 via verified debugger | exit 0, code -11, debugger 1.1.1 | PASS |
| assertion-failure | FAIL exit 1; offline digest exit 0 with verdict FAIL | exit 1; digest exit 0, verdict FAIL | PASS |
| tampered-verdict-rejected | digest exit 1 INVALID | exit 1 | PASS |
| occupied-port | exit 2 busy diagnostic, listener untouched, no report | exit 2, listener alive | PASS |
| concurrent-exclusion | owner PASS exit 0; contender exit 2 busy; one report | A exit 0, B exit 2 | PASS |
| reuse-after-contention | PASS exit 0 | exit 0 | PASS |
| loopback-only-listeners | 8114/28114 unreachable on 192.0.2.2, reachable on 127.0.0.1 | both loopback only | PASS |
| sigint-cleanup | exit 130, no report, accounts removed, ports released | exit 130, clean closeout | PASS |
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 10s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR: Unable to connect. Is the computer able to access the url? | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |
