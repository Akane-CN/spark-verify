# Release rehearsal with the installed-consumer gate, 2026-11-02: one row failed

Produced by `scripts/release-rehearsal.sh --consumer` on commit `56e6a9d`, whose tree is identical to `main` at `ed41b28` (the squash of #36). The rehearsal **failed**: 23 of 24 installed-consumer rows passed and `loopback-only-listeners` failed with "28114 not listening on loopback". Every other step passed, and the release-evidence archive assembled and verified. This file is kept as the record of that run; the rerun after the fix is [`2026-11-02-release-rehearsal-consumer.md`](2026-11-02-release-rehearsal-consumer.md).

**Root cause: a race in the harness, not in the runner.** The row waits for the node RPC (`8114`) to listen and then probes the OffCKB proxy (`28114`) once. The proxy is a separate process that binds after the node. Three timed runs of the root manifest on the same host measured it listening 24, 75, and 84 ms after the node, and under the consumer matrix's load the single probe lost that race. The same ordering also weakened the passing case: the routable-address probe of `28114` could run before the proxy existed, so "unreachable on the host address" proved nothing about the proxy.

**Fix.** `scripts/acceptance-matrix.sh` now waits, bounded at 120 s, for `28114` on loopback before probing the routable address, and records a failure if the proxy never listens. The listener-scope assertion itself is unchanged and is now always made against a live proxy.

- candidate: `56e6a9d0c78c81aa347a267b248b45c332cd6155`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.0.2.tgz`
- tarball sha256: `5493f87d309b930a2a5a56e74e48136dd58abe117ed39b574dfa7e72b2acc8f5`
- release evidence: `dist/release-evidence-0.0.2-56e6a9d.tar.gz`
- release evidence sha256: `d8cbb3c8a31e6a687574746d0f4acfbe9fccb3b517e0add3fc3a8e8856c58a1a`
- date: 2026-11-02T03:46:52Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 4s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 2s |
| regression | `bun run check` | PASS | 42s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 5s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 90s |
| pack | `bun pm pack --destination dist` | PASS | 0s |
| consumer-acceptance | `scripts/acceptance-matrix.sh --consumer --results dist/acceptance-consumer.md` | FAIL | 214s |
| package-evidence | `bun run scripts/package-evidence.ts --out dist/evidence-secp-transfer-56e6a9d0c78c81aa347a267b248b45c332cd6155 --repository Akane-CN/spark-verify --source-sha 56e6a9d0c78c81aa347a267b248b45c332cd6155 --workflow rehearsal --job secp-transfer` | PASS | 1s |
| release-evidence | `bun run scripts/release-evidence.ts assemble --out dist/release-evidence-0.0.2-56e6a9d.tar.gz --bundle dist/evidence-secp-transfer-56e6a9d0c78c81aa347a267b248b45c332cd6155 --record dist/acceptance-consumer.md --repository Akane-CN/spark-verify --source-sha 56e6a9d0c78c81aa347a267b248b45c332cd6155` | PASS | 1s |
| verify-release-evidence | `bun run scripts/release-evidence.ts verify dist/release-evidence-0.0.2-56e6a9d.tar.gz --source-sha 56e6a9d0c78c81aa347a267b248b45c332cd6155 --repository Akane-CN/spark-verify` | PASS | 1s |

## Installed-consumer acceptance

mode: consumer; platform: Linux x86_64; bun 1.2.19; node v22.22.0; ckb-verify 0.0.2; project HEAD 8a2a89015f56552d8d348d5ea4e06aef11fd7cf2; 2026-11-02T03:46:49Z

| case | expected | observed | result |
| --- | --- | --- | --- |
| install | installed bin reports packed version 0.0.2 | 0.0.2 (tarball sha256 5493f87d309b930a2a5a56e74e48136dd58abe117ed39b574dfa7e72b2acc8f5) | PASS |
| tarball-contents | no tests, showcases, CI config, or media shipped | 43 files, src/schemas/patches/docs only | PASS |
| patch-active-after-install | 2 patched adm-zip callsites, adm-zip 0.6.1 resolved | 2 callsites, adm-zip 0.6.1 | PASS |
| install-without-patch-file | bun install refuses (missing patch file) | exit 1: could not find patch file | PASS |
| unpatched-offckb-refused | exit 2, no verdict, no runtime mutation | exit 2: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable ad | PASS |
| validate-offline | exit 0 without execution | exit 0 | PASS |
| committed-cold-cache | PASS exit 0, CKB download | exit 0 in 24s, outcome sha256:2ce799c38922e686… | PASS |
| report-identities | runner 0.0.2, source = project HEAD | runner 0.0.2, source 8a2a89015f56 dirty=false replay=stable | PASS |
| committed-warm-cache-repeat | PASS exit 0, equal outcome digest | exit 0 in 21s, outcome equal, environment equal | PASS |
| check-digest-repeat | exit 0 against first outcome | exit 0 | PASS |
| rejected-pinned-debugger | PASS exit 0, script error -11 via verified debugger | exit 0, code -11, debugger 1.1.1 | PASS |
| assertion-failure | FAIL exit 1; offline digest exit 0 with verdict FAIL | exit 1; digest exit 0, verdict FAIL | PASS |
| tampered-verdict-rejected | digest exit 1 INVALID | exit 1 | PASS |
| occupied-port | exit 2 busy diagnostic, listener untouched, no report | exit 2, listener alive | PASS |
| concurrent-exclusion | owner PASS exit 0; contender exit 2 busy; one report | A exit 0, B exit 2 | PASS |
| reuse-after-contention | PASS exit 0 | exit 0 | PASS |
| loopback-only-listeners | proxy reachable on 127.0.0.1 | 28114 not listening on loopback | FAIL |
| sigint-cleanup | exit 130, no report, accounts removed, ports released | exit 130, clean closeout | PASS |
| producer-timeout | exit 2 timed out, no report, clean closeout | exit 2 in 10s | PASS |
| tampered-debugger-cache | exit 2 no verdict, cache not repaired silently | exit 2: debugger executable checksum mismatch | PASS |
| debugger-reinstall-after-cleanup | PASS exit 0 after removing the tampered cache | exit 0 | PASS |
| download-failure-cold | exit 2 no verdict, clean closeout | exit 2: ERROR: Unable to connect. Is the computer able to access the url? | PASS |
| recovery-after-download-failure | PASS exit 0 | exit 0 | PASS |
| final-closeout | no accounts/pending, ports free | clean | PASS |

The release-evidence archive here was assembled from this host's showcase run, not from a hosted CI run; the release attaches the CI archive (release checklist, step 6).
No tag, release, or package was published by this rehearsal.
