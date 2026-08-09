# Spark Program | Spark Verify — Executable Acceptance Claims for CKB Projects

> **Application status: pre-implementation funding draft, not yet submitted.** This is proposal document revision **0.2** and accompanies the [`verify.toml` RFC draft 0.2](verify-toml-rfc-v0.2.md). It follows the current Spark proposal structure. The repository intentionally contains the RFC and proposal before implementation; the runner, feasibility evidence, and adopter integration are funded deliverables rather than prerequisites.

## 1. Project Overview

**Project name:** Spark Verify

**One-sentence summary:** A CKB-specific `verify.toml` format and thin runner that execute a project's declared devnet transaction flows, check observable Cell/balance/script outcomes, and emit a comparable evidence report.

**Project type:** Developer tool / manifest specification / npm CLI

Spark Verify turns a free-form “How to Verify” section into an executable artifact. A project author declares the CKB toolchain pins, setup scripts, transaction-building steps, and expected on-chain outcomes. A reviewer runs one command against a local OffCKB devnet and receives a pass/fail report with transaction status, cycles, script errors, final Cell/balance observations, an outcome digest, a separate environment fingerprint, and explicit replay qualification.

The deliverable is not a project-specific CI script. Its reusable asset is a small manifest specification, assertion vocabulary, result protocol, and evidence model; the runner is the implementation that makes those contracts executable over existing CKB tools.

It does not infer whether a project is correct and does not replace security review. It verifies only the claims the author chose to declare.

## 2. Team Profile

**Project lead and accountable applicant:** Akane

- GitHub: [Akane-CN](https://github.com/Akane-CN)
- Nervos Talk: [Akane](https://talk.nervos.org/u/Akane)
- Contact: [akane@random-walk.co.jp](mailto:akane@random-walk.co.jp)
- Operator: Random Walk Co., Ltd., Japan
- Role: specification, TypeScript implementation, OffCKB/CCC integration, conformance tests, examples, and documentation

Relevant public CKB work:

- [Fiber Link](https://github.com/Keith-CY/fiber-link) — CKB Fiber-based community payments project; Akane has participated in its public technical and acceptance work.
- [QuorumCell](https://github.com/Akane-CN/quorum-cell) — a public CKB Cell-model design exploration. It is currently design-only, not an implemented script, and is listed as evidence of domain research rather than a shipped contract.

The contact, operator, public GitHub identity repository, and CKB payout destination are disclosed in this draft so the committee can verify responsibility before approving funding.

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

An author adds `verify.toml` and a small transaction-builder adapter to a trusted repository. The runner:

1. validates the manifest against the versioned schema;
2. starts a fresh OffCKB devnet with exact versions;
3. exposes deterministic devnet accounts and deployed/built-in script metadata;
4. runs each project command as either a declared pure step or a transaction-producing step;
5. for a transaction-producing step, validates the signed transaction artifact and submits it itself so committed and rejected cases are both retained;
6. records status, script group/error code, and cycles;
7. queries final live Cells and balances;
8. evaluates the declared claims; and
9. writes JSON plus a human-readable summary, outcome digest, and environment fingerprint.

An abbreviated, parser-valid manifest looks like this:

```toml
[meta]
name = "quorum-cell-basic"
spec = "0.1.0-draft.3"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.11"
ckb-debugger = "1.1.1"

[replay]
dependencies = []

[setup]
accounts = 3

[setup.scripts.quorum_lock]
binary = "build/quorum_lock"
hash_type = "type"

[[step]]
name = "create protected cell"
run = "pnpm tsx scripts/build-create.ts"

[step.expect]
tx = "committed"
cycles.lt = 5_000_000

[[step.assert.cell]]
out_point = { step = "create protected cell", index = 0 }
lock = { script = "quorum_lock", args = "0x0102" }
count = 1

[[assert.balance]]
account = 1
gte = "999 CKB"
```

The MVP vocabulary is intentionally small:

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

**Language and packaging:** TypeScript, Node.js 22, pnpm, npm CLI distribution.

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
- **False reproducibility:** pinning only CKB is insufficient. Reports separate outcome agreement from environment identity, record OffCKB/ckb-debugger/runtime versions, repository revision/dirty state, lockfile hashes, OS/architecture, genesis fingerprint, and deployed binary hashes, and never treat either hash as proof of determinism. A required `[replay].dependencies` array makes the author's time/randomness/fee/`since`/network declaration part of the manifest; `stable` remains qualified by that declaration rather than presented as runner-proven determinism.
- **Arbitrary code execution:** `run` is trusted repository code. The read-only loopback RPC facade protects the runner-owned submission path; it does not sandbox filesystem, process, or arbitrary network access. The first release includes an explicit security guide and a no-secrets CI example.
- **Tool overlap:** the implementation remains an orchestration layer. Milestone 1 includes public OffCKB maintainer feedback on whether it should remain standalone or expose an upstream adapter.
- **No adopter yet:** confirming a completed Spark project for the real-project example is a funded Week 1 demand gate. If no suitable adopter agrees, the project publishes that result and reduces or stops the implementation rather than inventing adoption.

## 6. Execution Plan (6 weeks)

### Week 1 — Feasibility gate and RFC closure

- publish the revised RFC and issue-based feedback checklist;
- build a throwaway vertical slice that starts/stops OffCKB;
- capture one committed and one script-rejected transaction through runner-owned submission;
- record cycles and one final Cell assertion;
- run the slice twice and publish whether both the outcome digest and environment fingerprint are stable;
- request public feedback from OffCKB maintainers and confirm one real example/adopter.

**Milestone:** feasibility report plus a go/no-go decision. If rejected-transaction evidence or stable replay is not feasible, publish the findings and reduce/stop the implementation rather than disguising the gap.

### Weeks 2–3 — Parser, execution kernel, and assertion engine

- implement strict manifest validation and normalized internal model;
- implement pinned OffCKB lifecycle, accounts, binary/built-in script resolution, and cleanup;
- implement the result-file protocol and transaction submission/polling;
- implement status, cycles, error-group, `cell`, and `balance` checks;
- add valid/invalid and regression fixtures.

**Milestone:** positive and negative toy examples pass end to end on Linux.

### Week 4 — Report, provenance, and digest

- implement the JSON report and terminal diff;
- record Git/lockfile/toolchain/genesis/deployment provenance;
- implement RFC 8785 canonicalization, outcome/environment hashes, and digest/check commands;
- add stable, tainted, dirty-tree, and version-drift fixtures.

**Milestone:** two clean runs produce equal outcome digests and environment fingerprints; a drifted run changes the environment fingerprint and is visibly tainted even if its outcome still agrees.

### Week 5 — CI wrapper and real-project example

- publish a pinned GitHub Action example with no production secrets;
- adapt one named completed Spark project to the manifest;
- add a root `verify.toml` that dogfoods the locally built runner without claiming circular self-execution is an audit;
- test on Ubuntu and macOS;
- document unsupported Windows behavior rather than claiming it works.

**Milestone:** the real-project example and root dogfood manifest are independently rerunnable from a clean checkout.

### Week 6 — Release and verification package

- publish the npm package and tagged v0.1 specification;
- finalize schema, command, security, and integration documentation;
- record a short end-to-end demo;
- run the release verification checklist from a clean machine/runner;
- publish the Spark completion report and transparent budget report.

**Milestone:** public v0.1 release, GitHub Action, examples, conformance artifacts, and completion evidence.

## 7. Required Funding & Breakdown

**Total requested: $1,000 USD, paid under the Spark Program's standard mechanism.**

This is a pure technical-development proposal and deliberately stays at the standard $1,000 level. Although the integration spans several tools, the project reuses them rather than funding a second devnet/debugger stack. A request above $1,000 is not justified until the feasibility and adopter gates are closed.

| Work package | Amount | Acceptance evidence |
| --- | ---: | --- |
| Feasibility slice + RFC/schema/conformance design | $200 | Published report; committed/rejected flow; maintainer/adopter feedback |
| OffCKB execution adapter + result protocol | $300 | Fresh-devnet lifecycle and end-to-end fixtures |
| Assertion engine + failure diffs | $250 | `tx`/error/cycles/cell/balance test matrix |
| Report, two hashes, replay status + GitHub Action | $150 | Stable/tainted and cross-environment fixtures; passing workflow |
| Real example, dogfood manifest, release docs, demo, final report | $100 | Clean-checkout verification and public release |
| **Total** | **$1,000** | |

No budget is allocated to hosting or a web UI. npm, GitHub, and GitHub Actions are sufficient for the MVP; any paid CI overage is borne by the maintainer.

**Payout:** 100% CKB to the applicant-provided CKB mainnet address.

```text
ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq0xz88g9vckq3vp47c4nakj2g7ugslm2acl45l9r
```

The address checksum, `ckb` mainnet prefix, and canonical round trip were validated with `@ckb-ccc/core` 1.18.2 on 2026-08-09. No private key or signing credential is stored in this repository.

## 8. Deliverables + How to Verify

### A. Deliverables

1. **`verify.toml` v0.1 specification**
   - normative document;
   - machine-readable parsed-TOML schema;
   - valid/invalid manifests plus outcome/environment digest fixtures.

2. **`spark-verify` npm CLI**
   - `validate`, `run`, `digest`, and `check-digest`;
   - `tx`/cycles/script-error, Cell, and balance assertions;
   - JSON report and terminal summary.

3. **GitHub Action example**
   - exact CLI/tool pins;
   - no production secrets;
   - documented warning for untrusted pull requests.

4. **Examples**
   - one toy positive/negative CKB script flow;
   - one named, completed Spark project adapted end to end.

5. **Root dogfood manifest**
   - a repository-root `verify.toml` run by the locally built CLI;
   - exercises at least one successful pure step and one runner-owned transaction path;
   - documented as acceptance evidence, not a security audit or proof that the tool is correct.

6. **Documentation and completion evidence**
   - author guide, command protocol, security model, known limits, release verification log, short demo, and Spark completion/budget report.

### B. Independent verification

From a clean Ubuntu 24.04 or supported macOS host with Git, normal download access, the exact Node.js runtime pinned by the repository (target major: 22), and the exact package-manager version pinned by `packageManager`:

```bash
git clone https://github.com/Akane-CN/spark-verify.git
cd spark-verify
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm verify:release
```

`pnpm verify:release` must:

1. validate the included manifests;
2. run the repository-root `verify.toml` with the locally built CLI;
3. run the positive example and exit `0` with `pass: true`;
4. run an intentionally failing claim and exit `1` with a field-level expected/observed diff;
5. run a script-rejection example and identify the expected script group/error code;
6. run the clean positive case twice and show equal outcome digests and environment fingerprints;
7. demonstrate that a tool-version mismatch hard-fails by default and, when explicitly allowed, changes the environment fingerprint and taints replay qualification;
8. demonstrate a cross-environment case where equal outcomes do not falsely imply equal environments;
9. recompute both report hashes successfully.

A reviewer can verify the public release without line-by-line code review. The root manifest is dogfooding, not independent proof; security-sensitive adoption still requires normal code review and must not rely on the report alone.

Expected machine-readable fields include exact versions, repository revision/dirty state, OS/architecture, genesis hash, deployment binary hashes, step transaction/status/cycles, every assertion's expected and observed values, pass/fail, outcome digest, environment fingerprint, declared replay dependencies, replay status, and scoped reasons.

Target reviewer time after the first tool download: **15 minutes or less**. Week 1 will measure this estimate and update it with real timing rather than preserving an unsupported claim.

## 9. Current State vs. Funded Work

### Current state

Completed before funding:

- initial project proposal draft;
- initial `verify.toml` vocabulary draft;
- this public identity repository and design review;
- ecosystem/overlap review of OffCKB, CCC, ckb-debugger, and ckb-testtool.

Not completed:

- no runnable CLI or npm package;
- no machine-readable schema;
- no OffCKB lifecycle adapter;
- no committed/rejected feasibility slice;
- no proof that two runs have stable outcome and environment identities;
- no GitHub Action;
- no confirmed real-project adopter/example.

### Spark-funded delta

This application intentionally requests funding before runner implementation. The funded work is precisely the six-week implementation and evidence package in Sections 6 and 8. Existing documents are design inputs, not claimed as future paid deliverables. If the funded Week 1 feasibility or demand gate fails, the honest deliverable is the documented result and a scope/no-go decision—not fabricated success output.

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

## 12. Submission Status and Funded Gates

The application is intended for submission before implementation. The following administrative publication requirements are satisfied in this repository:

- [x] public applicant-owned GitHub repository;
- [x] accountable applicant, operator, and contact disclosed ([#4](https://github.com/Akane-CN/spark-verify/issues/4));
- [x] CKB mainnet payout address disclosed and syntactically validated;
- [x] current work separated explicitly from the requested funded work.

No working CLI, npm package, machine-readable schema, feasibility run, or adopter integration is claimed. If funding is approved, Week 1 executes these go/no-go gates:

- [ ] produce a two-run feasibility slice with real committed/rejected output ([#1](https://github.com/Akane-CN/spark-verify/issues/1));
- [ ] confirm one completed Spark project/adopter for the real example ([#3](https://github.com/Akane-CN/spark-verify/issues/3));
- [ ] obtain public OffCKB maintainer feedback on overlap/integration ([#2](https://github.com/Akane-CN/spark-verify/issues/2)).

Failure of a funded gate results in a published finding and scope/no-go decision. It is not silently converted into evidence that the proposed runner works.
