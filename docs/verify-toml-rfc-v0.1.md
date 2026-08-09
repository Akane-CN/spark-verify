# `verify.toml` Schema & Assertion Vocabulary (v0.1 draft)

> **Status:** pre-implementation RFC for community feedback. Nothing in this document is stable or implemented yet. The first release must publish a machine-readable schema and conformance fixtures matching the final text.

## Design goals

1. **Declarative:** authors state observable CKB outcomes, not a manual review procedure.
2. **Re-runnable:** a manifest, repository revision, declared inputs, and pinned toolchain can be compared across runs.
3. **Small vocabulary:** step status/cycles/error checks plus `cell` and `balance` assertions cover the MVP; unusual checks remain repository code.
4. **CKB-native:** script groups, Cells, capacity, UDT amounts, and transaction rejection semantics are explicit.
5. **Thin:** OffCKB owns the devnet and deployment lifecycle; project code/CCC owns transaction construction; the node and ckb-debugger own execution results.
6. **Honest:** arbitrary project commands are trusted code, and an outcome digest is evidence about declared claims—not a security proof.

## 0. Trust and scope

A manifest can execute `run` commands from the repository. Spark Verify v0.1 does **not** promise a security sandbox. Run it only for repositories you trust, in an environment with no production credentials or wallets. A GitHub Action must not expose secrets to a workflow that executes untrusted pull-request code.

The runner hard-fails unless the CKB RPC endpoint is loopback and its genesis fingerprint matches the freshly created OffCKB devnet. v0.1 never targets testnet or mainnet and never accepts production private keys. The account file contains public, deterministic OffCKB development keys and must be labelled accordingly.

## 1. Document structure

A `verify.toml` contains:

| Section | Cardinality | Purpose |
|---|---:|---|
| `[meta]` | exactly one | Run identity and specification version |
| `[toolchain]` | exactly one | Exact external tool versions |
| `[setup]` | exactly one | Development accounts and script references |
| `[[step]]` | zero or more, ordered | Commands and immediate expectations |
| `[[assert.cell]]` / `[[assert.balance]]` | zero or more | Final-state assertions |

Evaluation order is `validate → setup → steps in order → final assertions → report`.

A run passes only when setup succeeds, every step expectation succeeds, and every final assertion succeeds. Schema/configuration errors and execution errors are not assertion failures; they are “no verdict” errors.

Unknown keys are errors in v0.1. This catches typos and makes a digest's semantics unambiguous.

## 2. Metadata and toolchain

```toml
[meta]
name = "quorum-cell-basic"       # required, unique within the repository
spec = "0.1.0-draft"             # required manifest specification version
description = "2-of-3 spend"     # optional

[toolchain]
ckb = "0.209.0"                  # exact, no ranges
offckb = "0.4.11"                # exact, no ranges
ckb-debugger = "1.1.1"           # exact, no ranges
```

`spec` selects manifest semantics. It is not the installed CLI version. The report records both.

All toolchain fields are exact versions. `--allow-version-drift` permits a run but marks it tainted and records every expected/observed mismatch. The runner must not silently choose “latest.”

The project's own command runtime and dependencies remain repository-controlled. A stable run requires exact runtime metadata (for example `.node-version` or an equivalent tool pin), an exact package-manager declaration, and a committed lockfile. The report records the requested and observed runtime/package-manager versions plus relevant metadata and lockfile hashes. CCC and other library versions are taken from the resolved lockfile. Missing or ranged runtime pins taint the run. A future spec may promote more of these fields into `[toolchain]` if the feasibility spike shows that repository pins are insufficient.

## 3. Setup

```toml
[setup]
accounts = 3

[setup.scripts.quorum_lock]
binary = "build/quorum_lock"
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
run = "pnpm tsx scripts/build-spend.ts"
timeout = "60s"                         # optional; default 60s
expect.status = "committed"
expect.cycles.lt = 5_000_000

[[step.expect.cell]]
out_point = { step = "2-of-3 spend", index = 0 }
lock = { script = "quorum_lock", args = "0x…" }
count = 1
```

Step names are required and unique. A step runs once, from the repository root, with a clean environment allowlist plus the variables below.

### 4.1 Command protocol

The runner injects:

- `CKB_RPC_URL` — loopback OffCKB proxy RPC used for read-only queries by the command;
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

A pure command exits successfully without creating `SPARK_VERIFY_RESULT`. It cannot declare transaction-only expectations.

Rules:

- stdout/stderr are logs only;
- bare-hash and “last line” parsing are intentionally unsupported;
- v0.1 supports at most one transaction per step;
- commands must not submit the transaction themselves;
- malformed, missing, or multiply-written result data is an execution error;
- a non-zero command exit is an execution error unless a future spec defines command-exit expectations.

Runner-owned submission avoids the ambiguous case where a rejected transaction never receives a queryable hash.

### 4.2 Transaction expectations

| Key | Values | Meaning |
|---|---|---|
| `expect.status` | `"committed"` / `"rejected"` | Node outcome for this step's transaction |
| `expect.cycles.{lt,lte,eq,gte}` | non-negative integer | Total verification cycles |
| `expect.error.code` | signed integer | Script error code for a rejected transaction |
| `expect.error.group` | script-group reference | Exact lock/type group responsible for rejection |

`expect.error.*` requires `expect.status = "rejected"`. Cycle and error comparators are mutually exclusive per field unless the schema explicitly permits a range (`gte` plus `lte`).

A script-group reference includes a role and script reference:

```toml
expect.error.group = { role = "lock", script = "quorum_lock", args = "0x…" }
```

`role` is `"lock"` or `"type"`. If several groups still match, the expectation is invalid until the author supplies args or a group index.

### 4.3 Inline state expectations

`[[step.expect.cell]]` and `[[step.expect.balance]]` use the same syntax as final assertions and run after the step reaches its terminal status. A rejected step does not advance chain state, but inline assertions may verify that prior Cells remain live.

## 5. Assertions

### 5.1 `cell`

A Cell assertion selects live Cells by a specific prior output or by scripts, then checks cardinality and properties.

```toml
[[assert.cell]]
out_point = { step = "create protected cell", index = 0 }
lock = { script = "quorum_lock", args = "0x…" }
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

Property checks apply to every selected Cell.

**No vacuous success:** when a Cell assertion has property checks but no explicit `count` constraint, the implicit cardinality is `count.gte = 1`. To assert absence, write `count = 0` explicitly. `count = 0` cannot be combined with per-Cell property checks.

### 5.2 `balance`

A balance assertion chooses exactly one target:

```toml
[[assert.balance]]
account = 1
gte = "999 CKB"

[[assert.balance]]
lock = { code_hash = "0x…", hash_type = "type", args = "0x…" }
udt = { type = { script = "xudt", args = "0x…" } }
gte = "1000"
```

Targets are `account`, `address`, or `lock`. Exactly one is required.

Without `udt`, the runner sums live-Cell capacity for the target lock. With `udt`, it selects Cells with the given type script and sums token amounts. v0.1 token decoding is a 16-byte little-endian unsigned integer at the start of Cell data; malformed or shorter data is an assertion error, not zero. This covers standard UDT amounts and xUDT's amount prefix while avoiding a claim that arbitrary token layouts are understood.

Quantities are strings:

- CKB: `"1000 CKB"` (up to eight fractional decimal places);
- shannons: `"100000000000 shannon"`;
- token base units: `"1000"`.

Floating point is never used. Bare TOML integers are rejected for asset amounts because UDT values may exceed signed 64-bit and JavaScript-safe ranges.

### 5.3 Script references

A script-valued field accepts a fully explicit script:

```toml
lock = { code_hash = "0x…", hash_type = "type", args = "0x…" }
```

It can instead use a named setup script with exact args:

```toml
lock = { script = "quorum_lock", args = "0x…" }
```

Or it can use a named setup script with wildcard args:

```toml
lock = "quorum_lock"
```

A bare name or `{ script = "name" }` resolves `code_hash` and `hash_type` and treats omitted args as a wildcard. This wildcard behavior must be visible in the report. It does not mean empty args.

Explicit hashes are normalized and validated as 32 bytes. `hash_type` accepts `type`, `data`, `data1`, or `data2`.

### 5.4 Comparator validation

- `eq` cannot coexist with another comparator for the same value.
- `gte` and `lte` may coexist to define a closed range.
- `lt` is supported for cycles only in v0.1; capacity and balances use `eq/gte/lte` to keep quantity syntax small.
- A lower bound greater than an upper bound is a schema error.

## 6. Reproducibility and digest contract

Spark Verify produces a **comparable claims digest**, not a proof that an arbitrary command was deterministic.

### 6.1 Recorded provenance

The report records at minimum:

- manifest bytes hash and selected spec version;
- runner version;
- Git commit, repository remote, and dirty-state digest;
- relevant package-manager lockfile hashes;
- requested and observed CKB, OffCKB, and ckb-debugger versions;
- devnet genesis hash and sealing configuration fingerprint;
- deployed binary hashes and resolved script/code-dep references;
- per-step transaction hash, status, cycles, error evidence, and output references;
- every assertion's normalized target, comparator, observed value, and outcome;
- taint reasons.

A clean Git revision is required for `digest_status = "stable"`. Dirty repositories can run but are tainted and include a hash of the diff/untracked inputs that the runner can identify.

### 6.2 Canonicalization

The digest is SHA-256 over a documented `claims` object serialized with [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785). The conformance suite includes canonicalization fixtures.

The claims object includes provenance that changes semantics (manifest, repository revision/input hashes, tool versions, genesis, binary hashes) and observed claims. It excludes display-only timestamps, durations, absolute paths, and log locations.

Hex values are lowercase and `0x`-prefixed before canonicalization. Integers that may exceed JSON's interoperable range are decimal strings.

### 6.3 Taint

Known reasons include:

- allowed tool-version drift;
- dirty or unidentifiable repository inputs;
- user-declared external network/time dependence;
- an unsupported platform/tool fingerprint;
- use of a non-default devnet configuration.

The report includes `taint_reasons: [{ code, detail }]`. The runner must not claim it can detect all nondeterminism in arbitrary project code. Authors are responsible for declaring external time, randomness, fee estimation, and network dependencies; the security guide recommends denying external network access in CI where practical.

## 7. Report and CLI

Illustrative report shape:

```json
{
  "schema": "spark-verify-report/0.1",
  "name": "quorum-cell-basic",
  "versions": {
    "spec": "0.1.0-draft",
    "runner": "0.1.0",
    "ckb": "0.209.0",
    "offckb": "0.4.11",
    "ckb_debugger": "1.1.1"
  },
  "provenance": {
    "git_commit": "…",
    "git_dirty": false,
    "manifest_sha256": "…",
    "genesis_hash": "0x…"
  },
  "steps": [
    {
      "name": "2-of-3 spend",
      "tx": "0x…",
      "status": "committed",
      "cycles": 4231889,
      "expectations": [{ "kind": "cycles.lt", "ok": true, "expected": 5000000, "observed": 4231889 }]
    }
  ],
  "assertions": [
    { "kind": "cell", "ok": true, "observed": { "count": 1 } }
  ],
  "pass": true,
  "claims": {},
  "digest": "sha256:…",
  "digest_status": "stable",
  "taint_reasons": []
}
```

Proposed CLI:

```text
spark-verify run [path]
  --report <file>
  --json
  --allow-version-drift

spark-verify validate [path]
spark-verify digest <report.json>
spark-verify check-digest <report.json> <sha256:...>
```

`digest` recomputes the digest from the embedded claims object and fails if it differs from the report's stored digest. `check-digest` performs the same verification and then compares it with the supplied hash.

Exit codes:

- `0`: all declared claims passed;
- `1`: one or more expectations/assertions were evaluated and failed;
- `2`: invalid manifest, setup error, command failure, timeout, unavailable tooling, or any other condition that prevented a verdict.

The MVP emits JSON and a terminal summary. HTML output is deliberately deferred.

## 8. Validation and conformance

The v0.1 release is incomplete without:

1. a machine-readable schema for parsed TOML;
2. valid and invalid manifest fixtures;
3. canonicalization/digest fixtures;
4. one committed-transaction fixture;
5. one rejected-script fixture with group and code evidence;
6. zero-match/vacuous-success regression fixtures;
7. quantity overflow and UDT decoding fixtures;
8. two consecutive clean runs that produce the same stable digest;
9. a version-drift fixture that taints or hard-fails as specified.

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

## 10. Worked negative case

```toml
[meta]
name = "quorum-cell-unauthorized"
spec = "0.1.0-draft"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.11"
ckb-debugger = "1.1.1"

[setup]
accounts = 3

[setup.scripts.quorum_lock]
binary = "build/quorum_lock"
hash_type = "type"

[[step]]
name = "create protected cell"
run = "pnpm tsx scripts/build-create.ts"
expect.status = "committed"

[[step]]
name = "one signer attempts 2-of-3 spend"
run = "pnpm tsx scripts/build-unauthorized.ts"
expect.status = "rejected"
expect.error.code = -101
expect.error.group = { role = "lock", script = "quorum_lock", args = "0x…" }

[[assert.cell]]
out_point = { step = "create protected cell", index = 0 }
count = 1
```

The final assertion proves that the rejected transaction did not consume the original output. The result protocol retains the rejected transaction even when the node never accepts it into the pool.
