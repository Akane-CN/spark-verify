# Cell-property claims: `0.1.0-draft.4`

The private `0.0.2` runner accepts this exact new manifest spec alongside legacy `0.1.0-draft.3`. This page describes the implemented bounded grammar, not the broader historical RFC. The [generic DAO fixture](../showcases/cell-properties/README.md) is repository-owned, not NervDAO adoption.

`PASS` means exactly: **All declared claims passed in the recorded environment.**

## Complete positive manifest

The following is the literal [committed fixture](../showcases/cell-properties/verify.committed.toml). Its producer creates eight zero data bytes; the declared predicate intentionally requires only a minimum of one byte.

```toml
[meta]
name = "cell-properties-dao"
spec = "0.1.0-draft.4"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "deposit"
run = "bun run showcases/cell-properties/produce.ts dao"
timeout = "60s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "deposit", index = 0 }
count = 1
type = { builtin = "dao", args_bytes = 0 }
data = { min_bytes = 1 }

[[step.assert.cell_deps]]
step = "deposit"
contains = { builtin = "dao" }
```

## Predicates and bounds

| Field | Meaning and restrictions |
| --- | --- |
| `out_point` | Exactly `{ step, index }`; this or an earlier step, output index `0..4294967295` (u32). |
| `count` | Exactly integer `0` or `1` in draft.4. A property predicate requires `count = 1`. Legacy draft.3 count behavior is unchanged. |
| `type` | Exactly `{ builtin, args_bytes }`. Builtin is `dao` or `spore`; the fresh OffCKB code hash **and** hash type must match. `args_bytes` is the decoded byte length in `0..1048576`, not the args content. |
| `data` | Exactly `{ min_bytes }`, decoded length at least `1..1048576`. No exact-content or protocol decoder is implied. |
| `cell_deps` | Separate array of assertions, each exactly `{ step, contains }`. `contains` is a **table** `{ builtin = "dao" }` or `{ builtin = "spore" }`, never an array. Every exported concrete dependency member must occur in the referenced signed transaction. |

`1048576` is `MAX_BYTES`, a runner resource policy, not a CKB consensus limit. Unknown keys fail closed. No raw script pins, custom aliases, script-filter queries, balance/UDT predicates, capacity predicates, generic plugins, or extra deployment framework are added. Builtin identity is resolved from the fresh canonical OffCKB context; it is not a second hardcoded deployment map.

Immediate claims use one observation per phase/step/index; final claims resample. All claims are conjunctive and kept in declaration order, including repeated predicates and failures. An absent output fails even `count = 0`, without querying a nonexistent out-point. An in-range `dead`/`unknown` response can satisfy count zero; it does not prove that the output ever existed. Malformed responses are execution errors, not assertion mismatches. Extra distinct transaction dependencies are allowed; duplicate concrete deps or empty referenced bindings are invalid.

Type presence, args/data length, and CellDep membership do **not** establish DAO, Spore or DOB protocol semantics, authenticate a deployment, or prove that the VM executed a script. In particular, an output lock is installed, and an unused dependency might never execute. Membership alone does not imply commitment; the fixture separately declares `expect.tx = "committed"`.

## Expected fixture matrix, not execution results

The [showcase README](../showcases/cell-properties/README.md) lists all six manifests and their exact expected predicates. The wrapper runs the positive case twice on independently fresh devnets. Wrong-type, wrong-data and wrong-args keep the same valid DAO producer. Missing-dep uses an ordinary **plain** transfer, asserts only count one plus DAO membership, and never strips a required dep from a DAO transaction. Ordinary-cell uses plain mode with the full positive DAO conjunction.

All cases expect commitment. Assertion failures need no debugger pin. Unexpected script rejection without a supported pin remains `NO_VERDICT`, not a passing negative fixture. A real creation failure blocks acceptance; no alternate SDK, script, or simulated native outcome substitutes for it.

## Versioned evidence and verification

| Manifest | Report | Outcome | Environment | Provenance |
| --- | --- | --- | --- | --- |
| `0.1.0-draft.4` | `ckb-verify-report/2` | `ckb-verify-outcome/2` | `/3` | `/2` |
| `0.1.0-draft.3` | `ckb-verify-report/1` | `ckb-verify-outcome/1` | `/3` | `/2` |
| Historical draft.3, explicit legacy opt-in | `/1` | `/1` | `/2` | `/1` |

Producer envelope protocol remains **1**. Report `/2` retains exact manifest text, full signed transactions including witnesses, and raw Cell-query inputs. The runtime rederives the normalized observations, truth, verdict and canonical digests. A valid `FAIL` report must verify too. Same-length content changes can preserve the outcome; matching type observations normalize to the claimed builtin, while mismatches retain raw code hash/hash type. Dynamic deployment/genesis changes remain in the environment, never scrubbed to force equality.

Use `verifyReport(artifact)` for **every complete saved report**. It requires an explicit supported top-level schema and the exact tuple; mixed/unknown versions are refused. `verifyEvidenceDigests(components)` is only the legacy v1 component helper and alone permits a missing top-level schema. Historical environment/provenance `/2` + `/1` requires `{ allowLegacy: true }`; legacy opt-in never extends report `/2`. Keep old report/RFC/grant bytes unchanged; do not convert a legacy report in place or invent missing raw evidence.

These source APIs establish **internal consistency**, not authenticity, signature validity, block inclusion/finality, authentic RPC observations or a proof of execution. They are not a new public verification CLI or a full deep report schema (#18 remains separate). The documentation validator checks selected shapes and bounds, not the runtime's semantic closure. See [report anatomy](evidence-report.md).

## Safety and acceptance status

Run only trusted code in a disposable environment without unrelated credentials. Development accounts are mode-0600 ephemeral files removed by runner cleanup. The producer signs and atomically writes the runner-selected result; only the runner submits. A loopback URL is not network isolation; OffCKB's wildcard proxy needs an external protection boundary.

Raw signed evidence may be sensitive. The known-key scanner detects selected exported development keys, **not arbitrary credentials**. Do not redact and rehash a hash-bound report for publication. A scan or cleanup failure prevents publication of pending/canonical reports. Genesis is observed, not independently allowlisted.

This Phase B fixture/docs/CI implementation has offline tests only. Native fresh-devnet, clean-checkpoint repeatability, legacy lifecycle regression, independent reviews and parent acceptance remain required. No new real DAO report is bundled, no public release or maintainer adoption is claimed, and hosted artifact publication/download verification remains separate #19 work.
