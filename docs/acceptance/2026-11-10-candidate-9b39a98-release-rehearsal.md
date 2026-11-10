# Release rehearsal with the installed-consumer gate on the v0.1.0 candidate `9b39a98`, 2026-11-10

Produced by `scripts/release-rehearsal.sh --consumer` in a clean checkout of the candidate `9b39a98` (release checklist steps 2, 4, and 5). Every step and all 29 installed-consumer rows passed. The consumer project was installed by `setup-project`, taken out of the packed tarball, and the `example-project` row ran the project that `setup-project --example` writes. The `project HEAD` in the consumer section is the disposable consumer project's own commit. Summary: [`2026-11-10-candidate-9b39a98.md`](2026-11-10-candidate-9b39a98.md).

- candidate: `9b39a9882b0b4250e713cce556eef0a7dc3809b8`
- version: `0.1.0`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.1.0.tgz`
- tarball sha256: `c3817135748229a4733b222de2b3d3e5f70efe957692153dd011fe5e48f47421`
- release evidence: `dist/release-evidence-0.1.0-9b39a98.tar.gz`
- release evidence sha256: `60bfce2b8769617365df8d7a12f3495ceafceb076396b19381456eeb3afc0e2f`
- date: 2026-11-10T00:49:24Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 5s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 0s |
| regression | `bun run check` | PASS | 30s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 3s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 72s |
| pack | `bun pm pack --destination dist` | PASS | 0s |
| consumer-acceptance | `scripts/acceptance-matrix.sh --consumer --results dist/acceptance-consumer.md` | PASS | 380s |
| package-evidence | `bun run scripts/package-evidence.ts --out dist/evidence-secp-transfer-9b39a9882b0b4250e713cce556eef0a7dc3809b8 --repository Akane-CN/spark-verify --source-sha 9b39a9882b0b4250e713cce556eef0a7dc3809b8 --workflow rehearsal --job secp-transfer` | PASS | 1s |
| release-evidence | `bun run scripts/release-evidence.ts assemble --out dist/release-evidence-0.1.0-9b39a98.tar.gz --bundle dist/evidence-secp-transfer-9b39a9882b0b4250e713cce556eef0a7dc3809b8 --record dist/acceptance-consumer.md --repository Akane-CN/spark-verify --source-sha 9b39a9882b0b4250e713cce556eef0a7dc3809b8` | PASS | 0s |
| verify-release-evidence | `bun run scripts/release-evidence.ts verify dist/release-evidence-0.1.0-9b39a98.tar.gz --source-sha 9b39a9882b0b4250e713cce556eef0a7dc3809b8 --repository Akane-CN/spark-verify` | PASS | 1s |

## Installed-consumer acceptance

mode: consumer; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.1.0; project HEAD e246652f5aacad4b48d4179269ee07c166c11f71; 2026-11-10T00:49:22Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| setup-project | one command from the tarball alone prepares and installs; a second run changes nothing | vendored tarball, patch, package.json, .gitignore written; rerun: nothing | PASS |
| install | installed bin reports packed version 0.1.0 | 0.1.0 (tarball sha256 c3817135748229a4733b222de2b3d3e5f70efe957692153dd011fe5e48f47421) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 61 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| example-project | setup-project --example, commit, run: PASS with a stable report | exit 0, PASS, replay stable | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 22s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.1.0, source = project HEAD | runner 0.1.0, source e246652f5aac dirty=false replay=stable | PASS |
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
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 8s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR [devnet]: Unable to connect. Is the computer able to access the url? (after 4 attemp | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| v02-repository-script | PASS exit 0: deploy, pure step, create, legal spend (report/4, offline VALID) | exit 0, witness_lock type 0x76ee7120f748eaa0… | PASS |
| v02-error-group | PASS exit 0: code 42 from the witness_lock group | exit 0, code 42, group lock | PASS |
| v02-wrong-group | FAIL exit 1: same code, different group | exit 1, group mismatch | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |

The release-evidence archive here was assembled from this host's showcase run, not from a hosted CI run; the release attaches the CI archive (release checklist, step 6).
No tag, release, or package was published by this rehearsal.
