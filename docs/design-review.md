# Design review and submission gates

This review compares the original Spark Verify proposal/RFC with current Spark requirements and the CKB toolchain. It records the important changes made before creating the public repository.

## Verdict

**Promising CKB-specific idea, but not application-ready yet.**

The core gap is credible: OffCKB, CCC, ckb-debugger, and ckb-testtool do not currently define a shared, declarative end-to-end acceptance-claim format. The strongest version of Spark Verify is a **thin claim/evidence layer**, not a replacement devnet, transaction builder, debugger, CI platform, or audit tool.

The original draft had enough semantic and validation gaps that implementing it immediately would likely freeze the wrong contract. The revised RFC addresses the obvious blockers, while four external readiness gates remain.

## Priority findings

### P0 — Rejected transactions made the stdout hash contract incomplete

The original command submitted its own transaction and returned a hash. On CKB, a script-invalid transaction may be rejected by `send_transaction` before it becomes queryable. That leaves negative tests without a reliable hash or retained transaction, even though `expect.error.code` and `expect.error.script` depend on exactly that evidence.

**Decision:** a step writes one signed JSON-RPC transaction to `SPARK_VERIFY_RESULT`; the runner submits it through OffCKB's proxy. stdout/stderr are logs only. v0.1 supports one transaction per step.

### P0 — “Pinned CKB” did not make the run reproducible

The original digest contract pinned the node but omitted OffCKB, ckb-debugger, repository dirty state, lockfiles, devnet genesis/config, and deployed binary hashes. It also used unspecified “canonical JSON.”

**Decision:** use RFC 8785 JSON Canonicalization Scheme and SHA-256 for two separate identities. The outcome digest covers normalized claim definitions, relevant deployed artifacts, and observations. The environment fingerprint covers Git, manifest bytes, tool/runtime versions, lockfiles, OS/architecture, and devnet provenance. A separate replay status carries scoped reasons. Equal outcomes do not imply equal environments, and neither hash proves arbitrary scripts deterministic.

### P0 — Arbitrary `run` commands are a security boundary

A `verify.toml` is executable repository code. A GitHub Action that automatically runs it for an untrusted pull request can leak secrets or compromise the runner.

**Decision:** v0.1 is for trusted repositories, hard-fails outside a loopback fresh devnet, ships a security guide, and demonstrates no-secrets CI. Sandboxing is not silently promised.

### P0 — Zero matching Cells could pass vacuously

The original stated that data/capacity properties apply to every match. Without cardinality, zero matches makes “every match” true, so a misspelled script could pass.

**Decision:** per-Cell properties impose effective `count.gte = 1`; absence requires an exact zero (`count = 0` or `count.eq = 0`); exact-zero absence cannot be combined with per-Cell properties.

### P1 — The proposal and RFC used incompatible TOML

The proposal used `[[steps]]`, `setup.scripts = [...]`, inline `expect.cell = { ... }`, and `[[assert]] balance = { ... }`. The RFC used `[[step]]`, named script tables, `[[step.assert.cell]]`, and `[[assert.balance]]`.

**Decision:** README and proposal use one canonical syntax matching the revised RFC.

### P1 — Real projects need stable references beyond copied addresses

The original required literal addresses and broad script filters. Deterministic account addresses should not be copied into manifests, and broad filters cannot identify a specific output.

**Decision:** add `account = N` and `out_point = { step, index }`. A script reference with omitted args is explicitly a wildcard, not empty args.

### P1 — OffCKB built-ins were missing

Many CKB applications use xUDT, Spore, OmniLock, or other scripts already available from OffCKB rather than deploying a repository binary. A real Spark example such as CKB-UGMP would need this.

**Decision:** draft `builtin = "spore"` script references, with exact resolved metadata in the report. This field needs OffCKB maintainer review before freeze.

### P1 — Script error references were ambiguous

A name alone does not say lock vs type group and may match several groups with different args.

**Decision:** `expect.error.group` includes `role = "lock" | "type"`, a script reference, and exact args/group identity when needed.

### P1 — UDT and capacity numeric semantics were underspecified

Bare TOML integers do not cover unsigned 128-bit token values, JavaScript JSON numbers can lose precision, and “xUDT balance” is not a license to decode arbitrary Cell data.

**Decision:** asset quantities are decimal strings; native amounts use exact CKB/shannon units; v0.1 token decoding is explicitly a 16-byte little-endian unsigned amount prefix and errors on malformed data.

### P1 — The original scope was too broad for a standard Spark grant

The draft included an RFC, kernel, parser, six-to-eight assertions, JSON and HTML reports, CLI, GitHub Action, two examples, npm publication, and self-verification over 6–8 weeks, with no numeric budget and no proof of deterministic replay.

**Decision:** request the standard **$1,000**, remove HTML and hosted services, use a six-week plan with a Week 1 feasibility gate, and bind every budget line to evidence. A request above $1,000 is not justified before demand and feasibility are proven.

## RFC draft 0.2 integration review

The submitted draft 0.2 contributed two worthwhile changes: it separated outcome agreement from environment identity, and it named immediate state checks `step.assert` rather than mixing them into transaction expectations. Those changes are integrated.

It was not published verbatim because several details would have regressed the stricter draft:

- one “all parser-valid” script-reference fence assigned `type` four times and fails a real TOML parser;
- `offckb = ">=0.3"` was described as pinned even though it is a range;
- document revision 0.2, intended spec v0.1, and runner version were not clearly separated;
- the structure table named `[[assert]]` although the canonical tables were `[[assert.cell]]` and `[[assert.balance]]`;
- `data2`, the versioned result envelope, strict quantity strings, and exact 16-byte little-endian token decoding were lost;
- the no-vacuous rule was extended to aggregate balances, which would make a legitimate zero balance unable to pass;
- the proposed outcome digest omitted normalized expected comparators/values, allowing different claims to share a digest; and
- outcome-level nondeterminism was worded as automatically detectable even though arbitrary repository code cannot be fully observed.

The integrated RFC keeps exact tool pins and the stronger command, asset, and trust semantics while adopting the two-hash model. Full worked examples are parsed as complete manifests rather than treating alternative snippets as one document.

## Proposal document revision 0.2 review

The concise revision sharpened three useful points that are now reflected in the application draft: the specification/result contract is the reusable asset rather than a project-specific CI file; the implementation has explicit execution, manifest/assertion, and evidence layers; and Week 1 is an evidence-bound feasibility gate rather than assumed success.

The proposal example was normalized to the RFC's canonical `[meta]` plus `[toolchain]` layout, exact current pins, `expect.status`, `[[step.assert.cell]]`, and direct `account = N` balance targeting. The following wording was not carried forward:

- “deterministic” as an unqualified property of arbitrary repository commands;
- the suggestion that a read-only RPC facade prevents repository code from reading host secrets or using other network/process interfaces;
- identical cross-machine outcomes as a guaranteed milestone before the feasibility slice establishes the boundary; and
- the separate PropCKB/fuzz-tool pitch, which distracts from the narrow funded scope.

The application therefore keeps the uploaded revision's stronger framing while retaining the existing proposal's official-template structure, explicit CKB boundaries, budget evidence, current-vs-funded accounting, and linked go/no-go issues.

## Vocabulary assessment

The MVP vocabulary can cover many script/dApp acceptance flows if it includes:

- step `committed` / `rejected`;
- script group + error code;
- cycle bounds;
- Cell count/data/length/capacity;
- output/out-point references;
- native and 16-byte LE UDT-compatible balances;
- deterministic account references;
- OffCKB built-in scripts.

It will **not** express every deliverable. Examples outside v0.1 include header/epoch/since assertions, DAO interest, transaction fee and size assertions, event/log assertions, Molecule field decoding, Spore semantic decoding, multiple transactions in one step, network protocols such as Fiber, and testnet/mainnet evidence. Those should use repository checks or motivate later vocabulary only after concrete demand.

## Ecosystem overlap

| Existing tool | Existing responsibility | Spark Verify boundary |
| --- | --- | --- |
| [OffCKB](https://github.com/ckb-devrel/offckb) | Local devnet, accounts, script deployment, proxy/dumps, debug commands | Orchestrate a pinned run and normalize declared claims/report |
| [CCC](https://github.com/ckb-devrel/ccc) | Transaction construction/signing and CKB queries | Accept a signed CCC-compatible JSON-RPC transaction from project code |
| [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger) | Execute/debug CKB script groups and cycles | Normalize relevant evidence into step expectations |
| [ckb-testtool](https://github.com/nervosnetwork/ckb-testtool) | Script-level unit-test helpers | End-to-end repository acceptance flow and final live-chain state |

The thin-wrapper objection remains legitimate. Before applying, an OffCKB maintainer should answer whether this belongs as an OffCKB command/plugin or as an external conformance layer. The durable asset should be the manifest/report semantics and fixtures, regardless of package boundary.

## Likely committee objections

1. **“Who will use it?”** No adopter or completed Spark example is currently confirmed.
2. **“Is this just OffCKB plus CI?”** Without a working negative-test and report/digest slice, the differentiation is still prose.
3. **“Can arbitrary scripts really be reproducible?”** Only comparable provenance/claims can be guaranteed; external behavior cannot.
4. **“Why fund $1,000 of tooling before a spike?”** Week 1 must prove the narrowest useful path and allow a no-go result.
5. **“Who is accountable?”** The public maintainer is an AI agent account. A human/legal operator, contact details, and payout responsibility must be explicit.
6. **“Does the applicant have implementation evidence?”** QuorumCell is currently a design note with no code. It cannot be represented as a shipped script.

## Pre-submission gates

Do **not** present the grant draft as application-ready until:

- [ ] **Accountability:** named human operator/applicant, email, Discord, and payout entity/wallet are added ([#4](https://github.com/Akane-CN/spark-verify/issues/4)).
- [ ] **Feasibility:** a throwaway slice captures committed and script-rejected transactions, cycles, one Cell assertion, and two clean runs with equal outcome digests and environment fingerprints ([#1](https://github.com/Akane-CN/spark-verify/issues/1)).
- [ ] **Demand:** one CKB maintainer/project agrees to trial the format and supplies a concrete flow. Prefer a completed Spark project; CKB-UGMP is a possible Spore/CCC candidate but is not confirmed ([#3](https://github.com/Akane-CN/spark-verify/issues/3)).
- [ ] **Upstream fit:** an OffCKB maintainer responds publicly on standalone vs plugin/subcommand placement and built-in script references ([#2](https://github.com/Akane-CN/spark-verify/issues/2)).

These gates should be issues with linked evidence, not claims hidden in a proposal edit.

## Recommendation

Publish this repository as an RFC and ask for narrow feedback. Do not post the budget request yet. Once the four gates close, the $1,000 six-week proposal is credible. If the feasibility slice reveals that rejected transactions or deterministic devnet replay require invasive OffCKB changes, prefer an upstream contribution or a smaller schema/conformance-only grant instead of expanding the wrapper.
