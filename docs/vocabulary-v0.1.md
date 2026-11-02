# Assertion vocabulary: v0.1 (`0.1.0`, also written `0.1.0-draft.5`)

This is the vocabulary of the frozen v0.1 contract. A manifest selects it with `spec = "0.1.0"`, the release identifier, or with `spec = "0.1.0-draft.5"`, the identifier it was first published under; the grammar, the claims, and the report tuple are identical, and only the identifier recorded in the report differs. What "frozen" means and how it is checked is in the [version policy](version-policy.md#the-frozen-v01-contract). The private `0.0.2` runner also reads and writes `0.1.0-draft.3` and `0.1.0-draft.4`.

It implements the vocabulary the [proposal](spark-proposal.md#8-deliverables--how-to-verify) promised as funded deliverable 2 and the RFC describes in §4.2, §5.1, §5.2, and §5.3: cycles comparators, Cell selection by script filter with count, data, and capacity checks, CKB and UDT balance claims, and explicit, builtin, and wildcard-args script references. The repository-owned [vocabulary fixture](../showcases/vocabulary/README.md) exercises every form on a fresh devnet. Reports are `ckb-verify-report/3` with `ckb-verify-outcome/3`, `ckb-verify-environment/4`, and `ckb-verify-provenance/3`.

`PASS` means exactly: **All declared claims passed in the recorded environment.**

## Grammar

The following is the literal [committed fixture](../showcases/vocabulary/verify.committed.toml); the owner args are the hash of development account 0's lock and the address is account 1's, both deterministic on a fresh OffCKB devnet.

```toml
[meta]
name = "vocabulary-xudt-mint"
spec = "0.1.0"
description = "An owner-mode xUDT mint plus a 100 CKB transfer, checked with cycles, script-filtered Cells, properties, and balances."

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "mint"
run = "bun run showcases/vocabulary/produce.ts mint"
timeout = "60s"
expect.tx = "committed"
expect.cycles = { gte = 1, lt = 100000000 }

[[step.assert.cell]]
out_point = { step = "mint", index = 0 }
lock = { account = 0 }
type = { builtin = "xudt", args = "0x7de82d61a7eb2ec82b0dc653e558ba120efcbfbb44dac87c12972d05bf250653" }
data = { eq = "0xe8030000000000000000000000000000", len = 16 }
capacity = { eq = "150 CKB" }

[[step.assert.cell]]
out_point = { step = "mint", index = 1 }
lock = { account = 1 }
count = 1
capacity = { eq = "100 CKB" }

[[step.assert.cell_deps]]
step = "mint"
contains = { builtin = "xudt" }

[[assert.cell]]
lock = { account = 0 }
type = { builtin = "xudt" }
count = { gte = 1, lte = 10 }
data = { min_bytes = 16 }

[[assert.cell]]
lock = { builtin = "always_success", args = "0x" }
type = { builtin = "xudt" }
count = 0

[[assert.balance]]
account = 1
gte = "100 CKB"

[[assert.balance]]
address = "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqt435c3epyrupszm7khk6weq5lrlyt52lg48ucew"
gte = "100 CKB"

[[assert.balance]]
account = 0
udt = { type = { builtin = "xudt", args = "0x7de82d61a7eb2ec82b0dc653e558ba120efcbfbb44dac87c12972d05bf250653" } }
eq = "1000"
```

Forms the fixture does not use: `count = N` shorthand, `{ eq }` cycles, explicit `{ code_hash, hash_type, args }` scripts, `{ lock = … }` balance targets, and `lte` bounds; the table below is the complete grammar.

| Field | Meaning and restrictions |
| --- | --- |
| `expect.cycles` | `{ lt \| lte, gte }` or `{ eq }` on the step's verification cycles (dry run for committed, debugger for rejected). A missing cycles value never satisfies a comparator. |
| Script reference | `{ code_hash, hash_type, args }`, `{ builtin = "<name>" [, args] }` with the 19 names OffCKB 0.4.13 exports, or `{ account = N }` (lock positions only). A bare name is refused: there are no named setup scripts ([decision 2](release-decisions.md#2-repository-script-deployment-a-documented-limitation)). Omitted builtin args are a wildcard, visible in the report as `args: null`; balance targets and UDT identities require exact args. |
| `cell` selector | `out_point` (this or an earlier step; selects at most one Cell), `lock`, `type`, or combinations. Script-only selectors query every live Cell through the node indexer, paged 100 at a time, at most 1000 Cells (a runner resource policy; more is an execution error). |
| `count` | `N` or `{ eq \| gte, lte }` in `0..4294967295`. Property checks (`data`, `capacity`) impose `gte = 1`; `count = 0` with properties is refused; assert absence in a separate claim. |
| `data` | `eq` exact bytes, `len` exact byte length, `min_bytes` lower bound; combinations must agree. |
| `capacity` | shannon comparators written as `"N CKB"` (up to eight decimals) or `"N shannon"`; bare numbers are refused. |
| `balance` | one target; without `udt`, the sum of live-Cell capacity under that lock; with `udt`, the sum of the 16-byte little-endian amount at the start of each Cell's data under that lock and type. Data shorter than 16 bytes makes the observation invalid (claim fails), never zero. Zero Cells sum to zero: use a `cell` claim when at least one Cell must exist. |
| `cell_deps` | as in draft.4, for any system script name. |

Every quantity is a decimal string in the report (`"14200000000"`), never floating point; UDT amounts are bounded by 128 bits, capacities by 64.

## Evidence and verification

The report retains every raw input the runner consulted: `get_live_cell` responses for `out_point` selectors and the exact indexer pages (`search_key`, `after_cursor`, `objects`, `last_cursor`) for script-filtered selectors and balances. The exported accounts (index, address, lock) join the environment (`environment/4`) so that `account` references and addresses re-derive offline; builtins resolve through `environment.devnet.systemScripts` as before. The verifier recomputes the expected search key from each claim and the environment, checks every page object against it, dedupes out-points, and re-derives per-Cell capacity, data length, and data hash, every balance total, every `ok`, the verdict, and both digests. A tampered page, a forged search key, a stored total that contradicts the pages, an account whose address contradicts its lock, or a report that claims another version tuple is refused even after rehashing (`tests/claims-v3.test.ts`).

Observations are bounded: `cells` lists at most 1000 `{ outPoint, capacity, dataBytes, dataHash }` entries; balances record `{ cells, total, malformed }`. Internal consistency is not authenticity: the verifier cannot tell whether the node returned those pages, only that the report is consistent with them ([offline verification](offline-verification.md)).

## Tool-version drift

`run --allow-version-drift` (`0.1.0` and `0.1.0-draft.5` only) runs a manifest that requests an exact `toolchain.ckb` without a pinned archive on the pinned `0.209.0`. By default such a manifest is refused before any runtime mutation. When allowed, `environment.toolchain.requested` keeps the manifest's version, `observed` the binary's, `provenance/3` records `toolchain.ckb = { requested, observed, driftAllowed: true }`, replay is tainted with `tool_version_drift`, and the environment fingerprint differs from a non-drifted run. A report that records a difference without `driftAllowed` is inconsistent. `scripts/verify-release.sh` item 7 demonstrates both paths.

## What it does not do

No named setup-script references or repository script deployment ([decision 2](release-decisions.md#2-repository-script-deployment-a-documented-limitation)), no pure steps or `accounts = 0` ([decision 3](release-decisions.md#3-pure-steps-and-setupaccounts--0-not-in-v01)), no `expect.error.group` pin ([decision 4](release-decisions.md#4-expecterrorgroup-code-only-pinning)), no protocol decoding beyond the 16-byte UDT amount prefix, no `run --report`/`--json`. Balance claims aggregate every live Cell under a lock, including the fresh devnet's genesis Cells, so outcome digests repeat across fresh devnets only when those Cells repeat; the fixture's repeat check compares per-claim verdicts and prints both digests rather than asserting equality.
