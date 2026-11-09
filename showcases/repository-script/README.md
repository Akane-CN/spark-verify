# Repository-script showcase (spec 0.2.0)

The proposal's worked example, run for real: the runner deploys a lock script **built from this repository** on a fresh OffCKB devnet. The manifests then create Cells under it, spend one legally, and show that an illegal spend is rejected by exactly that lock group while the original Cell stays live. Every claim is in the manifest and the report, not in the harness. The spec is [`0.2.0`](../../docs/vocabulary-v0.2.md).

## Run it

```bash
bun install --frozen-lockfile
bun run showcase:repository-script
```

The first run may download the pinned CKB `0.209.0` and ckb-debugger `1.1.1`. CI runs the same harness in the `repository-script` job and publishes the reports as a downloadable evidence bundle.

## The lock script

[`build/witness_lock`](build/witness_lock) is a 308-byte RISC-V ELF assembled by [`lock/build.ts`](lock/build.ts) from a 47-instruction listing, with no external toolchain. Run `bun run showcases/repository-script/lock/build.ts --check` to rebuild it byte for byte. The script accepts a spend when witness 0 of its group starts with the first byte of its args, and exits 42 otherwise; [`lock/README.md`](lock/README.md) has the details. [`build/witness_lock_variant`](build/witness_lock_variant) differs only in its mismatch exit code (43); it is the "different binary" in the variant case.

Every manifest deploys `witness_lock` twice, once as `hash_type = "type"` (a Type ID deployment) and once as `"data1"`. Commands read the deployments from `CKB_VERIFY_SCRIPTS`; [`produce.ts`](produce.ts) builds the transactions and never submits them.

## Cases

| Manifest | Expected | What it shows |
| --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | `PASS`, exit 0 | deployment of both hash types, a builtin alias, a **pure step** with a wildcard named-lock claim and a balance claim, creation under `{ script = "witness_lock", args = "0x01" }`, a legal spend with a cycles bound and `cell_deps contains { script }`, final out-point claims |
| [`verify.rejected.toml`](verify.rejected.toml) | `PASS`, exit 0 | the wrong witness is rejected with `expect.error.code = 42` **and** `expect.error.group = { role = "lock", script = "witness_lock", args = "0x01" }`; the original Cell stays live |
| [`verify.wrong-group.toml`](verify.wrong-group.toml) | `FAIL`, exit 1 | same rejection and code, group pinned to `witness_lock_v1`: the group, not the code, decides |
| [`verify.node-rejected.toml`](verify.node-rejected.toml) | `PASS`, exit 0 | re-spending a consumed Cell is a terminal node rejection (RPC -301), which satisfies a bare `expect.tx = "rejected"` |
| [`verify.node-rejected-code.toml`](verify.node-rejected-code.toml) | `FAIL`, exit 1 | a node rejection cannot satisfy `expect.error.code` |
| [`verify.pure-writes-result.toml`](verify.pure-writes-result.toml) | no verdict, exit 2 | a pure step that writes `CKB_VERIFY_RESULT` is refused |
| [`verify.zero.toml`](verify.zero.toml) | `PASS`, exit 0 | zero accounts and zero steps: a `data2` deployment and one final claim |
| committed again | `PASS` | both digests repeat exactly on a second fresh devnet |
| variant (temporary manifest) | `PASS` | the same manifest text with `witness_lock_variant`: the outcome digest changes, through the setup scripts' hashes only |
| missing binary (temporary manifest) | no verdict, exit 2 | refused before any devnet starts |

[`verify.sh`](verify.sh) also checks each case's evidence. Every report re-verifies offline and matches the published schema. Its replay is `stable` and its sealing configuration is the pinned default. A script rejection retains the consumed input Cell. The harness also checks that development accounts are removed and the devnet ports are free after every case.

This showcase is repository-owned test material. It does not involve or represent any external project.
