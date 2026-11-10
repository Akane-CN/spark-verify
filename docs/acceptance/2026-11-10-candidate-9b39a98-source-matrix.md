# Source-checkout acceptance matrix on the v0.1.0 candidate `9b39a98`, 2026-11-10

Produced by `scripts/acceptance-matrix.sh` in a clean checkout of the candidate `9b39a98` (release checklist step 3). Every row passed. Summary: [`2026-11-10-candidate-9b39a98.md`](2026-11-10-candidate-9b39a98.md).

mode: source; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.1.0; project HEAD 9b39a9882b0b4250e713cce556eef0a7dc3809b8; 2026-11-10T01:08:48Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 21s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.1.0, source = project HEAD | runner 0.1.0, source 9b39a9882b0b dirty=false replay=stable | PASS |
| committed-warm-cache-repeat | PASS exit 0, equal outcome digest | exit 0 in 20s, outcome equal, environment equal | PASS |
| check-digest-repeat | exit 0 against first outcome | exit 0 | PASS |
| rejected-pinned-debugger | PASS exit 0, script error -11 via verified debugger | exit 0, code -11, debugger 1.1.1 | PASS |
| assertion-failure | FAIL exit 1; offline digest exit 0 with verdict FAIL | exit 1; digest exit 0, verdict FAIL | PASS |
| tampered-verdict-rejected | digest exit 1 INVALID | exit 1 | PASS |
| occupied-port | exit 2 busy diagnostic, listener untouched, no report | exit 2, listener alive | PASS |
| concurrent-exclusion | owner PASS exit 0; contender exit 2 busy; one report | A exit 0, B exit 2 | PASS |
| reuse-after-contention | PASS exit 0 | exit 0 | PASS |
| loopback-only-listeners | 8114/28114 unreachable on 192.0.2.2, reachable on 127.0.0.1 | both loopback only | PASS |
| sigint-cleanup | exit 130, no report, accounts removed, ports released | exit 130, clean closeout | PASS |
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 7s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR [devnet]: Unable to connect. Is the computer able to access the url? (after 4 attemp | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| v02-repository-script | PASS exit 0: deploy, pure step, create, legal spend (report/4, offline VALID) | exit 0, witness_lock type 0x76ee7120f748eaa0… | PASS |
| v02-error-group | PASS exit 0: code 42 from the witness_lock group | exit 0, code 42, group lock | PASS |
| v02-wrong-group | FAIL exit 1: same code, different group | exit 1, group mismatch | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |
