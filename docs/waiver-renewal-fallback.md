# Elliptic waiver renewal fallback

> **Applied on 2026-11-10.** The patch below was applied to `main` as part of the close-out hardening, because v0.1.0 had not been published and a new candidate was being frozen anyway. On that day `bun run check:supply-chain` still reported exactly the one `elliptic` finding, and the npm registry still listed `elliptic` `6.6.1` as the latest release. The waiver now expires on **2026-12-25**; the next reassessment is due before then. The text below is kept as written on 2026-11-03.

Prepared on 2026-11-03 for [#20](https://github.com/Akane-CN/spark-verify/issues/20). Use it **only if v0.1.0 cannot be published from the frozen candidate `e311ad3` by 2026-11-24**. The usual reasons are an independent-review finding that needs a code change, or a missed date.

On 2026-11-25T00:00Z the `elliptic` waiver in `src/supply-chain.ts` expires. From then on, `check:supply-chain` and `bun run check` fail on `e311ad3` and on every later commit, and [runbook](release-runbook-v0.1.0.md) step 1 cannot pass. `SECURITY.md` allows no automatic renewal: a renewal is the owner's reviewed decision, recorded in both the policy and the gate.

This file prepares that decision. It does not make it, and nothing here is applied:

- the evidence the owner reviews, reassessed on 2026-11-03;
- a tested patch, [`fallback/elliptic-waiver-renewal.patch`](fallback/elliptic-waiver-renewal.patch);
- the steps that turn the patch into a new release candidate.

## Reassessment (2026-11-03)

Re-checked against what the 2026-10-26 review covered: advisory metadata, dependency paths, reachability, and upstream replacement options.

**Advisory, unchanged.** `bun audit --json` reports exactly one finding: `elliptic`, audit ID `1112030`, severity `low`, <https://github.com/advisories/GHSA-848j-6mx2-7j84>, vulnerable `<=6.6.1`, "Elliptic Uses a Cryptographic Primitive with a Risky Implementation". The ID, severity, and URL match the allowlist entry, and there is no second finding.

**Dependency path, unchanged.** There is one installed `elliptic@6.6.1`, reached only through `@ckb-ccc/core` → `@joyid/ckb@1.1.4` → `@nervosnetwork/ckb-sdk-utils@0.109.5`, which pins `elliptic` `6.6.1` exactly. `@ckb-ccc/core@1.14.0` comes in both directly and through `@offckb/cli@0.4.13`, which pins it exactly. The showcase-only `@ckb-ccc/spore` → `@ckb-ccc/core@1.12.5` shares the same `@joyid/ckb`.

**Upstream replacement, none available.** Checked on the npm registry on 2026-11-03:

| Package | Latest | Published | Still leads to `elliptic`? |
| --- | --- | --- | --- |
| `elliptic` | `6.6.1` | 2024-11-13 | it is the vulnerable release; there is no fixed one |
| `@nervosnetwork/ckb-sdk-utils` | `0.109.5` | 2025-02-14 | yes, pins `elliptic` `6.6.1` |
| `@joyid/ckb` | `1.1.4` | 2026-03-13 | yes, through `ckb-sdk-utils` `^0.109.5` |
| `@ckb-ccc/core` | `1.23.0` | 2026-09-26 | yes, through `@joyid/ckb` `^1.1.4` |

Upgrading CCC would not remove the advisory, and it would also break OffCKB's exact `1.14.0` pin. `SECURITY.md` rules out forcing an unrelated cryptographic implementation into place with an override.

**Reachability, measured.** The 2026-10-26 review reasoned that signing goes through CCC's `@noble/curves` signer, not `elliptic`. This reassessment measured that on `main` `4fa7fd1`, using a clean worktree on Linux x86_64 with Bun `1.2.19` and Node `v22.22.0`:

- [`scripts/trace-elliptic-preload.cjs`](../scripts/trace-elliptic-preload.cjs) was preloaded into every Bun process (through a local `bunfig.toml`, excluded from Git so the source guard stays clean) and every Node process (through `NODE_OPTIONS`, which reaches OffCKB). It wraps every method on `elliptic`'s `ec` and key-pair prototypes: `keyFromPrivate`, `keyFromPublic`, `genKeyPair`, `sign`, `verify`, `recoverPubKey`, `getPublic`, `derive`.
- **Positive control:** a direct `elliptic` sign was recorded. A `ccc.SignerCkbPrivateKey` signature in the same process recorded no call.
- **Real runs:** all four showcases (`secp-transfer`, `cell-properties`, `ckb-ugmp`, `vocabulary`) passed with the probe active. The probe was active in 302 processes: 191 OffCKB, 21 CLI runs, 21 producers, plus digest and helper processes. It recorded **zero** `elliptic` method calls.

The measurement covers those code paths, not every possible manifest. A repository producer that imports `@joyid/ckb` or `ckb-sdk-utils` itself would reach `elliptic`. That is why the waiver stays limited to disposable devnet keys.

**Assessment.** Nothing the waiver relied on has changed, and the one assumption that was reasoned has now been measured. The risk accepted is the same as on 2026-10-26: a low-severity defect in code that the runner's own paths do not call, under disposable devnet keys. Renewal does not widen the trust boundary.

## Reassessment (2026-11-11)

The second renewal review, done on `main` at `cab280e` (the source of the v0.1.0 candidate `9b39a98` plus records). It repeats the four checks above, and extends the reachability measurement to code that did not exist on 2026-11-03: spec `0.2.0`, repository script deployment, and the repository-script showcase.

**Advisory, unchanged.** `bun audit --json` reports exactly one finding: `elliptic`, audit ID `1112030`, severity `low`, <https://github.com/advisories/GHSA-848j-6mx2-7j84>, vulnerable `<=6.6.1`. The ID, severity, and URL match the allowlist entry, and there is no second finding.

**Dependency path, unchanged.** One installed `elliptic@6.6.1`, reached through `@ckb-ccc/core@1.14.0` → `@joyid/ckb@1.1.4` → `@nervosnetwork/ckb-sdk-utils@0.109.5`, which pins `elliptic` `6.6.1` exactly. `@offckb/cli@0.4.13` pins `@ckb-ccc/core` `1.14.0` exactly.

**Upstream replacement, none available.** The npm registry on 2026-11-11 lists the same latest releases as on 2026-11-03:

| Package | Latest | Published | Still leads to `elliptic`? |
| --- | --- | --- | --- |
| `elliptic` | `6.6.1` | 2024-11-13 | it is the vulnerable release; there is no fixed one |
| `@nervosnetwork/ckb-sdk-utils` | `0.109.5` | 2025-02-14 | yes, pins `elliptic` `6.6.1` |
| `@joyid/ckb` | `1.1.4` | 2026-03-13 | yes, through `ckb-sdk-utils` `^0.109.5` |
| `@ckb-ccc/core` | `1.23.0` | 2026-09-26 | yes, through `@joyid/ckb` `^1.1.4` |
| `@offckb/cli` | `0.4.13` | 2026-08-17 | yes, pins `@ckb-ccc/core` `1.14.0` |

**Reachability, measured again and wider.** The probe [`scripts/trace-elliptic-preload.cjs`](../scripts/trace-elliptic-preload.cjs) was preloaded into every Bun and Node process, as on 2026-11-03, in a clean clone on Linux x86_64 with Bun `1.2.19` and Node `v22.22.0`:

- **Positive control:** a direct `elliptic` signature recorded 4 calls. A `ccc.SignerCkbPrivateKey` signature in a separate process recorded none.
- **Real runs:** all five showcases passed with the probe active: `secp-transfer`, `cell-properties`, `ckb-ugmp`, `vocabulary`, and `repository-script`. The probe was active in 466 processes: 291 OffCKB, 31 CLI runs, 41 producers, plus build, digest, and helper processes. It recorded **zero** `elliptic` method calls and no preload error.
- The first four showcases loaded the probe in 302 processes, the same count as on 2026-11-03. The repository-script showcase adds 164, including the `offckb deploy` runs that spec `0.2.0` introduced.

The limits are the same as before. The measurement covers these code paths, not every possible manifest, and a repository producer that imports `@joyid/ckb` or `ckb-sdk-utils` itself would reach `elliptic`. The waiver stays limited to disposable devnet keys.

**Assessment and decision.** Nothing the waiver relies on has changed, and the measurement now covers the `0.2.0` paths. The waiver is renewed a second time: review date 2026-11-11, expiry **2027-01-25T00:00:00Z**, one month after the previous expiry. Advisory identity, severity, URL, and scope are unchanged, and the gate still rejects any other finding. The next reassessment is due before 2027-01-25, and sooner if any of the four checks changes. To undo this renewal, restore `reviewedOn` `2026-11-03` and `expiresAt` `2026-12-25T00:00:00Z` in `src/supply-chain.ts`, with the matching dates in `tests/supply-chain.test.ts` and `SECURITY.md`.

This renewal does not change the v0.1.0 candidate. `9b39a98` is released by its SHA and still carries the 2026-12-25 expiry, so publishing from it must happen by 2026-12-24.

## The patch

[`fallback/elliptic-waiver-renewal.patch`](fallback/elliptic-waiver-renewal.patch) changes three files:

- `src/supply-chain.ts`: `reviewedOn` `2026-10-26` → `2026-11-03`; `expiresAt` `2026-11-25T00:00:00Z` → `2026-12-25T00:00:00Z`.
- `tests/supply-chain.test.ts`: the expiry test moves to the new deadline, and the review-date clock moves to `2026-11-03`.
- `SECURITY.md`: the new review date with a link to this record, the new expiry, and "no fixed release as of 2026-11-03".

It was tested on 2026-11-03. `bun test tests/supply-chain.test.ts` passes, 8/8. The real `bun audit --json` output was also evaluated by both gates at injected clocks:

| Clock (UTC) | Current gate | Renewed gate |
| --- | --- | --- |
| 2026-11-24T23:59:59 | passes | passes |
| 2026-11-25T00:00:00 | fails: waiver expired | passes |
| 2026-12-24T23:59:59 | fails | passes |
| 2026-12-25T00:00:00 | fails | fails: waiver expired |

The patch shifts the window by one month. It does not remove the expiry, does not change the advisory identity, severity, or URL, and does not admit a second finding.

## If the fallback is needed

1. **Owner's decision.** The owner reviews the reassessment above and records the decision on #20: renew to 2026-12-25, or decline. If the owner declines, nothing can be released until upstream ships a fixed release; that is recorded on #20 too. If the review happens after 2026-11-03, first refresh the four checks above, then set the review date to that day in the patch's `src/supply-chain.ts`, `tests/supply-chain.test.ts`, and `SECURITY.md` lines.
2. **Apply and merge.** On a branch from `main`, run `git apply docs/fallback/elliptic-waiver-renewal.patch`. If it no longer applies, make the same edits by hand. Then run `bun run check`, and merge as a normal reviewed PR. The merged commit is the new candidate `N`. Between `e311ad3` and `main` no shipped file has changed, so `N`'s package differs from `e311ad3`'s only in `src/supply-chain.ts` and `SECURITY.md` (`git diff e311ad3 N -- $(node -p "require('./package.json').files.join(' ')")` shows it).
3. **Re-gate `N`.** Run [release checklist](release-checklist.md) steps 1–6, as for `e311ad3`:
   - hosted `Verify` CI on `N`;
   - a `platform-boundary.yml` dispatch on `N`;
   - the source matrix;
   - `verify:release`;
   - `scripts/release-rehearsal.sh --consumer`;
   - the CI release evidence, downloaded and verified.

   File the records as `docs/acceptance/<date>-candidate-<N>*.md`. The new tarball checksum replaces `61fca14b…`.
4. **Review.** If the independent review of `e311ad3` is already recorded, the reviewer confirms the delta `e311ad3..N` on #20; that delta is this patch plus documentation. Otherwise the review is of `N`, following the [review guide](independent-review-guide.md) with the candidate fields updated.
5. **Refresh the candidate fields**: [runbook](release-runbook-v0.1.0.md) (`SHA`, `RUN`, tarball checksum, the "finish by" date, now **2026-12-24**), [release notes draft](release-notes-draft.md) (candidate fields and the waiver line), [completion report](completion-report.md), and [package identity](package-identity.md) where it names `e311ad3`.
6. **Publish** from `N` by following the updated runbook.

If the fallback is not needed, because v0.1.0 is published from `e311ad3` by 2026-11-24, this file and the patch stay as the record of a decision that did not have to be made.

## Separate from the release: `main` also stops passing on 2026-11-25

The expiry applies to `main` as well. Unless the waiver is renewed, or upstream fixes the advisory first, every CI run and every weekly maintenance run fails from 2026-11-25. That holds even if v0.1.0 ships on time.

So the owner may want to apply the same renewal to `main` before 2026-11-25, whatever happens to the release. Doing so does not change `e311ad3`, which is released by its SHA. It is still a waiver renewal and needs the same review. The [maintenance log](maintenance-log.md) tracks this from week to week.
