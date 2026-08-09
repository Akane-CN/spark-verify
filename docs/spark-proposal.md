# Spark Program | Spark Verify — Executable Acceptance Claims for CKB Projects

> **Application status: draft, not yet submitted.** This document follows the current Spark proposal structure. The repository is pre-implementation and the readiness gates in [`design-review.md`](design-review.md) must be closed before posting to Nervos Talk.

## 1. Project Overview

**Project name:** Spark Verify

**One-sentence summary:** A CKB-specific `verify.toml` format and thin runner that execute a project's declared devnet transaction flows, check observable Cell/balance/script outcomes, and emit a comparable evidence report.

**Project type:** Developer tool / manifest specification / npm CLI

Spark Verify turns a free-form “How to Verify” section into an executable artifact. A project author declares the CKB toolchain pins, setup scripts, transaction-building steps, and expected on-chain outcomes. A reviewer runs one command against a local OffCKB devnet and receives a pass/fail report with transaction status, cycles, script errors, final Cell/balance observations, provenance, and a digest.

It does not infer whether a project is correct and does not replace security review. It verifies only the claims the author chose to declare.

## 2. Team Profile

**Project lead and maintainer:** Akane

- GitHub: [Akane-CN](https://github.com/Akane-CN)
- Nervos Talk: [Akane](https://talk.nervos.org/u/Akane)
- Operator: Random Walk Co., Ltd., Japan
- Role: specification, TypeScript implementation, OffCKB/CCC integration, conformance tests, examples, and documentation

Relevant public CKB work:

- [Fiber Link](https://github.com/Keith-CY/fiber-link) — CKB Fiber-based community payments project; Akane has participated in its public technical and acceptance work.
- [QuorumCell](https://github.com/Akane-CN/quorum-cell) — a public CKB Cell-model design exploration. It is currently design-only, not an implemented script, and is listed as evidence of domain research rather than a shipped contract.

**Required before submission:** add the accountable human operator/applicant name, Discord handle, email, and payout entity/wallet. The Spark committee's current identity and contact requirements should not be satisfied with invented or agent-only details.

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
4. runs each project command to build one signed transaction;
5. submits the transaction itself so committed and rejected cases are both retained;
6. records status, script group/error code, and cycles;
7. queries final live Cells and balances;
8. evaluates the declared claims; and
9. writes JSON plus a human-readable summary and provenance-aware digest.

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
   - step status/cycles/error expectations;
   - live Cell/out-point queries;
   - Cell and balance comparators;
   - explicit zero-match semantics.

4. **Evidence and CLI**
   - JSON report and terminal diff;
   - Git/toolchain/genesis/binary provenance;
   - RFC 8785 canonical claims and SHA-256 digest;
   - GitHub Action wrapper.

### Key technical risks

- **Rejected transactions:** a command that submits its own invalid transaction may never receive a queryable hash. v0.1 therefore requires the command to return a signed transaction and lets the runner submit it.
- **False reproducibility:** pinning only CKB is insufficient. Reports also record OffCKB/ckb-debugger versions, repository revision/dirty state, lockfile hashes, genesis fingerprint, and deployed binary hashes.
- **Arbitrary code execution:** `run` is trusted repository code. The first release includes an explicit security guide and a no-secrets CI example.
- **Tool overlap:** the implementation remains an orchestration layer. Milestone 1 includes public OffCKB maintainer feedback on whether it should remain standalone or expose an upstream adapter.
- **No adopter:** a real completed Spark example must be named and confirmed before this application is submitted.

## 6. Execution Plan (6 weeks)

### Week 1 — Feasibility gate and RFC closure

- publish the revised RFC and issue-based feedback checklist;
- build a throwaway vertical slice that starts/stops OffCKB;
- capture one committed and one script-rejected transaction through runner-owned submission;
- record cycles and one final Cell assertion;
- run the slice twice and publish whether the digest inputs are stable;
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
- implement RFC 8785 canonicalization and digest/check commands;
- add stable, tainted, dirty-tree, and version-drift fixtures.

**Milestone:** two clean runs produce the same stable claims digest; a drifted run is visibly tainted.

### Week 5 — CI wrapper and real-project example

- publish a pinned GitHub Action example with no production secrets;
- adapt one named completed Spark project to the manifest;
- test on Ubuntu and macOS;
- document unsupported Windows behavior rather than claiming it works.

**Milestone:** real-project example is independently rerunnable from a clean checkout.

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
| Assertion engine + failure diffs | $250 | Status/error/cycles/cell/balance test matrix |
| Report, provenance, digest + GitHub Action | $150 | Stable/tainted fixtures and passing workflow |
| Real example, release docs, demo, final report | $100 | Clean-checkout verification and public release |
| **Total** | **$1,000** | |

No budget is allocated to hosting or a web UI. npm, GitHub, and GitHub Actions are sufficient for the MVP; any paid CI overage is borne by the maintainer.

**Payout selection:** the accountable applicant must choose CKB, USDT, or USDC and add the wallet address plus network before submission. No payout address is published in this draft.

## 8. Deliverables + How to Verify

### A. Deliverables

1. **`verify.toml` v0.1 specification**
   - normative document;
   - machine-readable parsed-TOML schema;
   - valid/invalid manifests and digest fixtures.

2. **`spark-verify` npm CLI**
   - `validate`, `run`, `digest`, and `check-digest`;
   - status/cycles/script-error, Cell, and balance assertions;
   - JSON report and terminal summary.

3. **GitHub Action example**
   - exact CLI/tool pins;
   - no production secrets;
   - documented warning for untrusted pull requests.

4. **Examples**
   - one toy positive/negative CKB script flow;
   - one named, completed Spark project adapted end to end.

5. **Documentation and completion evidence**
   - author guide, command protocol, security model, known limits, release verification log, short demo, and Spark completion/budget report.

### B. Independent verification

From a clean Ubuntu 24.04 or supported macOS host with Node.js 22, Git, and normal download access:

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
2. run the positive example and exit `0` with `pass: true`;
3. run an intentionally failing claim and exit `1` with a field-level expected/observed diff;
4. run a script-rejection example and identify the expected script group/error code;
5. run the clean positive case twice and show equal stable digests;
6. demonstrate that a tool-version mismatch hard-fails by default and is tainted when explicitly allowed;
7. recompute each report digest successfully.

A reviewer can verify the public release without line-by-line code review. Security-sensitive adoption still requires normal code review and must not rely on the report alone.

Expected machine-readable fields include the exact versions, repository revision/dirty state, genesis hash, deployment binary hashes, step transaction/status/cycles, every assertion's expected and observed values, pass/fail, digest status, and taint reasons.

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
- no proof that two runs are digest-stable;
- no GitHub Action;
- no confirmed real-project adopter/example.

### Spark-funded delta

The funded work is precisely the six-week implementation and evidence package in Sections 6 and 8. Existing documents are inputs, not claimed as future paid deliverables. If the Week 1 feasibility gate fails, the honest deliverable is the documented result and a scope decision—not fabricated success output.

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

## 12. Submission Readiness

This application should be posted only after all four are true:

- [ ] accountable human applicant/contact and payout details are added ([#4](https://github.com/Akane-CN/spark-verify/issues/4));
- [ ] a two-run feasibility slice exists with real output ([#1](https://github.com/Akane-CN/spark-verify/issues/1));
- [ ] one completed Spark project/adopter is named and agrees to the example ([#3](https://github.com/Akane-CN/spark-verify/issues/3));
- [ ] OffCKB maintainer feedback on overlap/integration is linked ([#2](https://github.com/Akane-CN/spark-verify/issues/2)).

Until then, this repository is an RFC and budget draft, not evidence that the proposed runner already works.
