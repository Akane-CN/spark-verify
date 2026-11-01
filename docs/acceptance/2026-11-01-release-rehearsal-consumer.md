# Release rehearsal with the installed-consumer gate, 2026-11-01

Produced by `scripts/release-rehearsal.sh --consumer` on commit `f8fe3ea`, whose tree is identical to `main` at `b44a68c` (the squash of #33). This is the first rehearsal that runs every gate the release checklist names in one cycle: frozen tree, dependency and supply-chain gate (with `follow-redirects 1.16.2`), regression, documentation, the secp-transfer showcase, packing with checksums, the 24-row installed-consumer acceptance matrix, evidence packaging, and the release-evidence archive assembled with the consumer record inside and re-verified. Every row passed. The `project HEAD` in the consumer section is the disposable consumer project's own commit.

- candidate: `f8fe3ea006bcbd2c6b5b516c7bdc5b228f2d27a3`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.0.2.tgz`
- tarball sha256: `5f0490188e5bb7dc1e798796fa2cf1514228f3640cce0f21cfeeb3e40c97697e`
- release evidence: `dist/release-evidence-0.0.2-f8fe3ea.tar.gz`
- release evidence sha256: `9b845b55487602e8b97f41fb3af42ffcfeec5a31112bebf144bc67ebaff1d80d`
- date: 2026-11-01T22:23:33Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 0s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 1s |
| regression | `bun run check` | PASS | 34s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 4s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 90s |
| pack | `bun pm pack --destination dist` | PASS | 0s |
| consumer-acceptance | `scripts/acceptance-matrix.sh --consumer --results dist/acceptance-consumer.md` | PASS | 209s |
| package-evidence | `bun run scripts/package-evidence.ts --out dist/evidence-secp-transfer-f8fe3ea006bcbd2c6b5b516c7bdc5b228f2d27a3 --repository Akane-CN/spark-verify --source-sha f8fe3ea006bcbd2c6b5b516c7bdc5b228f2d27a3 --workflow rehearsal --job secp-transfer` | PASS | 1s |
| release-evidence | `bun run scripts/release-evidence.ts assemble --out dist/release-evidence-0.0.2-f8fe3ea.tar.gz --bundle dist/evidence-secp-transfer-f8fe3ea006bcbd2c6b5b516c7bdc5b228f2d27a3 --record dist/acceptance-consumer.md --repository Akane-CN/spark-verify --source-sha f8fe3ea006bcbd2c6b5b516c7bdc5b228f2d27a3` | PASS | 0s |
| verify-release-evidence | `bun run scripts/release-evidence.ts verify dist/release-evidence-0.0.2-f8fe3ea.tar.gz --source-sha f8fe3ea006bcbd2c6b5b516c7bdc5b228f2d27a3 --repository Akane-CN/spark-verify` | PASS | 1s |

## Installed-consumer acceptance

mode: consumer; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.0.2; project HEAD 771790398ef942594203d9516a29bf6f9d4a08a6; 2026-11-01T22:23:31Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| install | installed bin reports packed version 0.0.2 | 0.0.2 (tarball sha256 5f0490188e5bb7dc1e798796fa2cf1514228f3640cce0f21cfeeb3e40c97697e) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 37 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 24s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.0.2, source = project HEAD | runner 0.0.2, source 771790398ef9 dirty=false replay=stable | PASS |
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
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR: Unable to connect. Is the computer able to access the url? | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |

The release-evidence archive here was assembled from this host's showcase run, not from a hosted CI run; the release attaches the CI archive (release checklist, step 6).
No tag, release, or package was published by this rehearsal.
