# Release notes draft: `ckb-verify` v0.1.0 candidate

> **Draft.** No tag, release, or package exists. Fields marked `TBD` are filled from the frozen candidate when [release checklist](release-checklist.md) steps 1–7 pass; the whole document is published only under step 8 with explicit authorization on #20.

## Candidate

| Field | Value |
| --- | --- |
| Candidate commit | `TBD` (immutable `main` SHA) |
| Hosted CI run | `TBD` (run id; all jobs green including `verify-evidence`) |
| Package tarball | `ckb-verify-0.1.0.tgz`, sha256 `TBD` |
| Release evidence | `release-evidence-<sha>.tar.gz`, sha256 `TBD`, from artifact id `TBD` |
| Acceptance records | `docs/acceptance/<date>-source-matrix.md`, `<date>-consumer-matrix.md`, `<date>-release-rehearsal.md` on the candidate |

## What this release is

`ckb-verify` runs a repository's `verify.toml` on a fresh local OffCKB devnet, submits the one signed transaction each step produces, checks the declared expectations and assertions, and writes a `report.json` whose claims, verdict, and environment can be re-verified offline by anyone holding the file (`validate`, `digest`, `check-digest`, `check-bundle`). **PASS means every declared claim passed in the recorded environment.** It is not a security audit, a sandbox, a proof of determinism, or proof that a manifest is complete.

## Supported

Exactly one combination was exercised end to end and is claimed: **Linux x64, Bun 1.2.19, Node.js 22 (any ≥ 20)**, installed from the packed tarball into a separate project per [`docs/install.md`](install.md). Toolchain pins: OffCKB `0.4.13` with the shipped patch, CKB `0.209.0`, `ckb-debugger 1.1.1`, `@ckb-ccc/core 1.14.0`. See [supported combinations](maintenance.md#supported-combinations).

Not supported: macOS, Windows, other architectures, Node-only execution, other Bun versions, testnet or mainnet execution.

## Formats

- Manifest specs `0.1.0-draft.3`, `0.1.0-draft.4`, and `0.1.0-draft.5` (`schemas/ckb-verify-manifest-v1.schema.json`); draft.5 carries the [assertion vocabulary](vocabulary-draft.5.md).
- Reports `ckb-verify-report/1` and `/2` with `environment/3` + `provenance/2`, and `/3` with `environment/4` + `provenance/3`, written; `/1` with `environment/2` + `provenance/1` read with `--allow-legacy` (`schemas/ckb-verify-report.schema.json`).
- Evidence bundles `ckb-verify-evidence-bundle/1`, release evidence `ckb-verify-release-evidence/1`.

The rules are in [version policy](version-policy.md); unsupported tuples are rejected explicitly, never migrated silently. Manifest spec identifiers at release stay `0.1.0-draft.3`, `0.1.0-draft.4`, and `0.1.0-draft.5`; no `0.1.0` spec string is introduced ([release decision 6](release-decisions.md#6-spec-naming-at-release-draft-identifiers-stay)).

## Known limitations

- The RFC v0.2 vocabulary is only partly implemented; the [implementation matrix](rfc-implementation-matrix.md) marks every item supported, partial, or deferred; the six release decisions are recorded in [release decisions](release-decisions.md): decision 1 was reopened on 2026-11-02 and the promised vocabulary (`expect.cycles`, script-filtered Cells with `count`/`data`/`capacity`, CKB and UDT `balance`, script references) ships as `0.1.0-draft.5`; `[setup.scripts]` deployment, named setup-script references, pure steps, `accounts = 0`, and `expect.error.group` remain v0.3 proposals.
- Trusted repositories only: `verify.toml` is executable code and there is no sandbox ([`SECURITY.md`](../SECURITY.md)).
- Listener scope is loopback for RPC `8114` and proxy `28114`; the peer-to-peer port follows OffCKB's configuration. Network isolation beyond that is the host's job.
- The source guard compares Git-visible snapshots before and after a run; it does not monitor execution continuously.
- Offline validity is internal consistency, not authenticity: there is no signature.
- One transaction per step; no repository script deployment (`[setup.scripts]`), named setup-script references, pure steps, or `expect.error.group` (deferred per the matrix). Balance claims aggregate every live Cell under a lock, so their outcome digests repeat across fresh devnets only when the genesis Cells repeat.
- A low-severity `elliptic` advisory is waived until 2026-11-25 for disposable devnet keys only ([`SECURITY.md`](../SECURITY.md)); the waiver must be unexpired on the release date.

## What was not run

- No platform other than Linux x64 / Bun 1.2.19.
- No external pilot: no project maintainer was asked for or gave consent, and no OffCKB maintainer feedback exists ([external checkpoints](external-checkpoints.md)). The CKB-UGMP showcase is a feasibility adaptation, not adoption.
- No install from the npm registry (`TBD`: repeat the consumer matrix against the published package if registry publication is chosen).

## Upgrade, deprecation, rollback

See [maintenance](maintenance.md#upgrade-deprecation-and-rollback-for-consumers) and the [release checklist](release-checklist.md#rollback). Consumers keep `patches/@offckb%2Fcli@0.4.13.patch` and its declarations until a changelog entry says the OffCKB pin changed.

## Verify this release yourself

1. `sha256sum -c SHA256SUMS` on the downloaded tarball and `sha256sum -c release-evidence-<sha>.tar.gz.sha256` on the evidence archive.
2. Extract the archive, `sha256sum -c --strict SHA256SUMS` inside it, then `ckb-verify check-bundle <bundle> --source-sha <sha> --repository Akane-CN/spark-verify` for each bundle ([offline verification](offline-verification.md#release-evidence-archive)).
3. Install per [`docs/install.md`](install.md) and run your own manifest; compare `environment.runner.version` with `ckb-verify --version`.

## Changes since 0.0.2

Moved from `CHANGELOG.md` `Unreleased` at freeze (`TBD`).
