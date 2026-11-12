# Installed-consumer matrix as an ordinary user on the v0.1.1 candidate `75db970`, 2026-11-12

Produced by `scripts/acceptance-matrix.sh --consumer --tarball ckb-verify-0.1.1.tgz` as **uid 1000**, from that user's own clean clone of the candidate `75db970`, against the tarball the rehearsal packed (sha256 `589319cb38a1e6e166911d381a55e88c481e38aaea9c5b88359add6144ddf3c3`). All 29 rows passed.

This run exists because of [#52](https://github.com/Akane-CN/spark-verify/issues/52): root can overwrite read-only files, which hid a defect in the `tampered-debugger-cache` fixture until `v0.1.0` was installed back by an ordinary user. In this run that row corrupted the cache as its owner and the runner refused it. Summary: [`2026-11-12-candidate-75db970.md`](2026-11-12-candidate-75db970.md).

mode: consumer; platform: Linux x86_64; uid 1000; bun 1.2.19; node v22.22.0; ckb-verify 0.1.1; project HEAD 4b3c76c8f2fe704095c2f034099021bc86fa03e4; 2026-11-12T00:09:28Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| setup-project | one command from the tarball alone prepares and installs; a second run changes nothing | vendored tarball, patch, package.json, .gitignore written; rerun: nothing | PASS |
| install | installed bin reports packed version 0.1.1 | 0.1.1 (tarball sha256 589319cb38a1e6e166911d381a55e88c481e38aaea9c5b88359add6144ddf3c3) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 61 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| example-project | setup-project --example, commit, run: PASS with a stable report | exit 0, PASS, replay stable | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 22s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.1.1, source = project HEAD | runner 0.1.1, source 4b3c76c8f2fe dirty=false replay=stable | PASS |
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
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 9s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch; corrupted bytes still in place, mode 500 | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR [devnet]: Unable to connect. Is the computer able to access the url? (after 4 attemp | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| v02-repository-script | PASS exit 0: deploy, pure step, create, legal spend (report/4, offline VALID) | exit 0, witness_lock type 0x76ee7120f748eaa0… | PASS |
| v02-error-group | PASS exit 0: code 42 from the witness_lock group | exit 0, code 42, group lock | PASS |
| v02-wrong-group | FAIL exit 1: same code, different group | exit 1, group mismatch | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |
