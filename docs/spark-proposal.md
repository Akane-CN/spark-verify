# Spark Program | Spark Verify / `ckb-verify` — Executable Acceptance Claims for CKB Projects

> **Application status: [pending Spark Program review on Nervos Talk](https://talk.nervos.org/t/spark-program-spark-verify-reproducible-acceptance-checks-for-ckb-projects/10598).** This is proposal document revision **0.3** and accompanies the [`verify.toml` RFC draft 0.2](verify-toml-rfc-v0.2.md). The application was originally submitted before implementation. Since submission, the applicant independently completed and published a narrow feasibility implementation. That work is recorded as pre-funding evidence and is excluded from the remaining requested budget; it is not presented as a release, grant completion, or external adoption.

## 1. Project Overview

**Project name:** Spark Verify; CLI/package name: `ckb-verify`

**One-sentence summary:** A CKB-specific `verify.toml` format and thin runner that execute a project's declared devnet transaction flows, check observable Cell/balance/script outcomes, and emit a comparable evidence report.

**Project type:** Developer tool / manifest specification / Bun-based CLI

Spark Verify turns a free-form “How to Verify” section into an executable artifact. A project author declares the CKB toolchain pins, setup scripts, transaction-building steps, and expected on-chain outcomes. A reviewer runs one command against a local OffCKB devnet and receives a pass/fail report with transaction status, cycles, script errors, final Cell/balance observations, an outcome digest, a separate environment fingerprint, and explicit replay qualification.

The deliverable is not a project-specific CI script. Its reusable asset is a small manifest specification, assertion vocabulary, result protocol, and evidence model; the runner is the implementation that makes those contracts executable over existing CKB tools.

It does not infer whether a project is correct and does not replace security review. It verifies only the claims the author chose to declare.

The current `0.0.1` technical preview implements a deliberately smaller subset: strict manifest parsing, a fresh pinned OffCKB lifecycle, one signed transaction per step, committed/rejected expectations, numeric script-error matching, exact live-output Cell counts, a structured `ckb-verify-report/1` report, and separate outcome/environment digests. See the [annotated current manifest](annotated-manifest.md) and [checked report example](evidence-report.md). Broader language in this proposal and RFC describes remaining v0.1 targets unless explicitly marked complete.

## 2. Team Profile

**Applicant and maintainer:** Akane

- GitHub: [Akane-CN](https://github.com/Akane-CN)
- Nervos Talk: [Akane](https://talk.nervos.org/u/Akane)
- Contact: [akane@random-walk.co.jp](mailto:akane@random-walk.co.jp)
- Role: specification, TypeScript implementation, OffCKB/CCC integration, conformance tests, examples, and documentation

This is a personal open source project. The public GitHub identity, contact, and CKB payout destination are disclosed in this draft so the committee can verify responsibility before approving funding.

## 3. Project Background

Spark's current proposal template asks applicants to provide a low-cost path by which the committee and community can independently verify deliverables, preferably without line-by-line code review. In practice, these instructions are still project-specific prose: install a stack, run scripts in the right order, inspect RPC results, and interpret whether the observed CKB state matches the claim.

That creates three recurring costs:

1. **Setup drift:** tool versions and development-chain behavior change after the proposal is written.
2. **Interpretation drift:** a reviewer must translate prose into RPC queries and decide what “working” means.
3. **Evidence drift:** screenshots and logs do not define a stable, machine-readable set of claims that can be rerun later.

CKB already has strong lower-layer tools. OffCKB starts a local devnet, provides deterministic development accounts, deploys scripts, and captures failed transactions. CCC constructs transactions. ckb-debugger reports script outcomes and cycles. ckb-testtool supports script unit tests. The missing layer is a small, shared acceptance vocabulary that orchestrates those tools for an end-to-end deliverable.

Official Spark references:

- [Spark Program: Mini-Grant Initiative](https://talk.nervos.org/t/spark-program-mini-grant-initiative/8752)
- [2026 proposal template and “Deliverables + How to Verify” requirements](https://talk.nervos.org/t/spark-program-mini-grant-initiative/8752/7)
- [2026 GitHub identity/repository requirement](https://talk.nervos.org/t/spark-program-mini-grant-initiative/8752/10)

## 4. Solution

An author adds `verify.toml` and a small transaction-builder adapter to a trusted repository. The target v0.1 runner:

1. validates the manifest against the versioned schema;
2. starts a fresh OffCKB devnet with exact versions;
3. exposes deterministic devnet accounts and deployed/built-in script metadata;
4. runs each project command as either a declared pure step or a transaction-producing step;
5. for a transaction-producing step, validates the signed transaction artifact and submits it itself so committed and rejected cases are both retained;
6. records status, script group/error code, and cycles;
7. queries final live Cells and balances;
8. evaluates the declared claims; and
9. writes JSON plus a human-readable summary, outcome digest, and environment fingerprint.

An abbreviated, draft-RFC-valid target manifest looks like this. The `0.0.1` runner does not yet accept every field below; the exact executable subset is in the [annotated current manifest](annotated-manifest.md).

```toml
[meta]
name = "sample-lock-basic"
spec = "0.1.0-draft.3"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
ckb-debugger = "1.1.1"

[replay]
dependencies = []

[setup]
accounts = 3

[setup.scripts.sample_lock]
binary = "build/sample_lock"
hash_type = "type"

[[step]]
name = "create protected cell"
run = "bun run scripts/build-create.ts"

[step.expect]
tx = "committed"
cycles.lt = 5_000_000

[[step.assert.cell]]
out_point = { step = "create protected cell", index = 0 }
lock = { script = "sample_lock", args = "0x0102" }
count = 1

[[assert.balance]]
account = 1
gte = "999 CKB"
```

The target v0.1 vocabulary is intentionally small:

- step transaction committed/rejected;
- script group and error code for negative tests;
- cycles under/equal/over a bound;
- live Cell selection by script or prior step output;
- Cell count, data, data length, and capacity;
- native CKB or 16-byte little-endian UDT/xUDT-compatible balance.

Anything exotic remains repository code. Spark Verify does not become a general programming language.

### What it does not claim

- It does not prove that the manifest is complete or honest.
- It does not make untrusted repository code safe to execute.
- It does not replace CKB script unit tests, audits, or code review.
- It does not run against testnet/mainnet in v0.1.
- It does not recreate OffCKB, CCC, ckb-debugger, or ckb-testtool.

## 5. Technical Approach

**Language and packaging:** TypeScript with Bun as the runtime and package manager. The repository will pin the exact Bun version and commit `bun.lock`; the finished CLI will be published as an installable package.

**Dependencies:** OffCKB for devnet/deployment/proxy evidence; CCC-compatible JSON-RPC transactions from project adapters; ckb-debugger/OffCKB debug output for script groups, error codes, and cycles; a strict TOML parser plus runtime schema validation.

The architecture keeps one execution kernel behind three public layers: OffCKB lifecycle and runner-owned submission; manifest parsing plus assertion evaluation; and report, CLI, and CI surfaces. Those boundaries map to the modules below.

### Modules

1. **Manifest and conformance**
   - strict parser with unknown-key rejection;
   - machine-readable schema after TOML parsing;
   - versioned valid/invalid fixtures;
   - exact quantity and script-reference normalization.

2. **Execution adapter**
   - fresh OffCKB lifecycle and readiness checks;
   - repository binary and OffCKB built-in script resolution;
   - deterministic account/context files;
   - step process timeout and result-file protocol;
   - runner-owned transaction submission.

3. **Assertion engine**
   - step `tx`/cycles/error expectations;
   - live Cell/out-point queries;
   - Cell and balance comparators;
   - explicit zero-match semantics.

4. **Evidence and CLI**
   - JSON report and terminal diff;
   - Git/toolchain/genesis/binary provenance;
   - RFC 8785 canonical outcome/environment objects and separate SHA-256 hashes;
   - GitHub Action wrapper.

### Key technical risks

- **Rejected transactions:** a command that submits its own invalid transaction may never receive a queryable hash. v0.1 therefore requires the command to return a signed transaction and lets the runner submit it.
- **False reproducibility:** pinning only CKB is insufficient. Target v0.1 reports will separate outcome agreement from environment identity; record OffCKB/ckb-debugger/runtime versions, repository revision/dirty state, lockfile hashes, OS/architecture, genesis fingerprint, and deployed binary hashes; and never treat either hash as proof of determinism. A required `[replay].dependencies` array will make the author's time/randomness/fee/`since`/network declaration part of the manifest; `stable` will remain qualified by that declaration rather than presented as runner-proven determinism.
- **Arbitrary code execution:** `run` is trusted repository code. The current loopback query URL and runner-owned submission protocol create a canonical evidence path, but they do not cryptographically enforce read-only behavior or sandbox filesystem, process, and network access. The first release includes an explicit security guide and a no-secrets CI example.
- **Tool overlap:** the implementation remains an orchestration layer. Week 5 includes public OffCKB maintainer feedback on whether it should remain standalone or expose an upstream adapter.
- **No adopter yet:** a bounded CKB-UGMP Spore-mint adaptation exists in [PR #7](https://github.com/Akane-CN/spark-verify/pull/7), but no upstream maintainer has agreed to adopt, endorse, or trial it. The PR is independent pre-funding feasibility evidence, not completion of the external-pilot deliverable. If no suitable adopter agrees, the project will publish that result and reduce the integration scope rather than inventing adoption.

## 6. Remaining Execution Plan (6 weeks after approval)

The core runner-owned transaction feasibility question is already resolved as independent pre-funding work. It produced the working `0.0.1` runner, the secp committed/rejected/assertion-failure showcase, clean repeated digests, and the current Linux CI workflow. The broader version-drift/taint and complete provenance criteria in [issue #1](https://github.com/Akane-CN/spark-verify/issues/1) remain v0.1 work. Existing artifacts de-risk the proposal but are not billed below.

### Week 1 — Freeze the v0.1 contracts

- reconcile the draft RFC with the deliberately smaller implemented subset;
- publish a machine-readable parsed-TOML schema and versioned valid/invalid fixtures;
- freeze the v0.1 report, outcome, and environment schemas;
- define compatibility and migration rules from `0.1.0-draft.3`;
- turn replay dependencies into report-visible qualification rather than an unreported input check.

**Milestone:** schema-backed manifest/report contracts with conformance fixtures that reject unknown or unsupported semantics.

### Weeks 2–3 — Complete the bounded assertion vocabulary

- add cycle comparators and normalized failure diffs;
- add script-filtered Cell selection plus data, data-length, and capacity checks;
- add native CKB and 16-byte little-endian UDT/xUDT-compatible balance claims;
- retain exact zero-match semantics and independently derived verdicts;
- extend positive, rejection, tamper, and boundary regression fixtures.

**Milestone:** the v0.1 assertion matrix runs end to end on fresh Linux devnets without expanding into a general programming language.

### Week 4 — Release CLI and CI surface

- implement `validate`, `digest`, and `check-digest` commands around the frozen schemas;
- add the repository-root dogfood manifest and clean-checkout release harness;
- package the `ckb-verify` CLI and publish a pinned reusable CI example;
- verify the supported Ubuntu path and test macOS capability explicitly;
- document unsupported platform behavior instead of claiming unverified support.

**Milestone:** a release candidate installs from a clean checkout and exposes one documented verification command with preserved evidence artifacts.

### Week 5 — External pilot and upstream-fit gate

- request public OffCKB maintainer feedback on standalone versus upstream integration;
- ask a named CKB project maintainer to consent to a bounded trial;
- if a project consents, refine one integration from maintainer feedback without importing the project's UI, wallet, hosted services, or unrelated stack;
- measure reviewer setup time and publish any failure to obtain adoption without relabeling independent probes as adoption.

The initial CKB-UGMP code adaptation in PR #7 is pre-funding feasibility evidence. Funded integration work begins only after explicit project-maintainer consent and must arise from the actual pilot; outreach, upstream feedback, and a documented demand/no-go result remain separately auditable work if no pilot is agreed.

**Milestone:** public maintainer feedback and either one consented pilot or a documented demand/no-go result.

### Week 6 — Tagged release and completion evidence

- publish the CLI package and tagged v0.1 specification;
- finalize reference, security, integration, and migration documentation;
- record a short end-to-end demo;
- run the release verification checklist from a clean machine or runner;
- publish the Spark completion report and transparent budget report.

**Milestone:** public v0.1 release, frozen schemas, reusable CI, conformance artifacts, and completion evidence tied to an exact source revision.

## 7. Required Funding & Breakdown

**Total requested: $1,000 USD, paid under the Spark Program's standard mechanism.**

The amount remains at the standard $1,000 level, but revision 0.3 reallocates every paid work package to work that remains after the independently completed, pre-funding feasibility implementation. The working runner, current secp showcase, Linux CI, annotated current manifest, checked report example, and initial external-project probes are valued at **$0 from this grant**. They demonstrate feasibility but will not be billed again.

| Remaining work package | Amount | Acceptance evidence |
| --- | ---: | --- |
| v0.1 manifest/report schemas, compatibility rules, and conformance fixtures | $250 | Published machine-readable schemas; versioned valid/invalid and migration fixtures |
| Missing assertion vocabulary and field-level failure diffs | $300 | Cycles, script-filtered Cell/data/capacity, CKB, and UDT/xUDT balance matrix |
| CLI commands, installable package, root dogfood, and tagged release | $200 | `validate`/`run`/`digest`/`check-digest`; clean-checkout release verification |
| Reusable CI and explicit platform support boundary | $100 | Pinned evidence-preserving workflow; Ubuntu result and documented macOS/Windows status |
| External-pilot outreach or demand validation, upstream-fit feedback, demo, and completion report | $150 | Public maintainer feedback; consented pilot or demand/no-go report; exact-revision final evidence |
| **Total remaining request** | **$1,000** | |

No budget is allocated to hosting or a web UI. Bun's package tooling, GitHub, and GitHub Actions are sufficient for v0.1; any paid CI overage is borne by the maintainer.

**Payout:** 100% CKB to the applicant-provided CKB mainnet address.

```text
ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq0xz88g9vckq3vp47c4nakj2g7ugslm2acl45l9r
```

The address checksum, `ckb` mainnet prefix, and canonical round trip were validated with `@ckb-ccc/core` 1.18.2 on 2026-08-09. No private key or signing credential is stored in this repository.

## 8. Deliverables + How to Verify

### A. Remaining funded deliverables

1. **Frozen `verify.toml` v0.1 contract**
   - normative document and compatibility policy;
   - machine-readable parsed-TOML schema;
   - versioned valid/invalid manifests plus report/digest fixtures.

2. **Installable Bun-based `ckb-verify` CLI**
   - `validate`, `run`, `digest`, and `check-digest`;
   - the remaining cycle, Cell, CKB, and UDT/xUDT balance assertions;
   - field-level terminal diffs and schema-backed JSON evidence.

3. **Release and CI package**
   - pinned, evidence-preserving reusable workflow with no production secrets;
   - repository-root dogfood manifest and clean-checkout harness;
   - explicit Ubuntu, macOS, and Windows support statements backed by execution rather than assumption.

4. **External pilot and upstream-fit result**
   - public OffCKB maintainer feedback;
   - one consented project trial and resulting integration changes, or a transparent demand/no-go report;
   - no adoption or endorsement claim without the maintainer's own agreement.

5. **Completion evidence**
   - v0.1 reference, security, migration, and integration documentation;
   - short demo, exact-revision release verification log, and Spark completion/budget report.

The existing runner, secp showcase, checked report, annotated current manifest, Linux CI, and unmerged independent project probes are pre-funding evidence and are not part of these paid deliverables.

### B. Independent verification

The current technical preview can already be checked on Ubuntu 24.04 with:

```bash
git clone https://github.com/Akane-CN/spark-verify.git
cd spark-verify
bun install --frozen-lockfile
bun run check
bun run showcase:secp-transfer
```

That command is evidence for the narrow implemented subset only. It is not the promised v0.1 release verification surface.

At completion, a clean Ubuntu 24.04 host—and macOS only if Week 4 establishes support—will run the exact Bun version pinned by the repository:

```bash
git clone https://github.com/Akane-CN/spark-verify.git
cd spark-verify
bun install --frozen-lockfile
bun run build
bun run verify:release
```

`bun run verify:release` must:

1. validate the included manifests;
2. run the repository-root `verify.toml` with the locally built CLI;
3. run the positive example and exit `0` with `verdict: "PASS"`;
4. run an intentionally failing claim and exit `1` with a field-level expected/observed diff;
5. run a script-rejection example and identify the expected script group/error code;
6. run the clean positive case twice and show equal outcome digests and environment fingerprints;
7. demonstrate that a tool-version mismatch hard-fails by default and, when explicitly allowed, changes the environment fingerprint and taints replay qualification;
8. demonstrate a cross-environment case where equal outcomes do not falsely imply equal environments;
9. recompute both report hashes successfully.

A reviewer can verify the public release without line-by-line code review. The root manifest is dogfooding, not independent proof; security-sensitive adoption still requires normal code review and must not rely on the report alone.

Expected machine-readable fields include exact versions, repository revision/dirty state, OS/architecture, genesis hash, deployment binary hashes, step transaction/status/cycles, every assertion's expected and observed values, pass/fail, outcome digest, environment fingerprint, declared replay dependencies, replay status, and scoped reasons.

Target reviewer time after the first tool download: **15 minutes or less**. Release-candidate and pilot verification will measure this estimate and replace it with real timing rather than preserve an unsupported claim.

## 9. Current State vs. Funded Work

### Completed independently before funding

- project proposal, draft `verify.toml` vocabulary, public identity repository, and ecosystem/overlap review;
- the merged [`0.0.1` feasibility runner and secp showcase](https://github.com/Akane-CN/spark-verify/pull/5):
  - strict parsing of the implemented subset;
  - fresh pinned OffCKB lifecycle and cleanup;
  - runner-owned submission of one signed transaction per step;
  - committed and genuine script-rejected outcomes;
  - numeric script-error matching and exact live-output Cell counts;
  - structured `ckb-verify-report/1` evidence;
  - independently recomputed outcome/environment digests;
  - repeated clean-run agreement and Ubuntu CI;
- the [line-by-line current manifest guide](annotated-manifest.md) and [checked fresh-devnet report example](evidence-report.md);
- independently prepared, unmerged technical probes for [NervDAO](https://github.com/Akane-CN/spark-verify/pull/6), [CKB-UGMP](https://github.com/Akane-CN/spark-verify/pull/7), and [SoMo](https://github.com/Akane-CN/spark-verify/pull/8).

The three external-project PRs are public-code feasibility probes. They are not maintainer-approved adoption, do not satisfy the funded pilot gate, and are not billable work under this revision.

### Not completed

- no frozen v0.1 manifest/report schemas or compatibility fixtures;
- no cycle comparator, script-filtered Cell/data/capacity, CKB balance, or UDT/xUDT balance implementation;
- no `validate`, `digest`, or `check-digest` CLI command;
- no installable package, tagged release, reusable action, root dogfood manifest, or release harness;
- no verified macOS support statement;
- no public OffCKB upstream-fit feedback or consented external maintainer pilot;
- no final demo, release verification log, Spark completion report, or budget report.

### Spark-funded delta

The requested funding applies only to the remaining work in Sections 6–8. Completed feasibility implementation, documentation, reports, and independent project probes remain available as evidence at no cost to the grant. No retroactive development time is included.

If the external-pilot or upstream-fit gate fails, the honest deliverable is a public demand/no-go result and a reduced integration scope—not fabricated adoption. Any unspent allocation will be reported rather than silently moved to unrelated features.

## 10. CKB Alignment

Spark Verify is CKB-specific at its core:

- transactions consume and create Cells, and assertions select live Cells by lock/type scripts or prior output;
- native balance is Cell capacity in shannons/CKB;
- token balance uses CKB UDT/xUDT-compatible Cell data and type scripts;
- negative tests identify CKB lock/type script groups and numeric script error codes;
- cycle bounds use CKB-VM execution evidence;
- setup resolves Type ID deployments and OffCKB built-in scripts;
- the runner verifies a local CKB genesis fingerprint and uses CCC-compatible transactions.

Removing CKB would remove the assertion model, error model, asset model, and execution kernel—not merely rename an RPC endpoint.

The contribution also fits Spark's verification constraint directly: it reduces the manual cost of checking future CKB deliverables while preserving a clear boundary between executable claims and actual security review.

## 11. Maintenance and Governance

- MIT license from the first commit.
- Specification changes use issues/RFC pull requests and semantic versions.
- v0.1 report/schema fixtures remain in CI for compatibility.
- Critical breakage caused by a supported OffCKB/CKB release will receive a documented triage response for at least 90 days after completion.
- Upstream incompatibilities and unmaintained status will be stated plainly in the README; no indefinite compatibility promise is made for a $1,000 prototype.

## 12. Application Status and Remaining Gates

The application was submitted before implementation in the dedicated Spark Program category on Nervos Talk. Revision 0.3 records the later independently completed, pre-funding feasibility work instead of preserving the obsolete submission-day state.

Administrative requirements:

- [x] public applicant-owned GitHub repository;
- [x] applicant, maintainer, and contact disclosed ([#4](https://github.com/Akane-CN/spark-verify/issues/4));
- [x] CKB mainnet payout address disclosed and syntactically validated;
- [x] current implementation and remaining funded work separated explicitly;
- [x] completed pre-funding work assigned no grant budget.

Pre-funding technical evidence:

- [x] committed and genuine script-rejected transactions, debugger cycles, an intentional assertion failure, and repeated clean outcome/environment identities ([PR #5](https://github.com/Akane-CN/spark-verify/pull/5)); [issue #1](https://github.com/Akane-CN/spark-verify/issues/1) remains open for its additional drift/taint and complete provenance criteria;
- [x] a named completed-project candidate selected and technically probed without claiming consent or adoption ([CKB-UGMP PR #7](https://github.com/Akane-CN/spark-verify/pull/7), [#3](https://github.com/Akane-CN/spark-verify/issues/3));
- [x] current manifest and report formats explained with checked executable evidence ([manifest guide](annotated-manifest.md), [report guide](evidence-report.md)).

Remaining funded gates:

- [ ] freeze the v0.1 schemas, complete the remaining [#1 provenance/taint criteria](https://github.com/Akane-CN/spark-verify/issues/1), and finish the bounded assertion/CLI release surface;
- [ ] obtain public OffCKB maintainer feedback on overlap and package placement ([#2](https://github.com/Akane-CN/spark-verify/issues/2));
- [ ] obtain explicit project-maintainer consent for an external trial, or publish a demand/no-go result ([#3](https://github.com/Akane-CN/spark-verify/issues/3));
- [ ] publish the tagged release, exact-revision verification log, demo, completion report, and budget report.

Failure of a funded gate narrows the corresponding scope and is reported publicly. It is not converted into evidence that the runner, integration, or adoption succeeded.
