# Maintenance loop

A small, repeatable maintainer workflow that keeps the verified baseline usable without waiting for funding or committee activity. It is a best-effort cadence, not a response-time commitment. Open GitHub issues are the only backlog.

## Supported combinations

| Component | Exercised pin | Notes |
| --- | --- | --- |
| OS / architecture | Linux x64 | the runtime ownership and debugger paths refuse other platforms before touching the runtime |
| Bun | 1.2.19 | `bun run check` fails fast on any other version; consumers pin it with `packageManager` so provenance records it |
| Node.js | 22 (any ≥ 20) | required because the OffCKB CLI is a Node program |
| `@offckb/cli` | 0.4.13 with the shipped patch | runtime gate refuses an unpatched bundle |
| CKB | 0.209.0 | pinned release assets with size/SHA-256 verification |
| `ckb-debugger` | 1.1.1 (Linux x64 asset) | required only for manifests that declare `expect.tx = "rejected"` |
| `@ckb-ccc/core` | 1.14.0 | used by the shipped producers |

Report and manifest compatibility is defined in [offline verification](offline-verification.md#version-compatibility): report `/2` (draft.4) and `/1` (draft.3) with environment `/3` + provenance `/2` are current; `/1` with environment `/2` + provenance `/1` is historical and requires `--allow-legacy`; anything else is rejected as unsupported. The historical sample `docs/examples/secp-transfer-committed-report.json` is retained as the previous-format fixture and is verified by `tests/documentation-evidence.test.ts`.

## Reporting a problem

Use the [bug report template](../.github/ISSUE_TEMPLATE/bug_report.md): runner and report versions, platform, a reproducible manifest or fixture, the sanitized report or its digests, and the source revision. Never attach keys, account files, or environment dumps. Suspected vulnerabilities go through the private channel in [`SECURITY.md`](../SECURITY.md#reporting-a-vulnerability), not an issue.

## Weekly checklist

1. `git switch main && git pull --ff-only && bun install --frozen-lockfile`.
2. `bun run check` and `./scripts/validate-docs.sh --examples`.
3. `bun run showcase:secp-transfer` (the fastest real-devnet regression); run the other two showcases if anything under `src/` changed.
4. `bun run check:supply-chain`; note any new advisory. A new finding is triaged in an issue, never waived in place.
5. Triage new issues with the template; label `bug`, `enhancement`, or `rfc`; close duplicates with the reason.
6. Update roadmap blockers and evidence links on the open milestone issues; confirm the latest `main` CI run is green including `verify-evidence`.
7. If a roadmap checkpoint date has passed (week 3: 2026-10-23, week 8: 2026-11-27), record its state in [external checkpoints](external-checkpoints.md) and on #2/#3; silence is recorded as such, never inferred as consent.

## Monthly pin review

For each of Bun, OffCKB, CKB, `@ckb-ccc/core`, and `ckb-debugger`:

1. Check upstream releases and advisories.
2. Decide: keep, or open one isolated PR per pin bump with the new pins, regenerated `bun.lock`, updated size/SHA-256 pins, the compatibility note, and a fresh `scripts/acceptance-matrix.sh --results` record attached.
3. Review the `elliptic` waiver expiry in `src/supply-chain.ts`; renew only with an owner, date, and justification in `SECURITY.md`.
4. Security alerts never trigger a blind auto-merge; every bump goes through the review and the matrix.

## Upgrade, deprecation, and rollback for consumers

- **Upgrade:** install the new tarball, keep `patches/@offckb%2Fcli@0.4.13.patch` and the `patchedDependencies`/`overrides` entries until the changelog says the OffCKB pin changed, then replace the patch file from the new tarball. Run `ckb-verify validate` on your manifests; a spec string the new runner no longer accepts is rejected explicitly rather than reinterpreted.
- **Deprecation:** a report or manifest version is announced as deprecated in `CHANGELOG.md` at least one minor release before it stops being written; it stays readable by `digest`/`check-digest` (with `--allow-legacy` where documented) for as long as the fixture for it is retained in `tests/`.
- **Rollback:** see the [release checklist](release-checklist.md#rollback).

## Maintenance run and patch-release rehearsal

`scripts/release-rehearsal.sh` performs one complete maintenance cycle without publishing anything: frozen-tree check, dependency gate, regression, documentation validation, packing with checksums, and (with `--consumer`) the installed-consumer acceptance matrix. It writes `rehearsal-<date>.md` with the commands, versions, checksums, and results. Keep that record with the candidate's evidence bundles. Run it once before closing #21 and again before every release.

## Automation

No scheduled automation is enabled. If a schedule is later approved, it must be bounded, secret-free, observable, independently disableable, and verified by a manual run first; publishing this document does not activate anything.
