# Secp256k1 transfer showcase

This is the first end-to-end `ckb-verify` showcase. It exercises the shared runner against real fresh OffCKB devnets while keeping project-specific CCC transaction construction local to this directory.

## Run it

From the repository root:

```bash
bun install --frozen-lockfile
bun run showcase:secp-transfer
```

The first run may download the pinned CKB `0.209.0` binary and ckb-debugger `1.1.1`.

## Cases

| Manifest | Expected result | Purpose |
| --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | `PASS`, exit `0` | A signed transfer commits and output Cell `0` is live. |
| [`verify.rejected.toml`](verify.rejected.toml) | `PASS`, exit `0` | A tampered signature is rejected with script error `-11` and debugger evidence. |
| [`verify.assertion-failure.toml`](verify.assertion-failure.toml) | `FAIL`, exit `1` | A valid committed transaction contradicts an intentionally false Cell-count claim. |

[`verify.sh`](verify.sh) runs the committed case twice on independently fresh devnets. It recomputes every report digest, requires the two semantic outcome and environment digests to match, confirms the expected failure exit code, and checks that development accounts and ports `8114`/`28114` are cleaned up after every run.

## Producer boundary

[`produce.ts`](produce.ts) receives the canonical `CKB_VERIFY_*` runner context, constructs and signs one CCC transaction, and atomically writes the versioned result envelope. It never calls `send_transaction`; the shared runner owns submission so it can retain and explain rejected transactions.

## What this proves

- runner-owned submission works for both committed and rejected transactions;
- live-Cell assertions distinguish a real output from an invalid or vacuous reference;
- script rejections retain normalized RPC, script-group, debugger-result, and cycle evidence;
- reports carry independently verifiable semantic outcome and environment identities;
- repeated fresh runs agree on normalized evidence despite different transaction identities;
- timeout, signal, process-group, secret-removal, and endpoint-cleanup paths are exercised by the shared test suite and this harness.

## What this does not prove

This showcase is a bounded conformance flow, not a security audit, hostile-code sandbox, package release, or claim that arbitrary CKB applications already fit the vocabulary. A separate CKB-UGMP candidate integration exists in [PR #7](https://github.com/Akane-CN/spark-verify/pull/7); it remains independent feasibility work unless its maintainer explicitly agrees to a trial.
