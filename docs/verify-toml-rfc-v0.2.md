# `verify.toml` Schema & Assertion Vocabulary (RFC draft 0.2)

> **Status:** pre-implementation RFC for community feedback. Nothing in this document is stable or implemented yet. The first release must publish a machine-readable schema and conformance fixtures matching the final text.
>
> **Versioning:** this is document revision **0.2** for the intended `verify.toml` **v0.1** release. Draft manifests select `spec = "0.1.0-draft.3"`; draft.3 supersedes the briefly published draft.2 because the canonical transaction key and required replay declaration changed. The manifest-spec, outcome-claims, report-schema, and installed-runner versions are separate values.
>
> **Changes from draft 0.1:** the runner-owned result-file contract is retained; the uploaded `expect.tx` vocabulary is canonical; immediate state checks use `[[step.assert.*]]`; result identity is split into an outcome digest and an environment fingerprint; `[replay].dependencies` makes replay qualification authorable; pure-step/result semantics are explicit; zero-match Cell behavior remains explicit; and the report/replay semantics distinguish a hash from a reproducibility claim.

## Design goals

1. **Declarative:** authors state observable CKB outcomes, not a manual review procedure.
2. **Re-runnable:** a manifest, repository revision, declared inputs, and pinned toolchain can be compared across runs.
3. **Small vocabulary:** step `tx`/cycles/error checks plus `cell` and `balance` assertions cover the MVP; unusual checks remain repository code.
4. **CKB-native:** script groups, Cells, capacity, UDT amounts, and transaction rejection semantics are explicit.
5. **Thin:** OffCKB owns the devnet and deployment lifecycle; project code/CCC owns transaction construction; the node and ckb-debugger own execution results.
6. **Honest:** arbitrary project commands are trusted code, and separate outcome/environment hashes are evidence—not a security proof or proof of determinism.

## 0. Trust and scope

A manifest can execute `run` commands from the repository. The MVP does **not** promise a security sandbox. Run it only for repositories you trust, in an environment with no production credentials or wallets. A GitHub Action must not expose secrets to a workflow that executes untrusted pull-request code.

The runner hard-fails unless the CKB RPC endpoint is loopback and its genesis fingerprint matches the freshly created OffCKB devnet. The MVP never targets testnet or mainnet and never accepts production private keys. The account file contains public, deterministic OffCKB development keys and must be labelled accordingly.

## 1. Document structure

A `verify.toml` contains:

| Section | Cardinality | Purpose |
| --- | ---: | --- |
| `[meta]` | exactly one | Run identity and specification version |
| `[toolchain]` | exactly one | Exact external tool versions |
| `[replay]` | exactly one | Author-declared replay dependencies |
| `[setup]` | exactly one | Development accounts and script references |
| `[[step]]` | zero or more, ordered | Commands, transaction expectations, and immediate state assertions |
| `[[assert.cell]]` / `[[assert.balance]]` | zero or more | Final-state assertions |

Evaluation order is `validate → setup → each step's command/expectations/assertions in order → final assertions → report`.

A run passes only when setup succeeds, every step expectation and immediate assertion succeeds, and every final assertion succeeds. Schema/configuration errors and execution errors are not assertion failures; they are “no verdict” errors. A full manifest must contain at least one step expectation, immediate assertion, or final assertion; an empty claim set is a schema error rather than a vacuous pass.

Unknown keys are errors in v0.1. This catches typos and makes a digest's semantics unambiguous.

Canonical normalized paths are `[meta]`, `[toolchain]`, `[replay]`, `[setup]`, `[setup.scripts.<name>]`, `[[step]]`, `[step.expect]`, `[[step.assert.cell]]`, `[[step.assert.balance]]`, `[[assert.cell]]`, and `[[assert.balance]]`. TOML dotted keys such as `expect.tx = "committed"` and explicit tables such as `[step.expect]` are syntax-equivalent; a parser must normalize them to the same model.

## 2. Metadata, toolchain, and replay declaration

```toml
[meta]
name = "sample-lock-basic"       # required, unique within the repository
spec = "0.1.0-draft.3"           # required manifest specification version
description = "2-of-3 spend"     # optional

[toolchain]
ckb = "0.209.0"                  # exact, no ranges
offckb = "0.4.11"                # exact, no ranges
ckb-debugger = "1.1.1"           # exact, no ranges

[replay]
dependencies = []                 # explicit author declaration; required
```

`spec` selects manifest semantics. It is not the installed CLI version. The report records both.

All toolchain fields are exact versions. `--allow-version-drift` permits a run but marks it tainted and records every expected/observed mismatch. The runner must not silently choose “latest.”

The project's own command runtime and dependencies remain repository-controlled. A stable run requires exact runtime metadata (for example `mise.toml`, `.tool-versions`, or an equivalent tool pin), an exact package-manager declaration, and a committed lockfile. The report records the requested and observed runtime/package-manager versions plus relevant metadata and lockfile hashes. CCC and other library versions are taken from the resolved lockfile. Missing or ranged runtime pins taint the run. Spark Verify's own implementation and examples use an exact Bun version and `bun.lock`; target repositories may declare another pinned runtime. A future spec may promote more of these fields into `[toolchain]` if the feasibility spike shows that repository pins are insufficient.

`[replay]` makes the author's nondeterminism declaration part of the manifest instead of relying on out-of-schema input. `dependencies` is a required array containing zero or more unique values from `external_time`, `randomness`, `fee_estimation`, `dynamic_since`, and `external_network`. An empty array explicitly declares that the author knows of no such dependency. Any listed dependency makes `replay.status` tainted with an outcome-scoped reason. The declaration is an attestation, not something the runner can prove complete; §6.4 defines the resulting qualification.

## 3. Setup

```toml
[setup]
accounts = 3

[setup.scripts.sample_lock]
binary = "build/sample_lock"
hash_type = "type"

[setup.scripts.always_success]
binary = "build/always_success"
hash_type = "data1"

[setup.scripts.spore]
builtin = "spore"
```

### 3.1 Accounts

`accounts` is an integer in `0..20`. The runner exports the first N deterministic, pre-funded OffCKB devnet accounts.

Assertions can refer to them as `account = 0`, `account = 1`, and so on. This is preferred to copying network-specific addresses into a manifest.

### 3.2 Repository binaries

Each `[setup.scripts.<name>]` must define exactly one of `binary` or `builtin`.

For `binary`:

- paths are relative to the repository root;
- the file must exist before setup starts;
- the runner hashes its bytes before deployment;
- `hash_type` is one of `"type"`, `"data"`, `"data1"`, or `"data2"`;
- `"type"` deploys the code Cell with a Type ID and resolves the script reference from that Type ID; other modes use the binary data hash and the declared hash type.

The report records `binary_sha256`, `code_hash`, `hash_type`, deployment out-point, and Type ID where applicable.

### 3.3 OffCKB built-ins

`builtin = "spore"` resolves a named OffCKB system script without redeploying it. The set of allowed names is versioned by Spark Verify's OffCKB adapter, and the resolved script plus code-dep out-points are recorded. An unknown built-in is a setup error.

This capability is necessary for real applications built on xUDT, Spore, OmniLock, or other OffCKB-provided scripts.

Seeded arbitrary genesis Cells are out of scope for v0.1.

## 4. Steps

```toml
[[step]]
name = "2-of-3 spend"
run = "bun run scripts/build-spend.ts"
timeout = "60s"                         # optional; default 60s
expect.tx = "committed"
expect.cycles.lt = 5_000_000

[[step.assert.cell]]
out_point = { step = "2-of-3 spend", index = 0 }
lock = { script = "sample_lock", args = "0x0102" }
count = 1
```

Step names are required and unique. A step runs once, from the repository root, with a clean environment allowlist plus the variables below.

### 4.1 Command protocol

The runner injects:

- `CKB_RPC_URL` — a loopback, read-only RPC facade used for command queries; the runner rejects write methods such as `send_transaction` on this endpoint;
- `SPARK_VERIFY_ACCOUNTS` — path to a JSON array of deterministic devnet `{ address, lock, privkey }` records;
- `SPARK_VERIFY_DEPLOYMENTS` — path to the resolved script map;
- `SPARK_VERIFY_CONTEXT` — path to JSON containing spec/run IDs, genesis hash, current tip, and paths above;
- `SPARK_VERIFY_RESULT` — a fresh path at which a transaction-producing command must write its result atomically.

A transaction-producing command writes exactly one JSON object:

```json
{
  "protocol": 1,
  "transaction": { "version": "0x0", "cell_deps": [], "header_deps": [], "inputs": [], "outputs": [], "outputs_data": [], "witnesses": [] }
}
```

`transaction` is a signed CKB JSON-RPC transaction. The runner validates it, computes its hash, submits it through OffCKB's proxy, and retains the transaction even if the node rejects it.

A step is transaction-producing when it declares `expect.tx`; that declaration requires exactly one valid result object. `expect.cycles` and `expect.error` also require `expect.tx`. A pure step declares none of those keys, exits successfully without creating `SPARK_VERIFY_RESULT`, and may still have immediate state assertions.

Rules:

- stdout/stderr are logs only;
- bare-hash and “last line” parsing are intentionally unsupported;
- v0.1 supports at most one transaction per step;
- commands must not submit the transaction themselves;
- malformed or multiply-written result data is an execution error;
- a missing result is an execution error for a transaction-producing step, while creating a result is an execution error for a declared pure step;
- a non-zero command exit is an execution error unless a future spec defines command-exit expectations.

Runner-owned submission avoids the ambiguous case where a rejected transaction never receives a queryable hash.

### 4.2 Transaction expectations

| Key | Values | Meaning |
| --- | --- | --- |
| `expect.tx` | `"committed"` / `"rejected"` | Node outcome for this step's transaction |
| `expect.cycles.{lt,lte,eq,gte}` | non-negative integer | Total verification cycles |
| `expect.error.code` | signed integer | Script error code for a rejected transaction |
| `expect.error.group` | script-group reference | Exact lock/type group responsible for rejection |

`expect.error.*` requires `expect.tx = "rejected"`. Cycle and error comparators are mutually exclusive per field unless the schema explicitly permits a range (`gte` plus `lte`).

`rejected` means the runner obtained a terminal node rejection for an otherwise parseable signed transaction. A malformed result envelope, invalid transaction JSON, command failure, submission timeout, or transaction that is accepted and then never reaches a terminal state is an execution error with no verdict—not a successful `rejected` expectation. The MVP distinguishes only a rejection with normalized script evidence (`kind = "script"`) from another terminal node rejection (`kind = "node"`); only script evidence can satisfy `expect.error.code` or `expect.error.group`. A bare `tx = "rejected"` expectation asserts only that some terminal rejection occurred. A security-negative test should pin the script group and, when stable for that script, the error code. Free-form node messages are evidence but are excluded from the outcome digest.

A script-group reference includes a role and script reference:

```toml
expect.error.group = { role = "lock", script = "sample_lock", args = "0x0102" }
```

`role` is `"lock"` or `"type"`. If several groups still match, the expectation is invalid until the author supplies args or a group index.

### 4.3 Immediate state assertions

`[[step.assert.cell]]` and `[[step.assert.balance]]` use the same syntax as final assertions. They run after a submitted transaction reaches its terminal status, or immediately after a declared pure step exits successfully. A rejected transaction does not advance chain state, but immediate assertions may verify that prior Cells remain live. This keeps transaction expectations under `step.expect` and state assertions under `step.assert`.

## 5. Assertions

### 5.1 `cell`

A Cell assertion selects live Cells by a specific prior output or by scripts, then checks cardinality and properties.

```toml
[[assert.cell]]
out_point = { step = "create protected cell", index = 0 }
lock = { script = "sample_lock", args = "0x0102" }
count = 1
data.eq = "0x0102"
data.len = 2
capacity.gte = "1000 CKB"
```

Selectors:

- `out_point = { step = "<unique step name>", index = <output index> }`; or
- at least one of `lock` and `type`.

`out_point` may be combined with `lock`/`type` to assert the exact output and its scripts. Script-only filters query all matching live Cells.

Checks:

- `count = N` is exact cardinality shorthand;
- `count.eq`, `count.gte`, and `count.lte` may express constraints;
- `data.eq` is exact lowercase `0x`-prefixed bytes after normalization;
- `data.len` is byte length;
- `capacity.{eq,gte,lte}` compares shannons exactly.

At least one `count`, `data`, or `capacity` check is required. Property checks apply to every selected Cell.

**No vacuous success:** per-Cell property checks always impose an effective `count.gte = 1`. If no count constraint is written, the runner adds that lower bound during normalization; an explicit count constraint may narrow it but cannot make zero matches sufficient. To assert absence, write `count = 0` or `count.eq = 0`. Either zero form is incompatible with per-Cell property checks.

### 5.2 `balance`

A balance assertion chooses exactly one target:

```toml
[[assert.balance]]
account = 1
gte = "999 CKB"

[[assert.balance]]
lock = { code_hash = "0x0000000000000000000000000000000000000000000000000000000000000000", hash_type = "type", args = "0x0102" }
udt = { type = { script = "xudt", args = "0x0102" } }
gte = "1000"
```

Targets are `account`, `address`, or `lock`. Exactly one is required.

Without `udt`, the runner sums live-Cell capacity for the target lock. With `udt`, it selects Cells with the given type script and sums token amounts. v0.1 token decoding is a 16-byte little-endian unsigned integer at the start of Cell data; malformed or shorter data is an assertion error, not zero. This covers standard UDT amounts and xUDT's amount prefix while avoiding a claim that arbitrary token layouts are understood.

A balance comparison is an aggregate, not a per-Cell property assertion. Zero matching Cells contribute zero, so `eq = "0 CKB"` may pass without a live Cell. Use a separate `cell` assertion when at least one Cell must exist. The no-vacuous-success rule in §5.1 applies only to per-Cell property checks.

Quantities are strings:

- CKB: `"1000 CKB"` (up to eight fractional decimal places);
- shannons: `"100000000000 shannon"`;
- token base units: `"1000"`.

Floating point is never used. Bare TOML integers are rejected for asset amounts because UDT values may exceed signed 64-bit and JavaScript-safe ranges.

### 5.3 Script references

A script-valued field accepts a fully explicit script:

```toml
lock = { code_hash = "0x0000000000000000000000000000000000000000000000000000000000000000", hash_type = "type", args = "0x0102" }
```

It can instead use a named setup script with exact args:

```toml
lock = { script = "sample_lock", args = "0x0102" }
```

Or it can use a named setup script with wildcard args:

```toml
lock = "sample_lock"
```

A bare name or `{ script = "name" }` resolves `code_hash` and `hash_type` and treats omitted args as a wildcard. This wildcard behavior must be visible in the report. It does not mean empty args.

Explicit hashes are normalized and validated as 32 bytes. `hash_type` accepts `type`, `data`, `data1`, or `data2`.

### 5.4 Comparator validation

- `eq` cannot coexist with another comparator for the same value.
- `gte` and `lte` may coexist to define a closed range.
- `lt` is supported for cycles only in v0.1; capacity and balances use `eq/gte/lte` to keep quantity syntax small.
- A lower bound greater than an upper bound is a schema error.

## 6. Reproducibility: outcome and environment

Spark Verify emits two independently verifiable hashes. This distinguishes **agreement on declared CKB outcomes** from **identity of the environment that produced them**. Neither hash is a signature, an audit, or proof that arbitrary repository code is deterministic.

Both hashes use SHA-256 over separate objects serialized with the [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785). Each object carries its own schema identifier, and the conformance suite includes canonicalization fixtures.

### 6.1 Recorded evidence

The report records at minimum:

- manifest bytes hash, normalized claim-definition hash, and selected spec version;
- runner version;
- Git commit, sanitized repository identity, and dirty-state digest; URL credentials and userinfo are never recorded;
- requested and observed runtime, package-manager, CKB, OffCKB, and ckb-debugger versions;
- relevant package-manager lockfile hashes;
- OS and architecture;
- devnet genesis hash and sealing-configuration fingerprint;
- deployed binary hashes and resolved script/code-dep references;
- per-step transaction hash, status, cycles, error evidence, and output references;
- every expectation/assertion's normalized target, comparator, expected value, observed value, and outcome;
- the manifest's declared replay dependencies, replay status, and structured reasons.

### 6.2 Outcome digest

`outcome_digest` is SHA-256 over the versioned `outcome_claims` object. It includes:

- the manifest's `meta.name`, manifest-spec version, and outcome-claims schema version;
- normalized expectation and assertion definitions, including comparators and expected values;
- each referenced script's resolved `code_hash`/`hash_type`, plus the binary hash for every repository-deployed artifact;
- ordered step names, committed/rejected status, cycles, and normalized rejection `kind`, plus `{ role, script, args, code }` when script evidence is present;
- symbolic output targets such as `{ step, index }`; and
- each assertion's normalized target, expected value, observed value, and pass/fail result.

Raw transaction hashes, deployment transaction hashes, timestamps, durations, absolute paths, log locations, and environment-only provenance are recorded elsewhere but excluded from `outcome_claims`. A prior-output target remains the stable symbolic `{ step, index }` reference in the digest; the report separately records its resolved out-point and observed Cell.

Equal outcome digests mean that the two reports agree on the declared claim definitions, relevant deployed artifacts, and normalized observations. They do **not** prove that the environments were identical, that undeclared side effects were absent, or that the manifest was complete.

### 6.3 Environment fingerprint

`environment_fingerprint` is SHA-256 over the versioned `environment` object. It includes:

- requested and observed tool/runtime/package-manager versions;
- lockfile hashes;
- Git commit, dirty/input-state digest, and sanitized repository identity;
- manifest bytes hash;
- OS and architecture; and
- genesis and sealing-configuration fingerprints.

Equal environment fingerprints mean that the recorded reproducibility inputs agree. A different environment fingerprint is provenance information, not automatically an outcome disagreement. A strict replay comparison checks both hashes; a cross-environment conformance comparison may intentionally compare only `outcome_digest` while still displaying the environment difference.

### 6.4 Replay qualification

The report contains:

```json
{
  "replay": {
    "declared_dependencies": [],
    "status": "stable",
    "reasons": []
  }
}
```

`stable` requires an explicit empty `[replay].dependencies` declaration, exact tool/runtime pins, a clean identifiable repository, and the default fresh-devnet configuration. Otherwise the status is `tainted` and `reasons` contains `{ "scope": "environment" | "outcome", "code": "…", "detail": "…" }` entries. Because `[replay]` is required, a missing declaration is a schema error and produces no verification verdict rather than an implicitly stable report.

Examples of environment-scoped reasons are `version_drift`, `dirty_git`, and `nondefault_devnet`. Each author-declared dependency becomes an outcome-scoped reason using its manifest value as the code, including `external_time`, `randomness`, `fee_estimation`, `dynamic_since`, or `external_network`. The hashes are still computed for a tainted run; the status prevents a hash from being misrepresented as evidence of clean replayability.

The runner must not claim it can detect all nondeterminism in arbitrary project code. Authors are responsible for making the declaration complete, and `stable` means only “stable under recorded inputs and the author's declaration,” not that the runner proved the command deterministic. CI should deny external network access where practical.

Hex values are lowercase and `0x`-prefixed before canonicalization. Integers that may exceed JSON's interoperable range are decimal strings.

## 7. Report and CLI

Abbreviated illustrative report shape; an actual report includes every field required by §6.1:

```json
{
  "schema": "spark-verify-report/0.1-draft.3",
  "name": "sample-lock-basic",
  "versions": {
    "spec": "0.1.0-draft.3",
    "runner": "0.1.0",
    "ckb": "0.209.0",
    "offckb": "0.4.11",
    "ckb_debugger": "1.1.1"
  },
  "evidence": {
    "transactions": [
      { "step": "2-of-3 spend", "tx_hash": "0x…" }
    ]
  },
  "outcome_claims": {
    "schema": "spark-verify-outcome-claims/2",
    "spec": "0.1.0-draft.3",
    "deployments": [],
    "steps": [
      {
        "name": "2-of-3 spend",
        "status": "committed",
        "cycles": 4231889,
        "expectations": [
          { "kind": "tx", "ok": true, "expected": "committed", "observed": "committed" },
          { "kind": "cycles.lt", "ok": true, "expected": 5000000, "observed": 4231889 }
        ]
      }
    ],
    "assertions": [
      { "kind": "cell", "ok": true, "expected": { "count": 1 }, "observed": { "count": 1 } }
    ]
  },
  "environment": {
    "schema": "spark-verify-environment/1",
    "git_commit": "…",
    "git_dirty": false,
    "manifest_sha256": "sha256:…",
    "genesis_hash": "0x…"
  },
  "pass": true,
  "digests": {
    "outcome": "sha256:…",
    "environment": "sha256:…"
  },
  "replay": {
    "declared_dependencies": [],
    "status": "stable",
    "reasons": []
  }
}
```

Proposed CLI:

```text
spark-verify run [path]
  --report <file>
  --json
  --allow-version-drift

spark-verify validate [path]
spark-verify digest <report.json> [--kind outcome|environment]
spark-verify check-digest <report.json> --kind <outcome|environment> <sha256:...>
```

Without `--kind`, `digest` recomputes and prints both hashes. `check-digest` recomputes the selected embedded object, verifies the stored value, and then compares it with the supplied hash.

Exit codes:

- `0`: all declared claims passed;
- `1`: one or more expectations/assertions were evaluated and failed;
- `2`: invalid manifest, setup error, command failure, timeout, unavailable tooling, or any other condition that prevented a verdict.

The MVP emits JSON and a terminal summary. HTML output is deliberately deferred.

## 8. Validation and conformance

The v0.1 release is incomplete without:

1. a machine-readable schema for parsed TOML;
2. valid and invalid manifest fixtures, including unknown-key rejection;
3. outcome/environment canonicalization and digest fixtures;
4. one committed-transaction fixture;
5. one rejected-script fixture with group and code evidence;
6. one non-script terminal node-rejection fixture that can satisfy only bare `tx = "rejected"`;
7. a pure-step fixture whose immediate assertion runs without result data;
8. result-contract fixtures for a transaction step with no result and a pure step that writes one;
9. zero-match/vacuous-success regression fixtures;
10. quantity overflow and UDT decoding fixtures;
11. replay fixtures for a missing declaration, an explicit empty declaration, and each declared dependency;
12. two consecutive clean runs that produce the same outcome digest and environment fingerprint;
13. a version-drift fixture whose environment fingerprint changes and whose replay status taints or hard-fails as specified;
14. a cross-environment fixture showing that equal outcome digests do not imply equal environment fingerprints.

Error messages must include the manifest path, key path, and observed value where safe.

## 9. Open questions

1. **Standalone or upstream:** should the runner be a thin package, an OffCKB subcommand/plugin, or only a format plus conformance suite?
2. **Result protocol:** is a signed JSON-RPC transaction sufficient for CCC users, or should v0.1 also accept a Molecule-serialized transaction file?
3. **Multiple transactions:** should a step remain exactly one transaction, with authors splitting flows into multiple steps?
4. **Built-ins:** is `builtin = "spore"` stable enough, or should references use exported OffCKB script metadata directly?
5. **Output references:** is `{ step, index }` enough, or are named outputs needed immediately?
6. **Token decoding:** should v0.1 name only `udt16le` rather than using the broader `udt` label?
7. **Execution isolation:** can the GitHub Action provide a practical no-secrets, network-restricted container without making the MVP too large?
8. **Adoption:** which completed Spark project should be the real conformance example?

Declarative transaction construction, arbitrary genesis Cells, testnet/mainnet execution, property-based generation, and include files are deferred beyond v0.1.

## 10. Worked examples

### 10.1 Positive: create and spend a protected Cell

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
run = "bun run scripts/build-create.ts"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "create protected cell", index = 0 }
lock = { script = "sample_lock", args = "0x0102" }
count = 1

[[step]]
name = "2-of-3 spend"
run = "bun run scripts/build-spend.ts"
expect.tx = "committed"
expect.cycles.lt = 5_000_000

[[assert.cell]]
out_point = { step = "create protected cell", index = 0 }
count = 0

[[assert.balance]]
account = 1
gte = "999 CKB"
```

The immediate assertion checks the created output. The final out-point assertion then proves that the exact output—not merely every Cell sharing a code hash—was consumed.

### 10.2 Negative: an unauthorized spend must fail

```toml
[meta]
name = "sample-lock-unauthorized"
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
run = "bun run scripts/build-create.ts"
expect.tx = "committed"

[[step]]
name = "one signer attempts 2-of-3 spend"
run = "bun run scripts/build-unauthorized.ts"
expect.tx = "rejected"
expect.error.code = -101
expect.error.group = { role = "lock", script = "sample_lock", args = "0x0102" }

[[assert.cell]]
out_point = { step = "create protected cell", index = 0 }
count = 1
```

The final assertion proves that the rejected transaction did not consume the original output. The result protocol retains the rejected transaction even when the node never accepts it into the pool.
