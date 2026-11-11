# RFC v0.2 to implementation matrix

This matrix compares every normative item of [`verify.toml` RFC draft 0.2](verify-toml-rfc-v0.2.md) with what the runner actually does; "(v0.1)" marks items available only under `meta.spec = "0.1.0"`, the frozen v0.1 contract, or its earlier identifier `"0.1.0-draft.5"` ([vocabulary](vocabulary-v0.1.md)), and "(v0.2)" items available only under `meta.spec = "0.2.0"` ([vocabulary](vocabulary-v0.2.md)). It exists so the RFC is never silently narrowed: an item is **supported** only when the parser, runner, verifier, and a real fixture all implement it; **deferred** items are intentionally not implemented and say why; **release-blocking** items needed a decision or work before `v0.1.0`; all six are recorded in [release decisions](release-decisions.md) (#18), so none remain. "Supported" never implies grant-scope completion.

Legend: ✅ supported · ◐ partial (the difference is stated) · ⏸ deferred · ⛔ release-blocking decision or work.

## §0–§1 Trust, scope, structure

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| No sandbox; trusted repositories only; loopback RPC; fresh OffCKB devnet; no production keys | ✅ | `SECURITY.md`; RPC and proxy URLs must be loopback; 0.2.0 refuses any genesis other than the pinned default (see §6) |
| Sections `[meta]`, `[toolchain]`, `[replay]`, `[setup]`, `[[step]]`, `[[assert.*]]` | ✅ (v0.2) | all present; `[[step]]` zero or more under 0.2.0 (≤ 0.1.0 require one); `[[assert.balance]]` since 0.1.0 |
| Evaluation order validate → setup → steps → final assertions → report | ✅ | `src/runner.ts` |
| Schema and execution errors are no-verdict (exit 2), distinct from FAIL (exit 1) | ✅ | CLI exit codes; `report.json` is never published without a verdict |
| At least one expectation or assertion required | ✅ | parser rule; also a parser-only conformance case |
| Unknown keys are errors | ✅ | parser `exactKeys` everywhere; published manifest schema uses `additionalProperties: false` |
| Dotted keys and explicit tables normalize identically | ✅ | TOML parser normalizes before validation |

## §2 Metadata, toolchain, replay

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| `meta.name` (required, ≤ 100), `meta.spec`, `meta.description` | ✅ | specs `0.2.0`, `0.1.0`, `0.1.0-draft.5`, `0.1.0-draft.4`, `0.1.0-draft.3` |
| Exact `toolchain.ckb` | ◐ | any exact `x.y.z` parses; only `0.209.0` has pinned release assets, so other values fail at setup with no verdict |
| Exact `toolchain.offckb` | ◐ | must equal the adapter pin `0.4.13` |
| Exact `toolchain.ckb-debugger` | ◐ | must be `1.1.1` (the only pinned Linux x64 asset); required whenever a step expects `rejected` |
| `--allow-version-drift` | ✅ (v0.1, v0.2) | `run --allow-version-drift` runs a `0.2.0`, `0.1.0`, or draft.5 manifest that requests an unpinned exact `toolchain.ckb` on the pinned `0.209.0`; provenance/3 or /4 records requested/observed/allowed and replay is tainted `tool_version_drift`; refused before any runtime mutation by default. OffCKB and debugger pins stay exact-only |
| Repository runtime/package-manager pins and lockfile recorded | ✅ (v0.2) | ≤ 0.1.0: Bun pin from `packageManager` and `bun.lock` only. 0.2.0 (provenance/4): every common lockfile (Bun, npm, pnpm, yarn, Cargo), pins from `packageManager`, `.tool-versions`, `mise.toml`, `.nvmrc`, `.node-version`, each observed with `<tool> --version`; missing/ranged pins, drift, and no lockfile taint |
| `[replay].dependencies` required, unique, from the five codes; listed codes taint with outcome-scoped reasons | ✅ | `src/provenance.ts`; conformance fixtures for unknown and duplicate codes |

## §3 Setup

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| `setup.accounts` in `0..20` | ✅ (v0.2) | 0.2.0: `0..20`, at most 19 when a binary is deployed (OffCKB deploys from account 19); ≤ 0.1.0 keep `1..20` |
| `[setup.scripts.<name>]` with `binary` (deploy with Type ID or data hash, record hashes/out-points) | ✅ (v0.2) | `offckb deploy` in declaration order; each code Cell verified on chain against the bytes; `binarySha256`, `dataHash`, code hash, out-point, and Type ID in environment/5, hashes in the outcome ([decision](release-decisions.md#2026-11-03-decisions-2-3-and-4-reopened-the-rest-of-the-proposals-target-v01-ships-as-spec-020)) |
| `[setup.scripts.<name>]` with `builtin` | ✅ (v0.2) | an alias of an OffCKB system script, recorded with its resolved identity; ≤ 0.1.0 reference built-ins directly from claims |
| Seeded genesis Cells | ⏸ | out of scope per RFC |

## §4 Steps and command protocol

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| Unique required step names; ordered execution from the repository root | ✅ | parser and runner |
| `timeout` 1–600 s, default 60 s | ✅ | integer seconds or `"<n>s"` |
| Injected `CKB_VERIFY_RPC_URL`, `_ACCOUNTS`, `_SYSTEM_SCRIPTS`, `_CONTEXT`, `_RESULT` | ✅ | `src/runner.ts`; `_CONTEXT` carries the normalized devnet context |
| Result envelope `{ protocol: 1, transaction }`, atomic single write, runner submits | ✅ | malformed or missing envelope is an execution error |
| At most one transaction per step | ✅ | |
| Pure steps (no `expect.tx`, no result file, immediate assertions only) | ✅ (v0.2) | a 0.2.0 step without `expect`; out-point and dependency claims cannot target it; ≤ 0.1.0 every step produces a transaction |
| Result-contract errors (missing result on a tx step; result on a pure step) | ✅ (v0.2) | both are execution errors with no verdict (`verify.pure-writes-result.toml`) |
| Non-zero command exit is an execution error | ✅ | |
| `expect.tx = "committed" \| "rejected"` | ✅ | terminal node status via the OffCKB proxy |
| `expect.cycles.{lt,lte,eq,gte}` | ✅ (v0.1) | `{ lt \| lte, gte }` or `{ eq }`; `expectedCycles` enters the outcome; a missing cycles value never satisfies a comparator |
| `expect.error.code` | ✅ | satisfied only by script evidence from the pinned debugger |
| `expect.error.group` (role, script, args) | ✅ (v0.2) | named, built-in, explicit, or account reference; satisfied only by script evidence; a reference matching several groups of the retained transaction is refused |
| Rejection kinds `script` vs `node`; bare `rejected` satisfied by either | ✅ | `src/transaction.ts`; the node `reason` is in the outcome; 0.2.0 also records terminal `send_transaction` rejections (`rpcCode` -301, -302, -1102…-1110) instead of refusing the run |
| Immediate `[[step.assert.cell]]` and `[[step.assert.balance]]` | ✅ | balance since 0.1.0 |

## §5 Assertions

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| `cell` selector by `out_point = { step, index }` | ✅ | symbolic target retained in the outcome digest |
| `cell` selector by `lock`/`type` script filter (query all matching live Cells) | ✅ (v0.1) | indexer `get_cells` pages retained raw (100 per page, at most 1000 Cells); wildcard args match by prefix |
| `count = N` exact | ✅ (v0.1) | any non-negative `N` (draft.4: `0` or `1` only) |
| `count.eq/gte/lte` comparators | ✅ (v0.1) | shorthand `N` or `{ eq \| gte, lte }`; property checks force `gte 1` |
| `data.eq` | ✅ (v0.1) | exact bytes; re-derived from the retained raw data |
| `data.len` | ✅ (v0.1) | exact byte length; draft.4 keeps `min_bytes` as a lower bound, v0.1 accepts both |
| `capacity.{eq,gte,lte}` | ✅ (v0.1) | `"N CKB"`/`"N shannon"` strings, compared in shannons |
| Output type identity and args length | ✅ (draft.4) | `type = { builtin, args_bytes }`; identity normalized to the claimed builtin or retained raw on mismatch |
| Transaction CellDep membership | ✅ (draft.4) | `[[…assert.cell_deps]] contains = { builtin }`, beyond the RFC's vocabulary |
| No vacuous success | ✅ | a missing output fails even `count = 0`; draft.4 property checks require `count = 1` |
| `balance` by `account`/`address`/`lock`, with or without `udt` | ✅ (v0.1) | aggregate over live Cells under the lock (indexer pages retained); UDT amounts decoded as the 16-byte little-endian prefix, shorter data invalidates the observation; full-format addresses decoded offline |
| Script references (explicit, named setup script, wildcard args) | ✅ (v0.2) | 0.1.0: explicit, `{ builtin[, args] }`, `{ account }`, wildcard recorded as `null`; 0.2.0 adds `"name"` and `{ script, args }` |
| Comparator validation rules | ✅ (v0.1) | `eq` exclusive, `lt`/`lte` exclusive, `gte` ≤ `lte`, strings only for quantities; parser-only conformance cases |

## §6 Reproducibility

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| Outcome digest and environment fingerprint, SHA-256 over RFC 8785 canonical JSON, each object self-versioned | ✅ | `src/canonical.ts`; `digests.outcome`, `digests.environment` |
| §6.1 recorded evidence | ✅ (v0.2) | 0.2.0 adds the sanitized repository identity, every lockfile, the sealing-configuration fingerprint, and deployed-binary hashes to what 0.1.0 records |
| §6.2 outcome digest contents and exclusions | ✅ | raw transaction hashes, timestamps, durations, paths and provenance are excluded; manifest-spec and outcome-schema versions included |
| §6.3 environment fingerprint contents | ✅ (v0.2) | environment/5 includes the sealing configuration and provenance/4 |
| §6.4 replay qualification `stable`/`tainted` with scoped reasons | ✅ | the five dependencies, `dirty_source`, `source_revision_unavailable`, `source_state_unavailable`, `runtime_pin_missing`, `runtime_version_drift`, `tool_version_drift`, `lockfile_missing`; `nondefault_devnet` under 0.2.0 |
| Genesis compared with an independent allowlist | ✅ (v0.2) | `src/devnet-identity.ts` pins the default devnet genesis per CKB release; the runner refuses and the verifier rejects any other |
| Hex lowercase `0x`; large integers as decimal strings | ✅ | |

## §7 Report and CLI

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| Report with versions, evidence, outcome claims, environment, pass flag, digests, replay | ✅ | `schema`, `verdict`, `createdAt`, `evidence`, `outcomeClaims`, `environment` (with `provenance.replay`), `digests`; RFC §7 now describes this shipped contract ([decision 5](release-decisions.md#5-rfc-7-rewritten-to-the-shipped-contract), [report anatomy](evidence-report.md)) |
| `ckb-verify run [path]` | ✅ | |
| `run --report <file>`, `run --json` | ✅ | every spec; `src/cli.ts` |
| `run --allow-version-drift` | ✅ (v0.1, v0.2) | see §2 |
| `ckb-verify validate [path]` | ✅ | strict parser plus the published manifest schema; executes nothing |
| `ckb-verify digest <report>` | ✅ | always re-derives both digests (the RFC's `--kind` selector is not needed) |
| `ckb-verify check-digest <report> …` | ◐ | implemented as `--outcome <sha256:…>` / `--environment <sha256:…>` instead of `--kind <k> <hash>`; same semantics |
| `ckb-verify check-bundle <dir>` | ✅ | beyond the RFC: verifies a downloaded CI evidence bundle |
| Exit codes 0 / 1 / 2 | ✅ | identical meaning for `run`; offline commands document their own `0 / 1 / 2` |
| JSON plus terminal summary; HTML deferred | ✅ | HTML remains deferred |

## §8 Validation and conformance

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| 1. machine-readable schema for parsed TOML | ✅ | `schemas/ckb-verify-manifest-v1.schema.json` |
| 2. valid/invalid manifest fixtures incl. unknown keys | ✅ | `tests/fixtures/conformance/manifests/` |
| 3. canonicalization and digest fixtures | ✅ | `tests/canonical.test.ts`; committed reports with locked digests: `tests/fixtures/frozen-v0.1/report.json`, `tests/fixtures/report-v4/*.json` |
| 4. committed-transaction fixture | ✅ | secp transfer, cell-properties, CKB-UGMP showcases |
| 5. rejected-script fixture with group and code evidence | ✅ (v0.2) | `showcases/repository-script/verify.rejected.toml` pins code and group; `verify.wrong-group.toml` fails with the same code |
| 6. non-script node-rejection fixture | ✅ (v0.2) | `verify.node-rejected.toml` (RPC -301) on a fresh devnet; `verify.node-rejected-code.toml` fails |
| 7. pure-step fixture | ✅ (v0.2) | `verify.committed.toml` step "inspect deployment" |
| 8. result-contract fixtures | ✅ (v0.2) | missing result (runner tests) and `verify.pure-writes-result.toml` |
| 9. zero-match / vacuous-success regressions | ✅ | draft.4 missing-output and count rules |
| 10. quantity overflow and UDT decoding | ✅ (v0.1) | conformance fixtures `draft5-bare-amount`, `draft5-too-many-decimals`, `draft5-udt-ckb-quantity`; UDT decoding and malformed-data tests in `tests/claims-v3.test.ts`; the vocabulary showcase |
| 11. replay fixtures (missing, empty, each dependency) | ✅ | parser and provenance tests |
| 12. two clean runs with equal digests | ✅ | every showcase and the acceptance matrix repeat case |
| 13. version-drift fixture | ✅ | runtime drift taints and changes the fingerprint; tool drift taints under `--allow-version-drift` (`showcases/vocabulary/verify.drift.toml`) |
| 14. cross-environment equal-outcome fixture | ✅ | cell-properties repeat comparison (`recorded-devnet-difference`) |
| Error messages with path, key path, observed value | ✅ | parser messages carry source and key path; schema problems carry the JSON Pointer |

## §9 Open questions and deferred scope

Declarative transaction construction, arbitrary genesis Cells, testnet/mainnet execution, property-based generation, and include files remain out of scope exactly as the RFC states. Of the open questions, two are answered by the implementation: the runner is a standalone package (Q1), and a step is exactly one transaction (Q3). Molecule result files (Q2), named outputs (Q5), `udt16le` naming (Q6), and the isolation container (Q7) are untouched. Q8 is answered by the merged CKB-UGMP feasibility probe only as feasibility, not adoption.

## Release decisions (#18 → #20)

The six decisions this matrix raised are recorded, with rationale and consequences, in [release decisions](release-decisions.md): (1) originally the implemented draft.3/draft.4 subset only; **reopened on 2026-11-02**: the promised vocabulary ships as `0.1.0-draft.5` ([vocabulary](vocabulary-v0.1.md)), and what remains deferred is named setup-script references, `[setup.scripts]`, pure steps, and `expect.error.group`; (2) `[setup.scripts]` deployment is a documented limitation; (3) pure steps and `accounts = 0` are not in v0.1; (4) `expect.error.group` is code-only pinning; (5) RFC §7 is rewritten to the shipped contract; (6) originally no `0.1.0` spec string at release; **reopened on 2026-11-02**: the v0.1 contract is frozen as spec `0.1.0`, the draft.5 grammar under its release identifier ([version policy](version-policy.md#the-frozen-v01-contract)), next to `0.1.0-draft.5`, `0.1.0-draft.4`, and `0.1.0-draft.3`. On **2026-11-03** decisions 2, 3, and 4 were reopened ([entry](release-decisions.md#2026-11-03-decisions-2-3-and-4-reopened-the-rest-of-the-proposals-target-v01-ships-as-spec-020)): `[setup.scripts]`, named setup-script references, pure steps, `accounts = 0`, and `expect.error.group` ship as spec `0.2.0`, together with the RFC items the proposal does not name (zero steps, node rejections, lockfile and runtime pins, repository identity, sealing fingerprint, genesis allowlist, `run --report`/`--json`). No ⛔ item remains; reopening a decision is a dated new entry on that page.
