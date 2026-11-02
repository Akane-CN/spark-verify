# Completion and budget report (draft)

> **Draft, prepared 2026-11-02 on the v0.1.0 candidate `e311ad3`.** The first candidate `d99117b` passed every gate and was then superseded by the fixes from its [pre-release review](acceptance/2026-11-02-candidate-review.md); `e311ad3` passed the same gates ([record](acceptance/2026-11-02-candidate-e311ad3.md)). The [Spark proposal revision 0.3](spark-proposal.md#12-application-status-and-remaining-gates) asks for a completion report and a budget report with the tagged release. This draft states what exists now; it is finalized when the release is published (release checklist step 8, approval on #20). Fields marked **maintainer** are facts only the maintainer holds and are not inferred here. Nothing in this draft is a billing claim.

## Completion report

### Outcome in one paragraph

`ckb-verify` v0.1.0 is built, frozen, and gated but not yet published. It runs a repository's `verify.toml` on a fresh local OffCKB devnet and writes a report whose claims, verdict, and environment anyone can re-verify offline. The v0.1 contract is frozen as manifest spec `0.1.0`, with the cycles, Cell, CKB balance, and UDT balance vocabulary the proposal promised. The first candidate passed every pre-publication gate on its exact commit ([record](acceptance/2026-11-02-candidate-d99117b.md)). An agent pre-review then found defects, including a high-severity source-guard bypass. They are fixed, and the re-frozen candidate `e311ad3` passed every gate again ([record](acceptance/2026-11-02-candidate-e311ad3.md)). The external half of the proposal did not happen: no OffCKB maintainer feedback was sought and no project pilot ran, so neither is claimed.

### Deliverables

The item-by-item record with evidence is the [proposal coverage](proposal-coverage.md). In summary:

| Deliverable | State | Evidence |
| --- | --- | --- |
| 1. Frozen `verify.toml` v0.1 contract | done | spec `0.1.0`, schemas, conformance corpus, and a lock test ([version policy](version-policy.md#the-frozen-v01-contract)) |
| 2. Installable CLI | done | `validate`, `run`, `digest`, `check-digest`, `check-bundle`; cycles, script-filtered Cells with data and capacity checks, CKB and 16-byte UDT balances; field-level diffs ([vocabulary](vocabulary-v0.1.md)) |
| 3. Release and CI package | done, except publication | reusable workflow, root dogfood manifest, `verify:release` 9/9, Ubuntu, macOS, and Windows statements backed by execution ([platform record](acceptance/2026-11-02-platform-boundary.md)); the tagged release is step 8 |
| 4. External pilot and upstream fit | not achieved | no outreach was sent, so there is no maintainer feedback and no consented pilot ([external checkpoints](external-checkpoints.md)); the CKB-UGMP showcase is feasibility only |
| 5. Completion evidence | done, except publication | documentation set, demo (shared on the Spark thread on 2026-10-15), exact-revision log for the candidate, this report |

### What the proposal promised and how it changed

- The vocabulary was first deferred by release decision 1 and then implemented after that decision was reopened, because deferring it would have narrowed promised scope ([release decisions](release-decisions.md)).
- The contract was first kept under draft identifiers by decision 6, then frozen as `0.1.0` when that decision was reopened.
- RFC items the proposal did not promise stay deferred and documented: repository script deployment, pure steps, and `expect.error.group`.

### Defects found by the release gates

Execution of the gates found and fixed real defects before the freeze, each with a regression test:

- a node-indexer race that could record a wrong empty selection;
- Windows path handling in bundle verification;
- release-evidence extraction under Bun on Windows;
- `run` writing a run directory before refusing an unsupported platform;
- a race in the acceptance harness's listener check.

Each is recorded in the `0.1.0` section of the [changelog](../CHANGELOG.md). An agent pre-review of the first candidate found more, the worst a source guard that a nested untracked repository switched off. Each finding and its disposition is in the [review record](acceptance/2026-11-02-candidate-review.md).

### What was not done

- Public OffCKB maintainer feedback (#2) and a consented project trial or demand/no-go report (#3). Both need outreach. The maintainer approved both texts on 2026-11-02 and will post them ([external checkpoints](external-checkpoints.md#week-8-amendment-2026-11-02-outreach-approved)); this item changes only when a post, and then a reply or the 2026-11-27 due date, exists.
- Independent review of the candidate by someone other than its authors. The agent pre-review does not count as one. The maintainer is arranging a reviewer, who follows the [independent review guide](independent-review-guide.md).
- Publication: tag, prerelease, and install-back of the published assets. The publication path is decided: a GitHub release only, with no registry package ([package identity](package-identity.md#decision-2026-11-02)). The maintainer runs it from the [v0.1.0 release runbook](release-runbook-v0.1.0.md) before the elliptic waiver expires on 2026-11-25.
- The reviewer-time measurement the proposal asked to replace its 15-minute estimate. It needs an outside reviewer's timing and does not exist yet.

### Maintenance after completion

The [maintenance loop](maintenance.md) is set up and exercised (#21): weekly and monthly checklists, the patch-release flow, and two consumer rehearsals. The proposal's 90-day triage commitment for critical breakage from a supported OffCKB/CKB release starts at publication.

## Budget report

| Work package (proposal §7) | Requested | Delivered |
| --- | ---: | --- |
| v0.1 schemas, compatibility rules, conformance fixtures | $250 | yes |
| Assertion vocabulary and field-level failure diffs | $300 | yes |
| CLI commands, installable package, root dogfood, tagged release | $200 | yes, except the tagged release (pending step 8) |
| Reusable CI and explicit platform support boundary | $100 | yes |
| External-pilot outreach or demand validation, upstream-fit feedback, demo, completion report | $150 | demo and this report only; no outreach, feedback, pilot, or demand/no-go report |
| **Total** | **$1,000** | |

- **Grant status:** **maintainer.** The proposal page and the Nervos Talk thread showed the application as pending review at the last check (2026-11-02).
- **Funds received:** **maintainer.** No payment is recorded in this repository.
- **Costs incurred:** **maintainer.** The repository uses GitHub and GitHub Actions only, and the proposal states that any paid CI overage is borne by the maintainer. No hosting or paid service is configured in the repository.
- **Unspent or unearned allocation:** if the grant is paid against the table above, the external-track package is not delivered as specified. How that is settled is a matter between the maintainer and the Spark committee, not something this report decides.
