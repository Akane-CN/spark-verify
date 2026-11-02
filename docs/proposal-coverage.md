# Proposal coverage

What the [Spark proposal revision 0.3](spark-proposal.md#8-deliverables--how-to-verify) promised as the five funded deliverables, against what the repository actually contains. It answers the comment that the work exceeds the proposal in engineering depth while not yet covering the promised scope: both halves are recorded here, item by item, so neither is overstated. This is a coverage record, not a completion report; a completion report is written only at publication (#20).

Status words: **done** (shipped on `main` with executable evidence), **partial** (shipped with a stated gap), **not done**, **external** (needs a third party), **gated** (needs the maintainer's publication authorization).

## Deliverable 1: frozen `verify.toml` v0.1 contract

| Promise | Status | Evidence |
| --- | --- | --- |
| Normative document and compatibility policy | done | RFC v0.2 with per-section status lines; [version policy](version-policy.md) |
| Machine-readable parsed-TOML schema | done | `schemas/ckb-verify-manifest-v1.schema.json`, run by `validate` |
| Versioned valid/invalid manifests plus report/digest fixtures | done | `tests/fixtures/conformance/manifests/` (26 invalid, paired parser and schema diagnostics), `tests/fixtures/claims-v2/`, the retained historical report |
| "Frozen" | partial | the identifiers stay `0.1.0-draft.3` / `0.1.0-draft.4` / `0.1.0-draft.5` ([decision 6](release-decisions.md#6-spec-naming-at-release-draft-identifiers-stay)); the grammar is published and strict, but not named as a frozen `0.1.0` |

## Deliverable 2: installable `ckb-verify` CLI

| Promise | Status | Evidence |
| --- | --- | --- |
| `validate`, `run`, `digest`, `check-digest` | done | plus `check-bundle`; [offline verification](offline-verification.md) |
| Cycle comparators (`expect.cycles.*`) | done | spec `0.1.0-draft.5` ([vocabulary](vocabulary-v0.1.md)); `showcases/vocabulary/verify.cycles-too-low.toml` fails as declared on a fresh devnet |
| Script-filtered Cell selection with `data`, `data.len`, `capacity` checks | done | draft.5 `lock`/`type` selectors through the node indexer with retained raw pages; `data.eq`/`len`/`min_bytes`, `capacity` comparators; wrong-data and wrong-capacity fixtures fail as declared |
| Native CKB and 16-byte little-endian UDT/xUDT balance claims | done | draft.5 `balance` by account, address, or lock, with `udt` decoding the 16-byte little-endian prefix; the fixture mints an owner-mode xUDT and checks `eq "1000"`, balance-short fails as declared |
| Field-level terminal diffs | done | `run` prints `failed:` blocks with expected and observed values for every failed expectation and claim |
| Schema-backed JSON evidence | done | `schemas/ckb-verify-report.schema.json`, run by the offline commands |

## Deliverable 3: release and CI package

| Promise | Status | Evidence |
| --- | --- | --- |
| Pinned, evidence-preserving reusable workflow with no production secrets | done | `.github/workflows/ckb-verify-reusable.yml` (`workflow_call`, commit-pinned actions, reports-only artifact); this repository calls it for its root manifest in the `dogfood` job |
| Repository-root dogfood manifest and clean-checkout harness | done | `verify.toml`; `bun run verify:release` (`scripts/verify-release.sh`) runs the proposal's §8.B items from a clean checkout and writes a record |
| Ubuntu support statement backed by execution | done | every CI job, the acceptance matrices, the rehearsals |
| macOS support statement backed by execution | not done | `.github/workflows/macos-boundary.yml` (manual) would prove the offline commands and the platform-independent tests on macOS and that `run` is refused before any runtime mutation, but on 2026-11-01 GitHub cancelled the job before assigning a hosted macOS runner (`runner_id` 0, cancelled within a second), so nothing has executed on macOS yet; macOS stays unsupported and unclaimed until a run completes |
| Windows support statement | partial | stated unsupported ([supported combinations](maintenance.md#supported-combinations)); not executed |
| `bun run build`, `bun run verify:release` entry points | done | `package.json` scripts; all nine §8.B items pass on `5cf0d92` (`docs/acceptance/2026-11-02-release-surface.md`) |

## Deliverable 4: external pilot and upstream-fit result

| Promise | Status | Evidence |
| --- | --- | --- |
| Public OffCKB maintainer feedback | external | no outreach sent; draft question ready ([external checkpoints](external-checkpoints.md)) |
| One consented project trial, or a transparent demand/no-go report | external | no consent requested; the CKB-UGMP showcase is feasibility only; the week-8 checkpoint on 2026-11-27 records the result |

## Deliverable 5: completion evidence

| Promise | Status | Evidence |
| --- | --- | --- |
| v0.1 reference, security, migration, and integration documentation | done | `README.md`, `SECURITY.md`, `docs/install.md`, `docs/maintenance.md`, `docs/version-policy.md`, `docs/offline-verification.md` |
| Short demo | done | workflow video shared on the Spark thread on 2026-10-15 |
| Exact-revision release verification log | partial | `docs/acceptance/` records on named commits; the log on the frozen candidate is produced at release (`bun run verify:release`, the rehearsal, the consumer matrix) |
| Spark completion report and budget report | gated | written only at publication, under #20 |

## Beyond the proposal

Not promised, delivered because the roadmap's trust gates required it: exclusive runtime ownership across checkouts, verified pinned debugger artifacts with private execution snapshots, the shipped OffCKB supply-chain patch and the fail-closed installed-runtime gate, the loopback-bound proxy, sanitized CI evidence bundles with API readback, the durable release-evidence archive, the installed-consumer acceptance matrix, the maintenance loop with its rehearsal scripts, and the published release decisions. None of it substitutes for the rows above marked not done, external, or gated.
