# RFC v0.2 to implementation matrix

This matrix compares every normative item of [`verify.toml` RFC draft 0.2](verify-toml-rfc-v0.2.md) with what the private `0.0.2` runner actually does; "(v0.1)" marks items available only under `meta.spec = "0.1.0"`, the frozen v0.1 contract, or its earlier identifier `"0.1.0-draft.5"` ([vocabulary](vocabulary-v0.1.md)). It exists so the RFC is never silently narrowed: an item is **supported** only when the parser, runner, verifier, and a real fixture all implement it; **deferred** items are intentionally not implemented and say why; **release-blocking** items needed a decision or work before `v0.1.0`; all six are recorded in [release decisions](release-decisions.md) (#18), so none remain. "Supported" never implies grant-scope completion.

Legend: ✅ supported · ◐ partial (the difference is stated) · ⏸ deferred · ⛔ release-blocking decision or work.

## §0–§1 Trust, scope, structure

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| No sandbox; trusted repositories only; loopback RPC; fresh OffCKB devnet; no production keys | ✅ | `SECURITY.md`; RPC and proxy URLs must be loopback; genesis recorded (not yet allowlisted, see §6) |
| Sections `[meta]`, `[toolchain]`, `[replay]`, `[setup]`, `[[step]]`, `[[assert.*]]` | ◐ | all present; `[[step]]` requires at least one step (RFC: zero or more); `[[assert.balance]]` is not accepted |
| Evaluation order validate → setup → steps → final assertions → report | ✅ | `src/runner.ts` |
| Schema and execution errors are no-verdict (exit 2), distinct from FAIL (exit 1) | ✅ | CLI exit codes; `report.json` is never published without a verdict |
| At least one expectation or assertion required | ✅ | parser rule; also a parser-only conformance case |
| Unknown keys are errors | ✅ | parser `exactKeys` everywhere; published manifest schema uses `additionalProperties: false` |
| Dotted keys and explicit tables normalize identically | ✅ | TOML parser normalizes before validation |

## §2 Metadata, toolchain, replay

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| `meta.name` (required, ≤ 100), `meta.spec`, `meta.description` | ✅ | specs `0.1.0-draft.3` and `0.1.0-draft.4` |
| Exact `toolchain.ckb` | ◐ | any exact `x.y.z` parses; only `0.209.0` has pinned release assets, so other values fail at setup with no verdict |
| Exact `toolchain.offckb` | ◐ | must equal the adapter pin `0.4.13` |
| Exact `toolchain.ckb-debugger` | ◐ | must be `1.1.1` (the only pinned Linux x64 asset); required whenever a step expects `rejected` |
| `--allow-version-drift` | ✅ (v0.1) | `run --allow-version-drift` runs a `0.1.0` or draft.5 manifest that requests an unpinned exact `toolchain.ckb` on the pinned `0.209.0`; provenance/3 records requested/observed/allowed and replay is tainted `tool_version_drift`; refused before any runtime mutation by default. OffCKB and debugger pins stay exact-only |
| Repository runtime/package-manager pins and lockfile recorded | ✅ | provenance `runtime` (Bun pin from `packageManager`), `lockfile` (`bun.lock`), `manifest.sha256`; other runtimes/lockfiles are not read (⏸) |
| `[replay].dependencies` required, unique, from the five codes; listed codes taint with outcome-scoped reasons | ✅ | `src/provenance.ts`; conformance fixtures for unknown and duplicate codes |

## §3 Setup

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| `setup.accounts` in `0..20` | ◐ | implemented as `1..20`; `0` is rejected because the producers need a funded signer. Decided: `0` is a v0.3 proposal ([decision 3](release-decisions.md#3-pure-steps-and-setupaccounts--0-not-in-v01)) |
| `[setup.scripts.<name>]` with `binary` (deploy with Type ID or data hash, record hashes/out-points) | ⏸ | not implemented; no deployment path exists. Decided: documented limitation of v0.1, v0.3 proposal ([decision 2](release-decisions.md#2-repository-script-deployment-a-documented-limitation)) |
| `[setup.scripts.<name>]` with `builtin` | ◐ | no `[setup.scripts]` table; draft.4 claims reference OffCKB built-ins directly as `builtin = "dao" \| "spore"` with the resolved identity recorded in `environment.devnet.systemScripts` |
| Seeded genesis Cells | ⏸ | out of scope per RFC |

## §4 Steps and command protocol

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| Unique required step names; ordered execution from the repository root | ✅ | parser and runner |
| `timeout` 1–600 s, default 60 s | ✅ | integer seconds or `"<n>s"` |
| Injected `CKB_VERIFY_RPC_URL`, `_ACCOUNTS`, `_SYSTEM_SCRIPTS`, `_CONTEXT`, `_RESULT` | ✅ | `src/runner.ts`; `_CONTEXT` carries the normalized devnet context |
| Result envelope `{ protocol: 1, transaction }`, atomic single write, runner submits | ✅ | malformed or missing envelope is an execution error |
| At most one transaction per step | ✅ | |
| Pure steps (no `expect.tx`, no result file, immediate assertions only) | ⏸ | every step must write a result envelope and is submitted; a step without `expect.tx` is still transaction-producing. Decided: v0.3 proposal ([decision 3](release-decisions.md#3-pure-steps-and-setupaccounts--0-not-in-v01)) |
| Result-contract errors (missing result on a tx step; result on a pure step) | ◐ | the first is an execution error; the second cannot occur because pure steps do not exist |
| Non-zero command exit is an execution error | ✅ | |
| `expect.tx = "committed" \| "rejected"` | ✅ | terminal node status via the OffCKB proxy |
| `expect.cycles.{lt,lte,eq,gte}` | ✅ (v0.1) | `{ lt \| lte, gte }` or `{ eq }`; `expectedCycles` enters the outcome; a missing cycles value never satisfies a comparator |
| `expect.error.code` | ✅ | satisfied only by script evidence from the pinned debugger |
| `expect.error.group` (role, script, args) | ⏸ | the rejection evidence records `role`, `source`, `script`, and `scriptHash`, but the manifest cannot pin a group. Decided: code-only pinning in v0.1 ([decision 4](release-decisions.md#4-expecterrorgroup-code-only-pinning)) |
| Rejection kinds `script` vs `node`; bare `rejected` satisfied by either | ✅ | `src/transaction.ts`; node messages excluded from the outcome digest |
| Immediate `[[step.assert.cell]]` | ✅ | `[[step.assert.balance]]` ⏸ |

## §5 Assertions

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| `cell` selector by `out_point = { step, index }` | ✅ | symbolic target retained in the outcome digest |
| `cell` selector by `lock`/`type` script filter (query all matching live Cells) | ✅ (v0.1) | indexer `get_cells` pages retained raw (100 per page, at most 1000 Cells); wildcard args match by prefix |
| `count = N` exact | ◐ | draft.3: any non-negative count; draft.4: `0` or `1` only |
| `count.eq/gte/lte` comparators | ✅ (v0.1) | shorthand `N` or `{ eq \| gte, lte }`; property checks force `gte 1` |
| `data.eq` | ✅ (v0.1) | exact bytes; re-derived from the retained raw data |
| `data.len` | ✅ (v0.1) | exact byte length; draft.4 keeps `min_bytes` as a lower bound, v0.1 accepts both |
| `capacity.{eq,gte,lte}` | ✅ (v0.1) | `"N CKB"`/`"N shannon"` strings, compared in shannons |
| Output type identity and args length | ✅ (draft.4) | `type = { builtin, args_bytes }`; identity normalized to the claimed builtin or retained raw on mismatch |
| Transaction CellDep membership | ✅ (draft.4) | `[[…assert.cell_deps]] contains = { builtin }`, beyond the RFC's vocabulary |
| No vacuous success | ✅ | a missing output fails even `count = 0`; draft.4 property checks require `count = 1` |
| `balance` by `account`/`address`/`lock`, with or without `udt` | ✅ (v0.1) | aggregate over live Cells under the lock (indexer pages retained); UDT amounts decoded as the 16-byte little-endian prefix, shorter data invalidates the observation; full-format addresses decoded offline |
| Script references (explicit, named setup script, wildcard args) | ◐ (v0.1) | explicit `{ code_hash, hash_type, args }`, `{ builtin[, args] }` for every exported system script, `{ account }` for locks, wildcard args recorded as `null`; named setup scripts stay out ([decision 2](release-decisions.md#2-repository-script-deployment-a-documented-limitation)) |
| Comparator validation rules | ✅ (v0.1) | `eq` exclusive, `lt`/`lte` exclusive, `gte` ≤ `lte`, strings only for quantities; parser-only conformance cases |

## §6 Reproducibility

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| Outcome digest and environment fingerprint, SHA-256 over RFC 8785 canonical JSON, each object self-versioned | ✅ | `src/canonical.ts`; `digests.outcome`, `digests.environment` |
| §6.1 recorded evidence | ◐ | present: manifest hash and bytes (draft.4), runner version, Git commit and dirty digest, requested/observed CKB/OffCKB/debugger, Bun pin and observed version, `bun.lock` hash, OS/arch, genesis hash, resolved system scripts, per-step hash/status/cycles/rejection, every claim's target/expected/observed/result, replay declaration and status. Missing: sanitized repository identity (URL), sealing-configuration fingerprint, deployed-binary hashes (no deployments) |
| §6.2 outcome digest contents and exclusions | ✅ | raw transaction hashes, timestamps, durations, paths and provenance are excluded; manifest-spec and outcome-schema versions included |
| §6.3 environment fingerprint contents | ◐ | as §6.1; no sealing-configuration fingerprint |
| §6.4 replay qualification `stable`/`tainted` with scoped reasons | ✅ | reason codes: the five dependencies, `dirty_source`, `source_revision_unavailable`, `source_state_unavailable`, `runtime_pin_missing`, `runtime_version_drift`, `lockfile_missing`; `nondefault_devnet` ⏸ (the devnet is always default) |
| Genesis compared with an independent allowlist | ⏸ | recorded, not allowlisted |
| Hex lowercase `0x`; large integers as decimal strings | ✅ | |

## §7 Report and CLI

| RFC item | Status | Implementation and notes |
| --- | --- | --- |
| Report with versions, evidence, outcome claims, environment, pass flag, digests, replay | ✅ | `schema`, `verdict`, `createdAt`, `evidence`, `outcomeClaims`, `environment` (with `provenance.replay`), `digests`; RFC §7 now describes this shipped contract ([decision 5](release-decisions.md#5-rfc-7-rewritten-to-the-shipped-contract), [report anatomy](evidence-report.md)) |
| `ckb-verify run [path]` | ✅ | |
| `run --report <file>`, `run --json` | ⏸ | the report path is fixed under `.ckb-verify/runs/`; machine-readable output exists for the offline commands only |
| `run --allow-version-drift` | ✅ (v0.1) | see §2 |
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
| 3. canonicalization and digest fixtures | ◐ | `tests/canonical.test.ts`, `tests/report.test.ts`; no standalone fixture files |
| 4. committed-transaction fixture | ✅ | secp transfer, cell-properties, CKB-UGMP showcases |
| 5. rejected-script fixture with group and code evidence | ◐ | code and script identity recorded and asserted; no manifest-level group pin |
| 6. non-script node-rejection fixture | ◐ | unit coverage of `kind = "node"`; no real-devnet fixture |
| 7. pure-step fixture | ⏸ | pure steps not implemented |
| 8. result-contract fixtures | ◐ | missing-result covered; pure-step variant not applicable |
| 9. zero-match / vacuous-success regressions | ✅ | draft.4 missing-output and count rules |
| 10. quantity overflow and UDT decoding | ⏸ | with `balance` |
| 11. replay fixtures (missing, empty, each dependency) | ✅ | parser and provenance tests |
| 12. two clean runs with equal digests | ✅ | every showcase and the acceptance matrix repeat case |
| 13. version-drift fixture | ◐ | runtime drift taints and changes the fingerprint; tool drift is refused rather than tainted |
| 14. cross-environment equal-outcome fixture | ✅ | cell-properties repeat comparison (`recorded-devnet-difference`) |
| Error messages with path, key path, observed value | ✅ | parser messages carry source and key path; schema problems carry the JSON Pointer |

## §9 Open questions and deferred scope

Declarative transaction construction, arbitrary genesis Cells, testnet/mainnet execution, property-based generation, and include files remain out of scope exactly as the RFC states. Of the open questions, two are answered by the implementation: the runner is a standalone package (Q1), and a step is exactly one transaction (Q3). Molecule result files (Q2), named outputs (Q5), `udt16le` naming (Q6), and the isolation container (Q7) are untouched. Q8 is answered by the merged CKB-UGMP feasibility probe only as feasibility, not adoption.

## Release decisions (#18 → #20)

The six decisions this matrix raised are recorded, with rationale and consequences, in [release decisions](release-decisions.md): (1) originally the implemented draft.3/draft.4 subset only; **reopened on 2026-11-02**: the promised vocabulary ships as `0.1.0-draft.5` ([vocabulary](vocabulary-v0.1.md)), and what remains deferred is named setup-script references, `[setup.scripts]`, pure steps, and `expect.error.group`; (2) `[setup.scripts]` deployment is a documented limitation; (3) pure steps and `accounts = 0` are not in v0.1; (4) `expect.error.group` is code-only pinning; (5) RFC §7 is rewritten to the shipped contract; (6) originally no `0.1.0` spec string at release; **reopened on 2026-11-02**: the v0.1 contract is frozen as spec `0.1.0`, the draft.5 grammar under its release identifier ([version policy](version-policy.md#the-frozen-v01-contract)), next to `0.1.0-draft.5`, `0.1.0-draft.4`, and `0.1.0-draft.3`. No ⛔ item remains; reopening a decision is a dated new entry on that page.
