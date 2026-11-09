# Release notes draft: `ckb-verify` v0.1.0 candidate

> **Draft.** No tag, release, or package exists. The candidate fields below are filled from the re-frozen candidate, on which [release checklist](release-checklist.md) steps 1–6 passed; the document is published only under step 8 with explicit authorization on #20. The `elliptic` waiver expires 2026-11-25, so publication from this candidate must happen by 2026-11-24.

## Candidate

| Field | Value |
| --- | --- |
| Candidate commit | `e311ad3db8cc58f751928f01c881646da45f5a72` (re-frozen 2026-11-02, #42; supersedes `d99117b` after the [pre-release review](acceptance/2026-11-02-candidate-review.md)) |
| Hosted CI run | Verify run 41507235776, every job green including `verify-evidence`; Platform boundary run 41507336019 on the same commit |
| Package tarball | `ckb-verify-0.1.0.tgz`, sha256 `61fca14b5b00762021b13bd67049aed01da41e9b45053cdb08a554e2ee8eda0b` (reproducible from the candidate tree) |
| Release evidence | CI artifact 13172620526: `release-evidence-e311ad3db8cc58f751928f01c881646da45f5a72.tar.gz`, sha256 `a11307e0e3aed8675c66cf3f5847244f2532b5666ead7f865e9462d7fb8ab40f`; the archive attached at step 8 is re-assembled from it with the records below, and its checksum is recorded then |
| Acceptance records | [`2026-11-02-candidate-e311ad3.md`](acceptance/2026-11-02-candidate-e311ad3.md) (steps 1–6), with the source matrix, the release rehearsal including the consumer matrix, and the release surface beside it |

## What this release is

`ckb-verify` runs a repository's `verify.toml` on a fresh local OffCKB devnet, submits the one signed transaction each step produces, checks the declared expectations and assertions, and writes a `report.json` whose claims, verdict, and environment can be re-verified offline by anyone holding the file (`validate`, `digest`, `check-digest`, `check-bundle`). **PASS means every declared claim passed in the recorded environment.** It is not a security audit, a sandbox, a proof of determinism, or proof that a manifest is complete.

## Supported

Exactly one combination was exercised end to end and is claimed: **Linux x64, Bun 1.2.19, Node.js 22** (OffCKB declares Node 20 or newer; 20 was not exercised), installed from the packed tarball into a separate project per [`docs/install.md`](install.md). Toolchain pins: OffCKB `0.4.13` with the shipped patch, CKB `0.209.0`, `ckb-debugger 1.1.1`, `@ckb-ccc/core 1.14.0`. See [supported combinations](maintenance.md#supported-combinations).

Not supported: devnet execution (`run`) anywhere but Linux x64, other architectures, Node-only execution, other Bun versions, testnet or mainnet execution. On macOS 15 and Windows Server 2022 the offline commands (`validate`, `digest`, `check-digest`, `check-bundle`) are verified by the platform boundary workflow, and `run` is refused before it writes anything.

## Formats

- Manifest specs `0.1.0` (the frozen v0.1 contract), `0.1.0-draft.5` (the same grammar), `0.1.0-draft.4`, and `0.1.0-draft.3` (`schemas/ckb-verify-manifest-v1.schema.json`); `0.1.0` carries the [assertion vocabulary](vocabulary-v0.1.md).
- Reports `ckb-verify-report/1` and `/2` with `environment/3` + `provenance/2`, and `/3` with `environment/4` + `provenance/3`, written; `/1` with `environment/2` + `provenance/1` read with `--allow-legacy` (`schemas/ckb-verify-report.schema.json`).
- Evidence bundles `ckb-verify-evidence-bundle/1`, release evidence `ckb-verify-release-evidence/1`.

The rules are in [version policy](version-policy.md); unsupported tuples are rejected explicitly, never migrated silently. The v0.1 contract is frozen as spec `0.1.0` with report `/3`, outcome `/3`, environment `/4`, and provenance `/3`; what frozen means and how a lock test checks it is in the [version policy](version-policy.md#the-frozen-v01-contract) ([release decision 6, reopened](release-decisions.md#2026-11-02-decision-6-reopened-the-v01-contract-is-frozen-as-spec-010)). The draft identifiers stay accepted.

## Known limitations

- The RFC v0.2 vocabulary is only partly implemented; the [implementation matrix](rfc-implementation-matrix.md) marks every item supported, partial, or deferred; the six release decisions are recorded in [release decisions](release-decisions.md): decision 1 was reopened on 2026-11-02 and the promised vocabulary (`expect.cycles`, script-filtered Cells with `count`/`data`/`capacity`, CKB and UDT `balance`, script references) ships as the frozen spec `0.1.0` (first published as `0.1.0-draft.5`); `[setup.scripts]` deployment, named setup-script references, pure steps, `accounts = 0`, and `expect.error.group` remain v0.3 proposals.
- Trusted repositories only: `verify.toml` is executable code and there is no sandbox ([`SECURITY.md`](../SECURITY.md)). A step that detaches a background process (redirected output, or `setsid`) is not tracked after the step returns or is killed; that process keeps running.
- The source guard needs a git repository with at least one commit. Outside one there is nothing to compare, and reports are marked `tainted` (`source_revision_unavailable`). Inside one, any snapshot failure, such as an untracked nested repository, refuses the run.
- Offline verification checks the recorded CKB binary against its own archive checksum, not against the runner's pin table. It checks a script rejection's group against the transaction for outputs; for an input it checks only the bounds, because the consumed Cell is not retained.
- Listener scope is loopback for RPC `8114` and proxy `28114`; the peer-to-peer port follows OffCKB's configuration. Network isolation beyond that is the host's job.
- The source guard compares Git-visible snapshots before and after a run; it does not monitor execution continuously.
- Offline validity is internal consistency, not authenticity: there is no signature.
- One transaction per step; no repository script deployment (`[setup.scripts]`), named setup-script references, pure steps, or `expect.error.group` (deferred per the matrix). Balance claims aggregate every live Cell under a lock, so their outcome digests repeat across fresh devnets only when the genesis Cells repeat.
- A low-severity `elliptic` advisory is waived until 2026-11-25 for disposable devnet keys only ([`SECURITY.md`](../SECURITY.md)); the waiver must be unexpired on the release date.

## What was not run

- No devnet execution on any platform other than Linux x64 / Bun 1.2.19. macOS 15 and Windows Server 2022 ran the install, the platform-independent tests, and the offline commands only ([platform boundary record](acceptance/2026-11-02-platform-boundary.md)).
- No external pilot: no project maintainer was asked for or gave consent, and no OffCKB maintainer feedback exists ([external checkpoints](external-checkpoints.md)). The CKB-UGMP showcase is a feasibility adaptation, not adoption.
- No install from the npm registry (`TBD`: repeat the consumer matrix against the published package if registry publication is chosen).

## Upgrade, deprecation, rollback

See [maintenance](maintenance.md#upgrade-deprecation-and-rollback-for-consumers) and the [release checklist](release-checklist.md#rollback). Consumers keep `patches/@offckb%2Fcli@0.4.13.patch` and its declarations until a changelog entry says the OffCKB pin changed.

## Verify this release yourself

1. `sha256sum -c SHA256SUMS` on the downloaded tarball and `sha256sum -c release-evidence-0.1.0-<sha>.tar.gz.sha256` on the evidence archive (the archive re-assembled at step 6 with the acceptance records; the CI artifact is `release-evidence-<sha>.tar.gz`).
2. Extract the archive, `sha256sum -c --strict SHA256SUMS` inside it, then `ckb-verify check-bundle <bundle> --source-sha <sha> --repository Akane-CN/spark-verify` for each bundle ([offline verification](offline-verification.md#release-evidence-archive)).
3. Install per [`docs/install.md`](install.md) and run your own manifest; compare `environment.runner.version` with `ckb-verify --version`.

## Changes since 0.0.2

The [`0.1.0` section of `CHANGELOG.md`](../CHANGELOG.md), moved from `Unreleased` in the release commit.
