# Release decisions for v0.1.0

The six decisions the [RFC-to-implementation matrix](rfc-implementation-matrix.md) listed as release-blocking, recorded on #18. Each one is the maintainer's; the pull request that added this page is the written record and its merge is the approval. The rule throughout is the roadmap's: a narrower v0.1 is an explicit scope decision, never a silent narrowing of the RFC, and nothing deferred is implied by the `v0.1.0` label.

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | First-release vocabulary | ship the implemented draft.3/draft.4 subset; the rest of RFC §4–§5 becomes v0.3 proposals |
| 2 | `[setup.scripts]` deployment | documented limitation of v0.1; v0.3 proposal |
| 3 | Pure steps and `setup.accounts = 0` | not in v0.1; v0.3 proposal |
| 4 | `expect.error.group` | code-only pinning in v0.1; v0.3 proposal |
| 5 | RFC §7 report and CLI sketch | rewritten to the shipped contract |
| 6 | Spec naming at release | `0.1.0-draft.3` and `0.1.0-draft.4` stay the only identifiers; no `0.1.0` spec string at `v0.1.0` |

Decisions 1 and 6 were reopened on 2026-11-02. Their [reopened entries](#reopened-entries) supersede the two rows above, which stay as the original record: `v0.1.0` ships the promised vocabulary, and its contract is frozen as spec `0.1.0`. Decisions 2, 3, and 4 were reopened on 2026-11-03 ([entry](#2026-11-03-decisions-2-3-and-4-reopened-the-rest-of-the-proposals-target-v01-ships-as-spec-020)): `[setup.scripts]`, pure steps, `accounts = 0`, and `expect.error.group` ship in `v0.1.0` under spec `0.2.0`, with the frozen `0.1.0` unchanged.

## 1. First-release vocabulary: the implemented subset

**Decision.** `v0.1.0` ships exactly what the matrix marks supported or partial: the draft.3 vocabulary (`expect.tx`, `expect.error.code`, `out_point` Cell assertions with `count`) and the draft.4 typed Cell, argument-length, data-length and builtin CellDep claims. `balance` (§5.2, including quantities and UDT decoding), Cell selectors by script filter, `count`/`data.eq`/`capacity` comparators (§5.1), named script references and wildcard args (§5.3), comparator validation (§5.4), and `expect.cycles` (§4.2) are **v0.3 proposals**. The RFC sections keep their text and anchors and carry a status line saying so.

**Why.** Every deferred item needs machinery that does not exist (an indexer query path, a quantity grammar, UDT decoding, a deployment path), and no observed user need has asked for any of them: no external pilot has run ([external checkpoints](external-checkpoints.md)). Implementing them before a release would widen the surface that must be verified without evidence that it is the right surface.

**Consequences.** The matrix is the authoritative statement of what `v0.1.0` does; the release notes list the deferred items under known limitations; the manifest schema already rejects the deferred keys, so a manifest that uses them fails `validate` with a field path rather than being partially honoured.

## 2. Repository script deployment: a documented limitation

**Decision.** `[setup.scripts.<name>]` with `binary` (Type ID or data-hash deployment, recorded hashes and out-points) is not part of `v0.1.0`. The runner verifies flows built on OffCKB built-ins, referenced directly from draft.4 claims as `builtin = "dao" | "spore"`. This is a **v0.3 proposal** whose acceptance needs a project that deploys its own script and asks for it.

**Why.** No deployment path exists, deployment changes what the outcome digest must cover (deployed-binary hashes, out-points), and the one real project exercised so far (the CKB-UGMP feasibility adaptation) runs on built-ins.

**Consequences.** `docs/release-notes-draft.md` and `docs/maintenance.md` state the limitation; the matrix row stays deferred with this reason.

## 3. Pure steps and `setup.accounts = 0`: not in v0.1

**Decision.** Every step produces exactly one signed transaction, and `setup.accounts` is `1..20`. Steps without a transaction (immediate assertions only) and manifests with no funded signer are **v0.3 proposals**; RFC §3.1, §4.3 and the §8.7–8.8 fixture descriptions carry the status line.

**Why.** No producer written so far needs either, both change runner semantics (a step that is not submitted, a devnet with no exported accounts) and require their own fixtures, and the parser already rejects both explicitly (`accounts` out of range; a step without a result envelope is an execution error), so nothing is silently misinterpreted.

**Consequences.** The manifest schema keeps `accounts` at `1..20`; the matrix rows change from "decide" to deferred with this reason.

## 4. `expect.error.group`: code-only pinning

**Decision.** In `v0.1.0` a rejected-transaction expectation pins the script error code (`expect.error.code`) and the terminal status; the responsible script group is **recorded** in the rejection evidence (`role`, `source`, `script`, `scriptHash`) and covered by the outcome digest, but the manifest cannot pin it. The manifest-side pin is a **v0.3 proposal**.

**Why.** The evidence needed for the pin is already produced by the pinned debugger path, so adding the manifest key is small, but the key's reference form depends on decision 2 (named setup scripts) and decision 1 (script references); fixing its syntax now would pre-empt both. A security-negative manifest today pins the code and reads the group from the report.

**Consequences.** The RFC §4.2 row carries the status line; the matrix row stays deferred with this reason; `docs/evidence-report.md` already documents the recorded group.

## 5. RFC §7: rewritten to the shipped contract

**Decision.** RFC §7 no longer shows the pre-implementation `spark-verify-*` snake_case sketch. It now describes the shipped `ckb-verify-report/1` and `/2` artifacts (`schema`, `verdict`, `createdAt`, `evidence`, `outcomeClaims`, `environment` with `provenance.replay`, `digests`), points at the published schema and the checked example, and lists the implemented commands and exit codes (`run`, `validate`, `digest`, `check-digest --outcome/--environment`, `check-bundle`). `run --report`, `run --json` and `--allow-version-drift` are recorded as not implemented.

**Why.** The published schemas and the RFC must say the same thing; the matrix marked the mismatch as the one blocking piece of work rather than a choice.

**Consequences.** The RFC header's implementation note is updated; `docs/evidence-report.md` remains the field-by-field guide.

## 6. Spec naming at release: draft identifiers stay

**Decision.** At `v0.1.0` the manifest spec identifiers are `0.1.0-draft.3` and `0.1.0-draft.4`, both read and written, mapping to `ckb-verify-report/1` and `/2` as today. No `0.1.0` spec string is introduced. `0.1.0-draft.3` is retained through the `v0.1.x` line; its retirement, if it comes, is announced one minor release ahead per the [version policy](version-policy.md#what-changes-a-version) and its fixtures stay as long as the verifier reads it.

**Why.** Decisions 1–4 leave the RFC a draft with v0.3 proposals pending, so a spec string without a draft suffix would name a grammar the RFC itself calls incomplete. The runner version and the spec identifier are independent by policy: `v0.1.0` of the runner can implement draft grammars honestly. A `0.1.0` spec string is reserved for the first grammar freeze after the v0.3 proposals are accepted or rejected.

**Consequences.** The version policy's open-decisions section is replaced by this record; the release notes name both identifiers; no parser, schema, or fixture changes.

## Reopened entries

Reopening a decision is a dated entry here, not an edit of the original text above.

### 2026-11-02: decision 1 reopened, the promised vocabulary is implemented as spec `0.1.0-draft.5`

**Why.** The original decision read the missing vocabulary as deferrable because no observed user need asked for it. That reading ignored that the [Spark proposal revision 0.3](spark-proposal.md#8-deliverables--how-to-verify) lists cycle comparators, script-filtered Cell selection with `data`/`data.len`/`capacity` checks, and native CKB and 16-byte little-endian UDT/xUDT balance claims as funded deliverable 2. Keeping decision 1 as written would narrow the promised scope by decision, which the roadmap forbids. The [proposal coverage](proposal-coverage.md) record makes the gap explicit.

**New decision.** `v0.1.0` ships the RFC §4.2 `expect.cycles.{lt,lte,eq,gte}` comparators, the §5.1 Cell selectors by `lock`/`type` script filter with `count` comparators, `data.eq`, `data.len`, and `capacity` comparators, the §5.2 `balance` claims (CKB and 16-byte little-endian UDT) with the quantity grammar, and the §5.3 explicit, builtin, and wildcard-args script references, as a new manifest spec `0.1.0-draft.5` with its own report, outcome, and schema versions per the [version policy](version-policy.md). `0.1.0-draft.3` and `0.1.0-draft.4` keep their grammars. Decision 2 (`[setup.scripts]` deployment, which the proposal does not promise) and decision 3 (pure steps, `accounts = 0`) are unchanged; named setup-script references therefore remain out of scope and the §5.3 named form resolves OffCKB built-ins only. Decision 4 is unchanged: `expect.error.group` stays code-only until the named-script question is settled.

**Consequences.** Decision 6 is amended: `0.1.0-draft.5` joins the accepted identifiers. Implemented: the [vocabulary](vocabulary-v0.1.md) page, the [vocabulary fixture](../showcases/vocabulary/README.md) on a fresh devnet, report `/3` with environment `/4` and provenance `/3`, the published schema branches, 14 conformance fixtures, `run --allow-version-drift`, and the updated matrix, RFC status lines, version policy, and release notes draft.

### 2026-11-02: decision 6 reopened, the v0.1 contract is frozen as spec `0.1.0`

**Why.** Decision 6 kept every identifier a draft because decisions 1–4 left the RFC a draft with v0.3 proposals pending, and a spec string without a suffix would name a grammar the RFC itself calls incomplete. Two things changed. Decision 1 was reopened, so the vocabulary the proposal promised is implemented and the reason "the promised grammar is incomplete" no longer holds. And the [Spark proposal](spark-proposal.md#8-deliverables--how-to-verify) promises a **frozen** `verify.toml` v0.1 contract as deliverable 1, built by reconciling "the draft RFC with the deliberately smaller implemented subset". The proposal never asked for the whole RFC to be frozen, only for the implemented subset. Keeping the draft suffix on every identifier would leave deliverable 1 unmet by decision, which the roadmap forbids, and the [proposal coverage](proposal-coverage.md) record showed it as partial.

**New decision.** `0.1.0` is the frozen v0.1 manifest spec: the draft.5 grammar under its release identifier, written as `ckb-verify-report/3` with `outcome/3`, `environment/4`, and `provenance/3`. That tuple, with evidence bundle `/1` and producer protocol `1`, is frozen as defined in the [version policy](version-policy.md#the-frozen-v01-contract), and `tests/frozen-contract.test.ts` checks it against a lock. `0.1.0-draft.5` stays accepted with the identical grammar; `0.1.0-draft.3` and `0.1.0-draft.4` are unchanged. The RFC stays a draft: the sections deferred by decisions 2–4 belong to a later spec, never to `0.1.0`. The repository's own manifests (the root `verify.toml` and the vocabulary fixture) use `0.1.0`.

**Consequences.** Implemented: the parser, the report/3 tuple check (evidence and outcome must name the same identifier), the manifest and report schemas, the golden report and lock, the `0.1.0` conformance twin with the whole draft.5 corpus re-run under `0.1.0`, and the version policy, vocabulary page, matrix, RFC status lines, and release notes draft. The `unsupported-spec` conformance fixture, which used `0.1.0` as its example of an unknown spec, now uses `0.2.0`.

### 2026-11-02: decision 6 amended, the verifier may refuse more before the contract is published

**Why.** A pre-release review of the frozen candidate `d99117b` found reports that verified VALID although no runner can write them. Examples: CKB drift hidden by editing the observed version, impossible rejection evidence, an exported-account count that differs from the manifest, and duplicate JSON keys. The [version policy](version-policy.md#the-frozen-v01-contract) said a frozen identifier never accepts or rejects anything differently. Read literally, that would ship those holes forever, under a contract that was frozen the same day and is not yet published.

**New decision.** Until `v0.1.0` is first published, a verifier fix may refuse an artifact that no released or candidate runner can write, provided it changes neither the schemas, nor the lock, nor the golden report's digests. Each such fix is listed in the changelog and in the [candidate review record](acceptance/2026-11-02-candidate-review.md). From first publication on, the original rule applies without exception: any change to what a frozen identifier accepts needs a new identifier.

**Consequences.** The review's verifier fixes ship in `0.1.0`. `tests/frozen-contract.test.ts` and `lock.json` are unchanged and still pass. The candidate is re-frozen and re-gated with the fixes.

### 2026-11-02: package identity and publication path

**Decision (maintainer, on #20).** `v0.1.0` is published as a GitHub release with the tarball, `SHA256SUMS`, and the evidence archive as assets. It is not published to the npm registry. The package name stays `ckb-verify`, and `private: true` stays. The maintainer creates the tag and release (step 8 is approved) by following the [v0.1.0 release runbook](release-runbook-v0.1.0.md), after the independent review of the candidate is recorded.

**Why.** The exercised installation path is the tarball, so no new candidate is needed. Registry publication would add an account, two-factor authentication, and a credential surface the repository has no use for yet.

### 2026-11-03: decisions 2, 3, and 4 reopened; the rest of the proposal's target v0.1 ships as spec `0.2.0`

**Correction first.** The decision 1 entry of 2026-11-02 calls `[setup.scripts]` deployment something "the proposal does not promise". That is wrong. [Spark proposal revision 0.3 §4](spark-proposal.md#4-solution) describes the target v0.1 runner as one that "exposes deterministic devnet accounts and deployed/built-in script metadata" and "runs each project command as either a declared pure step or a transaction-producing step". Its example manifest declares `[setup.scripts.sample_lock]` with `binary` and `hash_type = "type"`, and its vocabulary lists "script group and error code for negative tests". [§5](spark-proposal.md#5-technical-approach) puts "repository binary and OffCKB built-in script resolution" in the execution adapter. The earlier text is kept as written; this entry supersedes it. Deferring these items narrowed the promised scope by decision, as decision 1 had before.

**New decision.** These ship in `v0.1.0` under a new manifest spec, `0.2.0`, written as `ckb-verify-report/4` with `outcome/4`, `environment/5`, and `provenance/4`:

- **[`[setup.scripts]`](verify-toml-rfc-v0.2.md#3-setup) (reverses decision 2):** repository binaries deployed by the runner through `offckb deploy`, with `type` (Type ID), `data`, `data1`, or `data2`. Each code Cell is verified on chain against the binary's bytes, and the binary hash enters the outcome. Built-in aliases are also supported.
- **Named script references** of the form `"name"` and `{ script = "name", args }`.
- **Pure steps and zero accounts** (reverse decision 3).
- **`expect.error.group`** (reverses decision 4), satisfied only by script evidence from the named lock or type group, and refused when the reference matches more than one group of the transaction.

The maintainer also chose on 2026-11-03 to implement the RFC items the proposal does not name:

- zero steps;
- terminal node rejections from `send_transaction`, recorded with their RPC code;
- every common lockfile and runtime pin (npm, pnpm, yarn, Cargo, `.tool-versions`, `mise.toml`, `.nvmrc`), with the versions the step environment actually has;
- a sanitized repository identity;
- the devnet sealing-configuration fingerprint, with `nondefault_devnet`;
- the genesis checked against a pinned allowlist;
- `run --report <file>` and `run --json`.

Spec `0.1.0` and its tuple are frozen and unchanged; nothing above is added to them.

**Consequences.**

- **Code:** parser `src/manifest-v6.ts`, claims and verification in `src/claims-v4.ts` (sharing the 0.1.0 claim derivation), `src/provenance-v4.ts`, `src/devnet-identity.ts`, deployment in the OffCKB adapter, and schema files `ckb-verify-manifest-v2`, `ckb-verify-claims-v4`, and `ckb-verify-provenance-v4`, plus a `report/4` branch.
- **Showcase:** the [repository-script showcase](../showcases/repository-script/README.md) deploys a lock script assembled from this repository and runs the full flow on fresh devnets: create, legal spend, group-pinned illegal spend, node rejection, negative controls, repeat, and a variant binary.
- **Release:** `e311ad3` is no longer the release candidate. A new candidate must be frozen and re-gated, and the independent review covers it.

### 2026-11-10: candidate `9b39a98` frozen; close-out hardening; the `elliptic` waiver renewed once

**Decision.** The v0.1.0 candidate is `main` at `9b39a98` (#49). Development ends there, and the project moves to maintenance ([close-out report](reports/2026-11-10-closeout.md), Chinese).

- **What #49 added to the candidate frozen for spec `0.2.0`:** bounded retries of the two pinned release downloads, `src/setup-project.ts` (one-command installation of the packed tarball, also the way the consumer acceptance matrix now installs), the cache in the reusable workflow, and a quick start in the README.
- **Waiver:** the `elliptic` waiver was renewed once, to 2026-12-25, with the patch prepared on 2026-11-03 ([record](waiver-renewal-fallback.md)). It was applied because the release had not been published and the gate would have failed from 2026-11-25. `git apply -R docs/fallback/elliptic-waiver-renewal.patch` reverses it.
- **Gates:** release checklist steps 1–6 passed on `9b39a98` ([record](acceptance/2026-11-10-candidate-9b39a98.md)).

**Still open.** The independent review, and step 8. The publication approval on #20 was given for `e311ad3`; the maintainer confirms it for `9b39a98` before publishing, by 2026-12-24.

## What this record does not do

It does not freeze the RFC (only the v0.1 contract above), publish anything, or close #20's remaining gates (package identity, candidate freeze, independent review, publication approval). Reopening any decision is a new entry here with a date and a reason, not an edit of the old one.
