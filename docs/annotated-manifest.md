# Annotated `verify.toml`

This guide explains every line of the manifest accepted by the current unreleased `ckb-verify` feasibility runner. It follows the executable [secp transfer committed fixture](../showcases/secp-transfer/verify.committed.toml), not the broader unimplemented vocabulary in the [draft RFC](verify-toml-rfc-v0.2.md).

> **Trust boundary:** `step.run` executes repository code with the current user's permissions. Run only trusted repositories in a disposable environment without production wallets or unrelated credentials. A passing result is acceptance evidence for the declared claims, not an audit.

## Complete manifest, line by line

TOML comments beginning with `#` are explanatory and may remain in a real manifest.

```toml
# Human and machine identity for this acceptance flow.
[meta]
# Short name used in terminal output and the evidence-directory suffix.
name = "secp-transfer-committed"
# Exact manifest contract selected by this file. Other values fail closed.
spec = "0.1.0-draft.3"
# Optional human context; it does not add an executable claim.
description = "A signed secp256k1 transfer commits and creates a live output Cell."

# Exact tools requested for the isolated local chain.
[toolchain]
# CKB node version that OffCKB must start.
ckb = "0.209.0"
# Current adapter version. The feasibility runner accepts only this pin.
offckb = "0.4.13"

# Replay-affecting inputs the author knows the flow depends on.
[replay]
# The current runner accepts only an explicit empty list. It does not infer determinism.
dependencies = []

# Fresh-devnet resources exposed to the trusted transaction producer.
[setup]
# Export the first two ephemeral, prefunded OffCKB development accounts.
accounts = 2

# Start one transaction-producing step. Multiple [[step]] blocks run in order.
[[step]]
# Stable name used by later assertions to refer to this step's transaction.
name = "transfer"
# Trusted command that writes one signed CKB JSON-RPC transaction envelope.
run = "bun run showcases/secp-transfer/produce.ts committed"
# Kill the producer if it has not returned in sixty seconds. Allowed range: 1–600s.
timeout = "60s"
# Ask the runner to submit the transaction and require a committed result.
expect.tx = "committed"

# Add a live-Cell claim evaluated after the step finishes.
[[step.assert.cell]]
# Resolve output index 0 from the transaction produced by the step named "transfer".
out_point = { step = "transfer", index = 0 }
# Require that out point to resolve to one live Cell. Use 0 to require it not to be live.
count = 1
```

## What the producer must return

The `run` command receives these environment variables:

- `CKB_VERIFY_RESULT`: a fresh file path where the producer must write its result;
- `CKB_VERIFY_RPC_URL`: the loopback OffCKB node RPC for chain queries;
- `CKB_VERIFY_ACCOUNTS`: a mode-`0600` file containing the selected ephemeral accounts;
- `CKB_VERIFY_SYSTEM_SCRIPTS`: OffCKB's resolved built-in script metadata;
- `CKB_VERIFY_CONTEXT`: normalized paths and devnet context.

The producer writes exactly one versioned envelope to `CKB_VERIFY_RESULT`:

```json
{
  "protocol": 1,
  "transaction": {
    "version": "0x0",
    "cell_deps": [],
    "header_deps": [],
    "inputs": [],
    "outputs": [],
    "outputs_data": [],
    "witnesses": []
  }
}
```

`transaction` must be a signed CKB JSON-RPC transaction. The producer must not submit it. `ckb-verify` computes the raw transaction hash and submits through OffCKB's proxy so both committed and rejected transactions can be retained as evidence. Stdout and stderr are logs, not protocol output. The runner redacts and rejects the selected OffCKB development private keys; it is not a general-purpose credential sanitizer, so the environment must contain no unrelated secrets.

## Negative transaction expectations

The [rejected fixture](../showcases/secp-transfer/verify.rejected.toml) additionally pins `ckb-debugger` and declares an expected script error:

```toml
[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
ckb-debugger = "1.1.1"

[[step]]
name = "bad-signature"
run = "bun run showcases/secp-transfer/produce.ts rejected"
timeout = "60s"
expect.tx = "rejected"
expect.error.code = -11
```

A matching rejection is a passing declared claim. The report records the RPC error, resolved script group, script hash, error code, and debugger cycles. It does not generalize that result into a contract-correctness claim.

## Current accepted subset

The `0.0.1` feasibility implementation accepts only:

- manifest spec `0.1.0-draft.3`;
- exact CKB and OffCKB versions supported by the adapter;
- an optional exact ckb-debugger version;
- an explicit replay dependency list containing zero or more unique supported dependency codes;
- 1–20 OffCKB development accounts;
- one signed transaction envelope per step;
- committed or rejected transaction expectations;
- an optional expected numeric script error code;
- exact live-Cell count claims by prior step output.

Unknown keys fail closed. A listed replay dependency makes the report explicitly `tainted` with an outcome-scoped reason. Cycle limits, script-filtered Cell queries, Cell data/capacity comparators, balance/UDT claims, and multi-transaction steps remain proposed v0.1 work. The draft RFC documents intent; it is not silently treated as current behavior.

## Run and inspect

From a clean trusted checkout:

```bash
bun install --frozen-lockfile
bun run src/cli.ts run showcases/secp-transfer/verify.committed.toml
```

Exit codes are:

- `0`: every declared claim passed;
- `1`: execution completed, but at least one declared claim failed;
- `2`: manifest, setup, producer, RPC, debugger, evidence, or cleanup error; no valid verdict report.

The command prints the report path plus outcome and environment digests. See [Evidence report anatomy](evidence-report.md) before comparing or publishing the result.
