# Installed-consumer acceptance matrix, 2026-10-28

Produced by `scripts/acceptance-matrix.sh --consumer` on a clean tree. The consumer project is a separate temporary directory with its own git history; `project HEAD` below is that consumer commit, and `ckb-verify` is the version of the packed tarball installed into it. Both patch gates (install-time missing patch file, runtime unpatched bundle) and every scenario passed.

mode: consumer; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.0.2; project HEAD ecbaafb9498e99f9230bbf5a11f07719bf60b83c; 2026-10-28T08:07:23Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| install | installed bin reports packed version 0.0.2 | 0.0.2 (tarball sha256 4b05e93af2e9845f837deea4434b43a6d898e19e730f1aa4fe2da74263f53af7) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 33 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 24s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.0.2, source = project HEAD | runner 0.0.2, source ecbaafb9498e dirty=false replay=stable | PASS |
| committed-warm-cache-repeat | PASS exit 0, equal outcome digest | exit 0 in 23s, outcome equal, environment equal | PASS |
| check-digest-repeat | exit 0 against first outcome | exit 0 | PASS |
| rejected-pinned-debugger | PASS exit 0, script error -11 via verified debugger | exit 0, code -11, debugger 1.1.1 | PASS |
| assertion-failure | FAIL exit 1; offline digest exit 0 with verdict FAIL | exit 1; digest exit 0, verdict FAIL | PASS |
| tampered-verdict-rejected | digest exit 1 INVALID | exit 1 | PASS |
| occupied-port | exit 2 busy diagnostic, listener untouched, no report | exit 2, listener alive | PASS |
| concurrent-exclusion | owner PASS exit 0; contender exit 2 busy; one report | A exit 0, B exit 2 | PASS |
| reuse-after-contention | PASS exit 0 | exit 0 | PASS |
| sigint-cleanup | exit 130, no report, accounts removed, ports released | exit 130, clean closeout | PASS |
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 10s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR: Unable to connect. Is the computer able to access the url? | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |
