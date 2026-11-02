# Proposal coverage

What the [Spark proposal revision 0.3](spark-proposal.md#8-deliverables--how-to-verify) promised as the five funded deliverables, against what the repository actually contains. It answers the comment that the work exceeds the proposal in engineering depth while not yet covering the promised scope: both halves are recorded here, item by item, so neither is overstated. This is a coverage record, not a completion report; a completion report is written only at publication (#20).

Status words: **done** (shipped on `main` with executable evidence), **partial** (shipped with a stated gap), **not done**, **external** (needs a third party), **gated** (needs the maintainer's publication authorization).

## Deliverable 1: frozen `verify.toml` v0.1 contract

| Promise | Status | Evidence |
| --- | --- | --- |
| Normative document and compatibility policy | done | RFC v0.2 with per-section status lines; [version policy](version-policy.md) |
| Machine-readable parsed-TOML schema | done | `schemas/ckb-verify-manifest-v1.schema.json`, run by `validate` |
| Versioned valid/invalid manifests plus report/digest fixtures | done | `tests/fixtures/conformance/manifests/` (44 invalid, paired parser and schema diagnostics, every draft.5 case re-run under `0.1.0`), `tests/fixtures/claims-v2/`, `tests/fixtures/claims-v3/`, the golden `0.1.0` report in `tests/fixtures/frozen-v0.1/`, the retained historical report |
| "Frozen" | done | spec `0.1.0` is the frozen v0.1 contract (the draft.5 grammar under its release identifier, report/3 + outcome/3 + environment/4 + provenance/3); what frozen means and how `tests/frozen-contract.test.ts` checks it against a lock is in the [version policy](version-policy.md#the-frozen-v01-contract) ([decision 6, reopened](release-decisions.md#2026-11-02-decision-6-reopened-the-v01-contract-is-frozen-as-spec-010)); the root `verify.toml` and the vocabulary fixture use it. The RFC stays a draft for later specs |

## Deliverable 2: installable `ckb-verify` CLI

| Promise | Status | Evidence |
| --- | --- | --- |
| `validate`, `run`, `digest`, `check-digest` | done | plus `check-bundle`; [offline verification](offline-verification.md) |
| Cycle comparators (`expect.cycles.*`) | done | spec `0.1.0` ([vocabulary](vocabulary-v0.1.md)); `showcases/vocabulary/verify.cycles-too-low.toml` fails as declared on a fresh devnet |
| Script-filtered Cell selection with `data`, `data.len`, `capacity` checks | done | `0.1.0` `lock`/`type` selectors through the node indexer (after it reaches the chain tip) with retained raw pages; `data.eq`/`len`/`min_bytes`, `capacity` comparators; wrong-data and wrong-capacity fixtures fail as declared |
| Native CKB and 16-byte little-endian UDT/xUDT balance claims | done | `0.1.0` `balance` by account, address, or lock, with `udt` decoding the 16-byte little-endian prefix; the fixture mints an owner-mode xUDT and checks `eq "1000"`, balance-short fails as declared |
| Field-level terminal diffs | done | `run` prints `failed:` blocks with expected and observed values for every failed expectation and claim |
| Schema-backed JSON evidence | done | `schemas/ckb-verify-report.schema.json`, run by the offline commands |

## Deliverable 3: release and CI package

| Promise | Status | Evidence |
| --- | --- | --- |
| Pinned, evidence-preserving reusable workflow with no production secrets | done | `.github/workflows/ckb-verify-reusable.yml` (`workflow_call`, commit-pinned actions, reports-only artifact); this repository calls it for its root manifest in the `dogfood` job |
| Repository-root dogfood manifest and clean-checkout harness | done | `verify.toml`; `bun run verify:release` (`scripts/verify-release.sh`) runs the proposal's §8.B items from a clean checkout and writes a record |
| Ubuntu support statement backed by execution | done | every CI job, the acceptance matrices, the rehearsals |
| macOS support statement backed by execution | done | `.github/workflows/platform-boundary.yml` on a hosted macOS 14 arm64 runner (run 41387777640): dependency install, type check, the platform-independent tests (including the frozen-contract test), `validate`, `digest` on the historical and the golden `0.1.0` reports, and `run` refused with exit 2 before anything is written; also manual run 41384894453 on `main`. The statement: offline commands supported on macOS, devnet execution not supported ([supported combinations](maintenance.md#supported-combinations)) |
| Windows support statement backed by execution | done | the same workflow on a hosted Windows Server 2022 runner (run 41387777640) with the same steps and result. Its first two runs found two Windows defects in offline verification, both fixed in this change: bundle paths compared with `\` separators, and release-evidence extraction hit `EINVAL` from node-tar's Windows file flag under Bun. The statement: offline commands supported on Windows, devnet execution not supported |
| `bun run build`, `bun run verify:release` entry points | done | `package.json` scripts; all nine §8.B items pass on `904658c` with the manifests on spec `0.1.0` (`docs/acceptance/2026-11-02-release-surface-v0.1.md`), and earlier on `5cf0d92` |

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
