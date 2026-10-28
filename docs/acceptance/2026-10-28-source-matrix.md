# Source-checkout acceptance matrix, 2026-10-28

Produced by `scripts/acceptance-matrix.sh` on a clean checkout. Rows marked `NOTE` are recorded observations of documented limitations, not assertions: OffCKB 0.4.13 binds its proxy port 28114 on the wildcard interface, which the adapter cannot narrow (see SECURITY.md); the node RPC on 8114 is loopback-only. Every asserted row passed.

mode: source; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.0.2; project HEAD cd14e164ab47be2f52e9f3a92352541b06d3f1b8; 2026-10-28T08:20:15Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 22s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.0.2, source = project HEAD | runner 0.0.2, source cd14e164ab47 dirty=false replay=stable | PASS |
| committed-warm-cache-repeat | PASS exit 0, equal outcome digest | exit 0 in 22s, outcome equal, environment equal | PASS |
| check-digest-repeat | exit 0 against first outcome | exit 0 | PASS |
| rejected-pinned-debugger | PASS exit 0, script error -11 via verified debugger | exit 0, code -11, debugger 1.1.1 | PASS |
| assertion-failure | FAIL exit 1; offline digest exit 0 with verdict FAIL | exit 1; digest exit 0, verdict FAIL | PASS |
| tampered-verdict-rejected | digest exit 1 INVALID | exit 1 | PASS |
| occupied-port | exit 2 busy diagnostic, listener untouched, no report | exit 2, listener alive | PASS |
| concurrent-exclusion | owner PASS exit 0; contender exit 2 busy; one report | A exit 0, B exit 2 | PASS |
| reuse-after-contention | PASS exit 0 | exit 0 | PASS |
| rpc-loopback-only | 8114 unreachable on 192.0.2.2, reachable on 127.0.0.1 | 8114 loopback only | PASS |
| proxy-bind-observed | documented: OffCKB proxy binds 28114 on the wildcard interface | 28114 reachable on 192.0.2.2 (documented limitation; firewall/VM required) | NOTE |
| sigint-cleanup | exit 130, no report, accounts removed, ports released | exit 130, clean closeout | PASS |
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 10s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR: Unable to connect. Is the computer able to access the url? | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |
