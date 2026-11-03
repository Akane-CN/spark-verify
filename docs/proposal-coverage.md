# Proposal coverage

What the [Spark proposal revision 0.3](spark-proposal.md#8-deliverables--how-to-verify) promised as the five funded deliverables, against what the repository actually contains. It answers the comment that the work exceeds the proposal in engineering depth while not yet covering the promised scope: both halves are recorded here, item by item, so neither is overstated. This is a coverage record, not a completion report; a completion report is written only at publication (#20).

Status words: **done** (shipped on `main` with executable evidence), **partial** (shipped with a stated gap), **not done**, **external** (needs a third party), **gated** (needs the maintainer's publication authorization).

## The target v0.1 runner (proposal §4–§5), item by item

The deliverable headings below are not enough on their own: [§4](spark-proposal.md#4-solution) and [§5](spark-proposal.md#5-technical-approach) describe what the target v0.1 runner does, and each of those items must be covered too. Until 2026-11-03 three of them were deferred by release decisions 2–4. They now ship under spec `0.2.0` ([decision entry](release-decisions.md#2026-11-03-decisions-2-3-and-4-reopened-the-rest-of-the-proposals-target-v01-ships-as-spec-020)), next to the frozen `0.1.0`, which is unchanged.

| §4/§5 item | Status | Evidence |
| --- | --- | --- |
| 1. Validate the manifest against the versioned schema | done | `validate`; `schemas/ckb-verify-manifest-v1.schema.json` (≤ 0.1.0) and `ckb-verify-manifest-v2.schema.json` (0.2.0) |
| 2. Fresh OffCKB devnet with exact versions | done | every `run`; for 0.2.0 the genesis must equal the pinned default for the CKB release (`src/devnet-identity.ts`) |
| 3. Deterministic accounts and **deployed**/built-in script metadata | done (0.2.0) | `[setup.scripts.<name>]` with `binary` + `hash_type` (`type`/`data`/`data1`/`data2`) or `builtin`. Binaries are deployed via `offckb deploy`, each code Cell is checked on chain against its bytes, and the result is exposed to commands as `CKB_VERIFY_SCRIPTS` and recorded in environment/5 |
| 4. Each command a declared **pure step** or a transaction-producing step | done (0.2.0) | a step without `expect` is pure. It must not write `CKB_VERIFY_RESULT`, and its immediate claims run without a transaction. The `pure-writes-result` control gets no verdict |
| 5. Runner-owned submission of the signed artifact; committed and rejected both retained | done | since draft.3; 0.2.0 also records terminal node rejections from `send_transaction` (`kind = "node"` with `rpcCode`) |
| 6. Script group / error code and cycles recorded | done | rejection evidence carries role, source, script, and code; 0.2.0 retains the consumed input Cells of a script rejection |
| 7. Final live Cells and balances | done | spec `0.1.0` onward |
| 8. Evaluate the declared claims | done | spec `0.1.0` onward |
| 9. JSON, summary, outcome digest, environment fingerprint | done | every report; 0.2.0 adds `run --json` and `run --report <file>` |
| Vocabulary: "script group and error code for negative tests" | done (0.2.0) | `expect.error.group = { role, script \| builtin \| code_hash… \| account, args? }`; a different group with the same code fails (`verify.wrong-group.toml`); a node rejection cannot satisfy it |
| §5 execution adapter: repository binary resolution | done (0.2.0) | named references `"name"` (wildcard args) and `{ script = "name", args }` in Cell, balance, dependency, and group claims |
| §5 evidence: deployed binary hashes in provenance and the outcome | done (0.2.0) | `binarySha256` and `dataHash` per deployed script, in the outcome and in environment/5; a different binary changes the outcome digest (`verify.sh` variant case) |
| The worked example: deploy a script, create a Cell, legal spend; illegal spend rejected with the original Cell still live | done (0.2.0) | [repository-script showcase](../showcases/repository-script/README.md) on fresh devnets, in CI with downloadable evidence |

RFC items the proposal does not name, implemented on the maintainer's decision of 2026-11-03, all under 0.2.0:

| RFC item | Status | Evidence |
| --- | --- | --- |
| `setup.accounts = 0`, zero steps | done | `verify.zero.toml`; at least one claim is still required |
| Non-Bun lockfiles and runtime pins | done | provenance/4: `bun.lock(b)`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`; pins from `packageManager`, `.tool-versions`, `mise.toml`, `.nvmrc`, `.node-version`, each observed with `<tool> --version` |
| Sanitized repository identity | done | provenance/4 `repository`: the `origin` URL without userinfo, query, or fragment; local paths are not recorded |
| Sealing-configuration fingerprint, `nondefault_devnet` | done | environment/5 `devnet.sealing` (node, miner, chain-spec files); a difference from the pinned default taints replay |
| Genesis against an independent allowlist | done | runner refuses, verifier rejects, any genesis other than the pinned default for the executed CKB release |
| `run --report <file>`, `run --json` | done | `src/cli.ts`, `tests/cli-main.test.ts` |
| Non-script terminal node rejection on a real devnet | done | `verify.node-rejected.toml` (re-spending a consumed Cell, RPC -301) passes on bare `tx = "rejected"`; `verify.node-rejected-code.toml` fails |

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
| Public OffCKB maintainer feedback | external | no outreach sent; question approved for publication on 2026-11-02, for the maintainer to post ([external checkpoints](external-checkpoints.md#week-8-amendment-2026-11-02-outreach-approved)) |
| One consented project trial, or a transparent demand/no-go report | external | no consent requested; the CKB-UGMP showcase is feasibility only; the week-8 checkpoint, recorded early on 2026-11-02, records no outreach sent and no consent ([external checkpoints](external-checkpoints.md#week-8-due-2026-11-27-recorded-early-on-2026-11-02)); a consent request to CKB-UGMP was approved for publication the same day, for the maintainer to post |

## Deliverable 5: completion evidence

| Promise | Status | Evidence |
| --- | --- | --- |
| v0.1 reference, security, migration, and integration documentation | done | `README.md`, `SECURITY.md`, `docs/install.md`, `docs/maintenance.md`, `docs/version-policy.md`, `docs/offline-verification.md` |
| Short demo | done | workflow video shared on the Spark thread on 2026-10-15 |
| Exact-revision release verification log | done for the candidate | [`2026-11-02-candidate-e311ad3.md`](acceptance/2026-11-02-candidate-e311ad3.md): release checklist steps 1–6 on the re-frozen `e311ad3`, every gate PASS, with the CI evidence downloaded and verified (the first candidate `d99117b` was superseded by the [review](acceptance/2026-11-02-candidate-review.md) fixes); step 8 adds the install-back of the published assets |
| Spark completion report and budget report | drafted; finalized at publication | [completion and budget report draft](completion-report.md) on the candidate `e311ad3`; the grant status, funds, and costs are the maintainer's to fill; finalized with the tagged release under #20 |

## Beyond the proposal

Not promised, delivered because the roadmap's trust gates required it: exclusive runtime ownership across checkouts, verified pinned debugger artifacts with private execution snapshots, the shipped OffCKB supply-chain patch and the fail-closed installed-runtime gate, the loopback-bound proxy, sanitized CI evidence bundles with API readback, the durable release-evidence archive, the installed-consumer acceptance matrix, the maintenance loop with its rehearsal scripts, and the published release decisions. None of it substitutes for the rows above marked not done, external, or gated.
