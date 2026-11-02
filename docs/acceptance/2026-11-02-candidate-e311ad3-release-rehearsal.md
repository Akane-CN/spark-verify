# Release rehearsal with the installed-consumer gate on the v0.1.0 candidate `e311ad3`, 2026-11-02

Produced by `scripts/release-rehearsal.sh --consumer` in a clean checkout of the re-frozen candidate `e311ad3` (release checklist steps 2, 4, and 5). Every step and all 24 installed-consumer rows passed. The `project HEAD` in the consumer section is the disposable consumer project's own commit. Summary: [`2026-11-02-candidate-e311ad3.md`](2026-11-02-candidate-e311ad3.md).

- candidate: `e311ad3db8cc58f751928f01c881646da45f5a72`
- version: `0.1.0`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.1.0.tgz`
- tarball sha256: `61fca14b5b00762021b13bd67049aed01da41e9b45053cdb08a554e2ee8eda0b`
- release evidence: `dist/release-evidence-0.1.0-e311ad3.tar.gz`
- release evidence sha256: `aa0cf5b7594811a4e3c5a8f73f22599bbac3ef1e75e6601e082caf5dc96c3904`
- date: 2026-11-02T19:28:21Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 0s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 0s |
| regression | `bun run check` | PASS | 34s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 3s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 77s |
| pack | `bun pm pack --destination dist` | PASS | 0s |
| consumer-acceptance | `scripts/acceptance-matrix.sh --consumer --results dist/acceptance-consumer.md` | PASS | 195s |
| package-evidence | `bun run scripts/package-evidence.ts --out dist/evidence-secp-transfer-e311ad3db8cc58f751928f01c881646da45f5a72 --repository Akane-CN/spark-verify --source-sha e311ad3db8cc58f751928f01c881646da45f5a72 --workflow rehearsal --job secp-transfer` | PASS | 1s |
| release-evidence | `bun run scripts/release-evidence.ts assemble --out dist/release-evidence-0.1.0-e311ad3.tar.gz --bundle dist/evidence-secp-transfer-e311ad3db8cc58f751928f01c881646da45f5a72 --record dist/acceptance-consumer.md --repository Akane-CN/spark-verify --source-sha e311ad3db8cc58f751928f01c881646da45f5a72` | PASS | 1s |
| verify-release-evidence | `bun run scripts/release-evidence.ts verify dist/release-evidence-0.1.0-e311ad3.tar.gz --source-sha e311ad3db8cc58f751928f01c881646da45f5a72 --repository Akane-CN/spark-verify` | PASS | 1s |

## Installed-consumer acceptance

mode: consumer; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.1.0; project HEAD cf7e3fd8a20c2b2195439ef6f249278048eeffc7; 2026-11-02T19:28:18Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| install | installed bin reports packed version 0.1.0 | 0.1.0 (tarball sha256 61fca14b5b00762021b13bd67049aed01da41e9b45053cdb08a554e2ee8eda0b) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 47 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 23s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.1.0, source = project HEAD | runner 0.1.0, source cf7e3fd8a20c dirty=false replay=stable | PASS |
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

The release-evidence archive here was assembled from this host's showcase run, not from a hosted CI run; the release attaches the CI archive (release checklist, step 6).
No tag, release, or package was published by this rehearsal.
