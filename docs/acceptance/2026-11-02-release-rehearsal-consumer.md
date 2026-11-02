# Release rehearsal with the installed-consumer gate, 2026-11-02

Produced by `scripts/release-rehearsal.sh --consumer` on commit `803b7ad`: `main` at `ed41b28` (the squash of #36) plus one harness fix. The first rehearsal on `ed41b28` failed one installed-consumer row because the listener-scope check raced the OffCKB proxy's startup; that run, its root cause, and the fix are recorded in [`2026-11-02-release-rehearsal-consumer-fail.md`](2026-11-02-release-rehearsal-consumer-fail.md). The fix changes only `scripts/acceptance-matrix.sh`, which is not shipped. The packed tarball's sha256 is identical in both runs (`5493f87d…`), so this record covers the package that `ed41b28` produces.

Every step passed: frozen tree, dependency install, the supply-chain gate, regression, documentation, the secp-transfer showcase, packing with checksums, all 24 installed-consumer rows, evidence packaging, and the release-evidence archive assembled with the consumer record inside and re-verified. `loopback-only-listeners` now waits for the proxy and then finds both `8114` and `28114` reachable on `127.0.0.1` and unreachable on the host's routable address. The `project HEAD` in the consumer section is the disposable consumer project's own commit. Nothing was tagged or published.

- candidate: `803b7ad4749cb4c6341407d98eae4bb428e792f7`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.0.2.tgz`
- tarball sha256: `5493f87d309b930a2a5a56e74e48136dd58abe117ed39b574dfa7e72b2acc8f5`
- release evidence: `dist/release-evidence-0.0.2-803b7ad.tar.gz`
- release evidence sha256: `c336fdf615281a1ed75e09792ed61e26c5a44b457dc94f16cf2f3087dcd9d820`
- date: 2026-11-02T03:58:35Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 0s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 0s |
| regression | `bun run check` | PASS | 35s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 3s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 82s |
| pack | `bun pm pack --destination dist` | PASS | 0s |
| consumer-acceptance | `scripts/acceptance-matrix.sh --consumer --results dist/acceptance-consumer.md` | PASS | 207s |
| package-evidence | `bun run scripts/package-evidence.ts --out dist/evidence-secp-transfer-803b7ad4749cb4c6341407d98eae4bb428e792f7 --repository Akane-CN/spark-verify --source-sha 803b7ad4749cb4c6341407d98eae4bb428e792f7 --workflow rehearsal --job secp-transfer` | PASS | 1s |
| release-evidence | `bun run scripts/release-evidence.ts assemble --out dist/release-evidence-0.0.2-803b7ad.tar.gz --bundle dist/evidence-secp-transfer-803b7ad4749cb4c6341407d98eae4bb428e792f7 --record dist/acceptance-consumer.md --repository Akane-CN/spark-verify --source-sha 803b7ad4749cb4c6341407d98eae4bb428e792f7` | PASS | 1s |
| verify-release-evidence | `bun run scripts/release-evidence.ts verify dist/release-evidence-0.0.2-803b7ad.tar.gz --source-sha 803b7ad4749cb4c6341407d98eae4bb428e792f7 --repository Akane-CN/spark-verify` | PASS | 1s |

## Installed-consumer acceptance

mode: consumer; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.0.2; project HEAD 3fb04a7e55bae3702dca98b9ab82193e8fbc4cb7; 2026-11-02T03:58:32Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| install | installed bin reports packed version 0.0.2 | 0.0.2 (tarball sha256 5493f87d309b930a2a5a56e74e48136dd58abe117ed39b574dfa7e72b2acc8f5) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 43 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 23s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.0.2, source = project HEAD | runner 0.0.2, source 3fb04a7e55ba dirty=false replay=stable | PASS |
| committed-warm-cache-repeat | PASS exit 0, equal outcome digest | exit 0 in 22s, outcome equal, environment equal | PASS |
| check-digest-repeat | exit 0 against first outcome | exit 0 | PASS |
| rejected-pinned-debugger | PASS exit 0, script error -11 via verified debugger | exit 0, code -11, debugger 1.1.1 | PASS |
| assertion-failure | FAIL exit 1; offline digest exit 0 with verdict FAIL | exit 1; digest exit 0, verdict FAIL | PASS |
| tampered-verdict-rejected | digest exit 1 INVALID | exit 1 | PASS |
| occupied-port | exit 2 busy diagnostic, listener untouched, no report | exit 2, listener alive | PASS |
| concurrent-exclusion | owner PASS exit 0; contender exit 2 busy; one report | A exit 0, B exit 2 | PASS |
| reuse-after-contention | PASS exit 0 | exit 0 | PASS |
| loopback-only-listeners | 8114/28114 unreachable on 192.0.2.2, reachable on 127.0.0.1 | both loopback only | PASS |
| sigint-cleanup | exit 130, no report, accounts removed, ports released | exit 130, clean closeout | PASS |
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 11s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR: Unable to connect. Is the computer able to access the url? | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |

The release-evidence archive here was assembled from this host's showcase run, not from a hosted CI run; the release attaches the CI archive (release checklist, step 6).
No tag, release, or package was published by this rehearsal.
