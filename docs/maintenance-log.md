# Maintenance log

One dated entry per maintenance run, newest first. Each entry records the [weekly checklist](maintenance.md#weekly-checklist) on an exact `main` commit, what it found, and what was decided. Monthly pin reviews are entered here too. An entry records results; it does not open work. Anything actionable becomes a GitHub issue, which stays the only backlog.

## 2026-11-03: weekly checklist on `main` `a44d011`

First routine run after the setup rehearsals (#21). `main` was `a44d0115604c2c536197bcaf47baf4445964ee80`. That is #44, which changes only documentation and `scripts/acceptance-matrix.sh` relative to the frozen candidate `e311ad3`; nothing under `src/` changed. The run used a clean worktree of that commit on Linux x86_64 with Bun `1.2.19` and Node `v22.22.0`.

| Step | Command or check | Result |
| --- | --- | --- |
| 1. Install | `bun install --frozen-lockfile` | PASS, 173 packages |
| 2. Regression | `bun run check` | PASS: 960 tests, 0 failures, type check, supply-chain gate (46 s) |
| 2. Documentation | `./scripts/validate-docs.sh --examples` | PASS: 60 files, 0 issues |
| 3. Devnet regression | `bun run showcase:secp-transfer` | PASS (90 s); stable outcome `sha256:fe66eb25…` equals the documented [evidence report](evidence-report.md) digest. The other three showcases were not required (no `src/` change) and passed on `a44d011` in CI |
| 4. Dependency audit | `bun run check:supply-chain`, `bun audit` | PASS. The only advisory is the waived `elliptic` `GHSA-848j-6mx2-7j84` (low), via `@ckb-ccc/core` → `@joyid/ckb` → `@nervosnetwork/ckb-sdk-utils`. No new advisory |
| 5. Triage | open issues | No new external issue or report. Open: #2, #3 (external tracks), #13 (roadmap), #20 (release), #21 (this loop), and #39 (post-v0.1 direction, labelled `rfc`, not v0.1 scope) |
| 6. Roadmap and CI | latest `main` runs | `Verify` run 41590793035 on `a44d011`: all seven jobs PASS, including `Download and verify evidence bundles`. #20 updated on 2026-11-03 with the decisions of #44 |
| 7. Checkpoints | [external checkpoints](external-checkpoints.md) | Week 8 is due 2026-11-27, recorded early, and amended on 2026-11-02: outreach approved, for the maintainer to post. No post is linked yet, so both tracks still read **no outreach sent** |

**Waiver watch.** The `elliptic` waiver in `src/supply-chain.ts` expires at **2026-11-25T00:00Z**, 22 days after this run. `elliptic` `6.6.1` (2024-11-13) is still the newest release on the npm registry, so there is nothing to upgrade to. Two outcomes are possible:

- The release is published from `e311ad3` by 2026-11-24, as the [runbook](release-runbook-v0.1.0.md) requires.
- The waiver is renewed through a reviewed change with an owner, date, and justification in `SECURITY.md`. That change is a new candidate. From 2026-11-25, `bun run check` fails on every commit until one of the two happens.

The next weekly run must check which outcome applies.

**CI observation, not a follow-up.** In PR #44's run 41524964887, the `Cell properties showcase` job failed in about one second. The pinned CKB archive download returned HTTP 500. The CLI exited 2 without a verdict, and the showcase's closeout found no leftover files or listening ports. That is the behaviour the `download-failure-cold` acceptance case requires. A single re-run passed. This is the only re-run in the window. If an upstream download failure recurs, the follow-up is an issue to cache the verified CKB archive between CI jobs; one occurrence does not justify it.

**Decisions.** No pin change. No issue opened. Nothing published.
