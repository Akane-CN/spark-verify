# Spark Verify

**Executable acceptance claims for CKB projects.**

> **Status: pre-implementation RFC.** There is no released CLI package yet. The manifest and report formats are drafts and may change in response to community and OffCKB maintainer feedback.

Spark Verify proposes a small `verify.toml` format and a runner that turns a CKB project's “How to Verify” section into a repeatable local-devnet check. A project declares the transaction it wants to exercise and the observable on-chain claims that should hold. The runner uses the existing CKB stack—[OffCKB](https://github.com/ckb-devrel/offckb), [CCC](https://github.com/ckb-devrel/ccc), and [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger)—and emits a structured report with a comparable outcome digest, a separate environment fingerprint, and explicit replay qualification.

Spark Verify is **not** a substitute for code review, an audit, or a proof that a manifest lists every important property. It checks the claims that the author actually declared.

## The gap

The CKB toolchain already handles the hard lower layers:

- **OffCKB** starts a local devnet, provides deterministic development accounts, deploys scripts, and records failed transactions.
- **CCC** builds and signs CKB transactions.
- **ckb-debugger** executes script groups and reports cycles and error codes.
- **ckb-testtool** supports unit tests for individual CKB scripts.

What is still mostly project-specific is the acceptance layer: start the environment, run a real flow, identify the transaction, query final Cells and balances, compare the observations with the project's claims, and package the evidence in one report. Spark Verify is deliberately limited to that layer.

## Proposed workflow

```text
verify.toml + trusted repository
            │
            ▼
  pinned OffCKB devnet
            │
            ▼
 project step builds a signed transaction
            │
            ▼
 runner submits it and records status/errors/cycles
            │
            ▼
 final Cell and balance assertions
            │
            ▼
 report.json + outcome/environment hashes
```

Illustrative manifest:

```toml
[meta]
name = "sample-lock-basic"
spec = "0.1.0-draft.3"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.11"
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
run = "bun run scripts/create.ts"
expect.tx = "committed"
expect.cycles.lt = 5_000_000

[[step.assert.cell]]
out_point = { step = "create protected cell", index = 0 }
lock = { script = "sample_lock", args = "0x0102" }
count = 1

[[assert.balance]]
account = 1
gte = "999 CKB"
```

A transaction-producing command writes one signed CKB JSON-RPC transaction to the file named by `SPARK_VERIFY_RESULT`. The runner—not the command—submits it. This lets the runner observe both successful and rejected submissions consistently. Arbitrary stdout is treated as logs, never as a transaction protocol.

The required `[replay].dependencies` array makes known time, randomness, fee-estimation, dynamic-`since`, or external-network dependencies explicit. An empty array is an author attestation, not proof that the runner detected every source of nondeterminism.

See the full [`verify.toml` RFC draft 0.2](docs/verify-toml-rfc-v0.2.md).

## Repository map

- [`docs/verify-toml-rfc-v0.2.md`](docs/verify-toml-rfc-v0.2.md) — current draft manifest, assertion, report, and digest semantics
- [`docs/spark-proposal.md`](docs/spark-proposal.md) — full Spark Program application and budget
- [Nervos Talk application topic](https://talk.nervos.org/t/spark-program-spark-verify-reproducible-acceptance-checks-for-ckb-projects/10598) — submitted community proposal
- [`docs/design-review.md`](docs/design-review.md) — review findings, decisions, and funded go/no-go gates
- [`scripts/validate-docs.sh`](scripts/validate-docs.sh) — validator regression, embedded TOML/JSON, link, and secret-pattern checks
- [`SECURITY.md`](SECURITY.md) — command-execution and CI trust boundary
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to review field names and assertion coverage

## Design principles

1. **CKB-specific, not a generic test DSL.** Cell filters, script groups, capacity, UDT amounts, cycles, and CKB error codes are first-class.
2. **Thin orchestration.** Existing tools remain responsible for devnet, transaction construction, deployment, and script execution.
3. **Runner-owned submission.** Negative tests must retain the rejected transaction and node/debugger evidence.
4. **No vacuous success.** A Cell property assertion always requires at least one match; an exact-zero absence assertion cannot include per-Cell properties.
5. **Two comparable identities.** The outcome digest covers declared claims and observations; the environment fingerprint covers Git, toolchain, runtime, lockfiles, OS/architecture, and devnet provenance.
6. **Honest trust model.** `run` executes repository code. v0.1 is for trusted repositories and must not be run with production secrets.

## What feedback is most useful

- Can `cell`, `balance`, and step-level `tx`/cycles/error checks express a real CKB deliverable you maintain?
- Is runner-owned transaction submission practical for CCC-based repositories?
- Should OffCKB built-in scripts use a dedicated `builtin = "…"` reference or a generic deployment-source model?
- Is output targeting by `{ step, index }` sufficient for v0.1?
- Which completed Spark project would be the best real conformance example?
- Should this remain a standalone thin CLI, become an OffCKB subcommand/plugin, or define only the format and conformance suite?

Please open an issue with a concrete transaction flow or a manifest that cannot express it.

## Grant status

The repository contains a pre-implementation funding application **draft**, not a submitted or approved grant. Applicant/contact/payment details are disclosed in the proposal. The application intentionally requests the implementation budget before a runner exists.

If funding is approved, these issues become Week 1 go/no-go gates:

- [#1 — committed/rejected transaction feasibility and two-hash replay](https://github.com/Akane-CN/spark-verify/issues/1)
- [#2 — OffCKB package boundary and built-in script references](https://github.com/Akane-CN/spark-verify/issues/2)
- [#3 — confirmed completed-Spark-project example](https://github.com/Akane-CN/spark-verify/issues/3)

Administrative applicant/contact/payout readiness is recorded in [#4](https://github.com/Akane-CN/spark-verify/issues/4). None of the open funded gates is presented as completed implementation evidence.

## License

[MIT](LICENSE)
