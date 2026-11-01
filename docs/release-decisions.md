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

**Consequences.** Decision 6 is amended: `0.1.0-draft.5` joins the accepted identifiers. The matrix, the RFC status lines, the schemas, the conformance fixtures, and the release notes draft are updated by the pull request that implements the spec; until that merges, the rows stay as the original decision left them.

## What this record does not do

It does not freeze the RFC, publish anything, or close #20's remaining gates (package identity, candidate freeze, independent review, publication approval). Reopening any decision is a new entry here with a date and a reason, not an edit of the old one.
