# Spec 0.2.0 vocabulary

Spec `0.2.0` is everything the frozen [`0.1.0` vocabulary](vocabulary-v0.1.md) accepts, plus the parts of the proposal's target v0.1 that `0.1.0` lacks:

- repository scripts the runner deploys, and named references to them;
- pure steps;
- zero steps and zero accounts;
- `expect.error.group`.

It writes `ckb-verify-report/4` with `outcome/4`, `environment/5`, and `provenance/4` ([version policy](version-policy.md)). `0.1.0` manifests keep their grammar and tuple; set `spec = "0.2.0"` to use anything on this page. The decision is [release decisions, 2026-11-03](release-decisions.md#2026-11-03-decisions-2-3-and-4-reopened-the-rest-of-the-proposals-target-v01-ships-as-spec-020). A complete worked example is the [repository-script showcase](../showcases/repository-script/README.md).

## Setup scripts

```toml
[setup]
accounts = 2                 # 0..20; at most 19 when a binary is deployed

[setup.scripts.witness_lock] # name: lowercase letters, digits, underscore; up to 16 scripts
binary = "build/witness_lock"
hash_type = "type"           # type (Type ID), data, data1, or data2

[setup.scripts.signer_lock]
builtin = "secp256k1_blake160_sighash_all"   # an alias of an OffCKB system script
```

**Before the devnet starts**, every `binary` is resolved inside the repository (symlinks included) and read. The file must be a regular file of 1–512000 bytes. It must also contain a byte above `0x7f`, because OffCKB 0.4.13 refuses or silently skips anything else. The bytes are hashed. A missing or unsuitable binary ends the run with no verdict.

**After the devnet starts**, the runner first checks that the genesis is the pinned default devnet's. It then deploys each binary in declaration order with `offckb deploy`, adding `--type-id` for `"type"`. OffCKB pays from its development account 19, so a manifest that deploys can export at most 19 accounts. The runner reads each code Cell back from the node and checks the following:

| Check | Requirement |
| --- | --- |
| Data hash | equals the binary's blake2b data hash |
| Type script (`"type"` only) | is the Type ID script |
| Code hash, `"type"` | the Type ID script hash |
| Code hash, other hash types | the data hash |

Deployment is deterministic on a fresh devnet: the same binary always lands at the same out-point with the same Type ID.

Commands see the result in `CKB_VERIFY_SCRIPTS`, a JSON file `{ scripts: { <name>: { kind, codeHash, hashType, cellDeps, … } } }`.

The report records deployments in two places:

- **environment/5** (`devnet.scripts`) holds each deployment's path, size, `binarySha256`, `dataHash`, code hash, cell dep, Type ID, and the code Cell as the node returned it.
- **The outcome** (`setup.scripts`) holds the name, kind, hash type, code hash, `binarySha256`, and `dataHash`.

A different binary under the same manifest therefore changes the outcome digest.

## Named script references

Wherever `0.1.0` accepts a script reference, `0.2.0` also accepts a setup script:

| Form | Meaning |
| --- | --- |
| `lock = "witness_lock"` | the setup script's code hash and hash type, any args (a recorded wildcard) |
| `lock = { script = "witness_lock", args = "0x01" }` | exactly these args |
| `contains = { script = "witness_lock" }` | in `cell_deps`: the transaction carries the script's cell deps |

Targets that need an exact script (balance locks, UDT types) refuse the wildcard form. Unknown names are parse errors.

## Pure steps

```toml
[[step]]
name = "inspect deployment"
run = "bun run scripts/inspect.ts"   # no expect table: a pure step

[[step.assert.cell]]
lock = "witness_lock"
count = 0
```

A step without `expect` produces no transaction. It must exit 0 and must not create `CKB_VERIFY_RESULT`; doing so is an execution error with no verdict. Its immediate claims are evaluated after it exits. Out-point and `cell_deps` claims cannot target a pure step. A step with `expect` must declare `expect.tx`, as before.

## Zero steps and zero accounts

`[[step]]` may be omitted entirely and `setup.accounts` may be `0`. The manifest must still declare at least one expectation or assertion: an empty claim set is a parse error, never a vacuous PASS.

## `expect.error.group`

```toml
expect.tx = "rejected"
expect.error.code = 42
expect.error.group = { role = "lock", script = "witness_lock", args = "0x01" }
```

`role` is `"lock"` or `"type"`. The rest is one script reference:

- a setup script, with or without args;
- `builtin`, with or without args;
- an explicit `code_hash`/`hash_type`/`args`;
- `account = N` (lock only).

The expectation holds only for a **script** rejection whose recorded group has that role and a matching script. A terminal node rejection never satisfies it, just as it never satisfies `expect.error.code`.

For every script rejection the runner retains the transaction's consumed input Cells. The verifier uses them to check the rejected input's script, and to refuse a group reference that matches more than one group of the transaction; add args to name exactly one.

## Node rejections

A `send_transaction` error that is a terminal rejection of the transaction itself is recorded as `rejection = { kind = "node", rpcCode, reason }` and satisfies a bare `expect.tx = "rejected"`. The codes are from CKB 0.209's RPC:

| RPC code | Meaning |
| --- | --- |
| -301 | failed to resolve: dead or unknown inputs or deps |
| -302 | failed to verify, for a non-script reason |
| -1102, -1103 | outputs validator, ill-formed transaction |
| -1104 | minimum fee rate |
| -1108 | malformed |
| -1110 | size limit |

Pool and transport errors (pool full, duplicate, expired, RBF, invalidated, network failures) stay execution errors with no verdict.

## Environment and provenance additions

| Field | Content |
| --- | --- |
| `environment.devnet.sealing` | the node, miner, and chain-spec files' SHA-256 and their fingerprint; a difference from the pinned default taints replay as `nondefault_devnet` |
| `environment.devnet.genesisHash` | must equal the pinned default for the executed CKB release; the runner refuses and the verifier rejects anything else |
| `provenance.repository` | the `origin` remote with userinfo, query, and fragment removed; `null` for local paths |
| `provenance.lockfiles` | each of `bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock` present; none taints `lockfile_missing` |
| `provenance.runtime` | metadata digests, pins from `packageManager`, `.tool-versions`, `mise.toml`, `.nvmrc`, `.node-version`, and `<tool> --version` as the step environment sees it; no exact `packageManager` pin or a ranged pin taints `runtime_pin_missing`, a mismatch `runtime_version_drift` |

## CLI

`run --report <file>` writes the published report's bytes to `<file>` as well. `run --json` prints one object, `{ verdict, report, digests, failures }`, or `{ verdict: null, error }` with exit 2. Both work for every spec. `validate --json` shows each step's `kind` and the declared `setupScripts`.
