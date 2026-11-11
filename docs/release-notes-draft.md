# Release notes draft: `ckb-verify` v0.1.0 candidate

> **Published.** These notes went out as [`v0.1.0`](https://github.com/Akane-CN/spark-verify/releases/tag/v0.1.0) on 2026-11-11, with the identity table retitled and the evidence archive's checksum filled in. The installed-back check of the published assets passed ([record](acceptance/2026-11-11-v0.1.0-install-back.md)). The rest of this paragraph is the draft's original text.
>
> **Draft.** No tag, release, or package exists. The candidate fields below are filled from the frozen candidate, on which [release checklist](release-checklist.md) steps 1–6 passed; the document is published only under step 8, with the maintainer's approval on #20 confirmed for this candidate. The `elliptic` waiver expires 2026-12-25, so publication from this candidate must happen by 2026-12-24.

## Candidate

| Field | Value |
| --- | --- |
| Candidate commit | `9b39a9882b0b4250e713cce556eef0a7dc3809b8` (frozen 2026-11-10, #49; supersedes `e311ad3` and the same-day `1ae9231`) |
| Hosted CI run | Verify run 42730133984, every job green including `verify-evidence`; Platform boundary run 42730191970 on the same commit |
| Package tarball | `ckb-verify-0.1.0.tgz`, sha256 `c3817135748229a4733b222de2b3d3e5f70efe957692153dd011fe5e48f47421` (reproducible from the candidate tree) |
| Release evidence | CI artifact 13724223446: `release-evidence-9b39a9882b0b4250e713cce556eef0a7dc3809b8.tar.gz`, sha256 `e8c9fb30f0fe9f169e0cec7c7daeef2a6d07773ccd97c44d787faff08d90b079`, five bundles and 29 reports; the archive attached at step 8 is re-assembled from it with the records below, and its checksum is recorded then |
| Acceptance records | [`2026-11-10-candidate-9b39a98.md`](acceptance/2026-11-10-candidate-9b39a98.md) (steps 1–6), with the source matrix, the release rehearsal including the consumer matrix, and the release surface beside it |

## What this release is

`ckb-verify` runs a repository's `verify.toml` on a fresh local OffCKB devnet, submits the one signed transaction each step produces, checks the declared expectations and assertions, and writes a `report.json` whose claims, verdict, and environment can be re-verified offline by anyone holding the file (`validate`, `digest`, `check-digest`, `check-bundle`). Its main use is a developer's own acceptance and regression checks, run locally and in CI; maintainers and reviewers read, compare, and re-verify the reports. **PASS means every declared claim passed in the recorded environment.** It is not a security audit, a sandbox, a proof of determinism, or proof that a manifest is complete.

Since the previous candidate (`e311ad3`), this candidate adds:

- **Spec `0.2.0`** ([vocabulary](vocabulary-v0.2.md)): repository script binaries deployed by the runner (`[setup.scripts]`), named script references, pure steps, zero steps and zero accounts, `expect.error.group`, terminal node rejections with their RPC code, lockfile and runtime pins, a sanitized repository identity, the devnet sealing fingerprint, and a pinned genesis allowlist. `run --report <file>` and `run --json`.
- **Failure stages:** a run that ends without a verdict names the stage it stopped in (`ERROR [stage]: …`, and `stage` in `--json`).
- **The local console** `ckb-verify ui` ([guide](console.md)): validate a manifest, start a run and watch its stages, read a report with each transaction drawn as input and output Cells, compare two runs, and re-verify any report offline.
- **One-command project setup:** `src/setup-project.ts` installs the tarball into a project and can write an example that passes as written ([installation guide](install.md#the-short-way-setup-project)). It runs straight out of the tarball.
- **Download retries:** the pinned CKB and `ckb-debugger` downloads are retried on a network error or HTTP 408, 429, or 5xx, up to four attempts, with the same length and checksum checks on every attempt.
- **CI cache:** the reusable workflow and this repository's showcase jobs restore the verified CKB and debugger installs from a cache; the runner re-checks them against its pins.

## Supported

Exactly one combination was exercised end to end and is claimed: **Linux x64, Bun 1.2.19, Node.js 22** (OffCKB declares Node 20 or newer; 20 was not exercised), installed from the packed tarball into a separate project per [`docs/install.md`](install.md). Toolchain pins: OffCKB `0.4.13` with the shipped patch, CKB `0.209.0`, `ckb-debugger 1.1.1`, `@ckb-ccc/core 1.14.0`. See [supported combinations](maintenance.md#supported-combinations).

Not supported: devnet execution (`run`) anywhere but Linux x64, other architectures, Node-only execution, other Bun versions, testnet or mainnet execution. On macOS 15 and Windows Server 2022 the offline commands (`validate`, `digest`, `check-digest`, `check-bundle`) are verified by the platform boundary workflow, and `run` is refused before it writes anything.

## Formats

- Manifest specs `0.2.0` (frozen; `schemas/ckb-verify-manifest-v2.schema.json`), `0.1.0` (the frozen v0.1 contract), `0.1.0-draft.5` (the same grammar), `0.1.0-draft.4`, and `0.1.0-draft.3` (`schemas/ckb-verify-manifest-v1.schema.json`).
- Reports written: `ckb-verify-report/4` with `outcome/4`, `environment/5`, and `provenance/4` for `0.2.0`; `/3` with `environment/4` + `provenance/3` for `0.1.0` and draft.5; `/1` and `/2` with `environment/3` + `provenance/2` for draft.3 and draft.4. Read only with `--allow-legacy`: `/1` with `environment/2` + `provenance/1` (`schemas/ckb-verify-report.schema.json`).
- Evidence bundles `ckb-verify-evidence-bundle/1`, release evidence `ckb-verify-release-evidence/1`.

The rules are in [version policy](version-policy.md); unsupported tuples are rejected explicitly, never migrated silently. Two contracts are frozen, each by a lock test: spec `0.1.0` with report `/3` ([version policy](version-policy.md#the-frozen-v01-contract)) and spec `0.2.0` with report `/4` ([version policy](version-policy.md#the-frozen-020-contract)). The draft identifiers stay accepted.

## Known limitations

- The RFC is not implemented in full: the [implementation matrix](rfc-implementation-matrix.md) marks every item supported, partial, or deferred, and the [release decisions](release-decisions.md) record why. Out of scope: declarative transaction construction, seeded genesis Cells, testnet or mainnet execution, HTML reports.
- One transaction per step. Exactly one CKB release (`0.209.0`) has pinned assets.
- Repository binaries (`0.2.0`) must be 1–512000 bytes and contain a byte above `0x7f`, because OffCKB `0.4.13` refuses or skips anything else. When binaries are deployed, the deployer is OffCKB account 19, so a manifest may declare at most 19 accounts.
- Trusted repositories only: `verify.toml` is executable code and there is no sandbox ([`SECURITY.md`](../SECURITY.md)). This applies equally to runs started from the console. A step that detaches a background process (redirected output, or `setsid`) is not tracked after the step returns or is killed; that process keeps running.
- The source guard needs a git repository with at least one commit. Outside one there is nothing to compare, and reports are marked `tainted` (`source_revision_unavailable`). Inside one, any snapshot failure, such as an untracked nested repository, refuses the run. It compares Git-visible snapshots before and after a run; it does not monitor execution continuously.
- Offline verification checks the recorded CKB binary against its own archive checksum, not against the runner's pin table. For report `/3` a script rejection's group is checked against the transaction for outputs, and only by bounds for inputs; report `/4` retains the consumed input Cells and checks both.
- Listener scope is loopback for RPC `8114` and proxy `28114`, and the console binds `127.0.0.1` with a per-start token; the peer-to-peer port follows OffCKB's configuration. Network isolation beyond that is the host's job.
- Offline validity is internal consistency, not authenticity: there is no signature.
- Balance claims aggregate every live Cell under a lock, so their outcome digests repeat across fresh devnets only when the genesis Cells repeat.
- A low-severity `elliptic` advisory is waived until 2026-12-25 (renewed once) for disposable devnet keys only ([`SECURITY.md`](../SECURITY.md)); the waiver must be unexpired on the release date.

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
