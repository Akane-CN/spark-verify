# NervDAO deposit showcase

This showcase is a bounded, headless adaptation of the DAO deposit flow in [`ckb-devrel/nervdao` at `09fc1aea6f3d0527cc2af08f766d900780a32ae9`](https://github.com/ckb-devrel/nervdao/tree/09fc1aea6f3d0527cc2af08f766d900780a32ae9), specifically its [`DepositForm.tsx`](https://github.com/ckb-devrel/nervdao/blob/09fc1aea6f3d0527cc2af08f766d900780a32ae9/src/app/components/DepositForm.tsx). The exact upstream revision is fixed so the source flow being adapted does not move during review.

This is independent technical feasibility evidence. The NervDAO maintainers have not endorsed this showcase, and it must not be described as an adoption, partnership, or maintainer-approved integration.

## Run it

From the repository root:

```bash
bun install --frozen-lockfile
bun run showcase:nervdao
```

The first run may download the pinned CKB `0.209.0` binary and ckb-debugger `1.1.1`.

## Cases

| Manifest | Expected result | Purpose |
| --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | `PASS`, exit `0` | A signed 200 CKB DAO deposit commits and output Cell `0` is live. |
| [`verify.rejected.toml`](verify.rejected.toml) | `PASS`, exit `0` | The same deposit with only its secp256k1 signature tampered is rejected with script error `-11`. |
| [`verify.assertion-failure.toml`](verify.assertion-failure.toml) | `FAIL`, exit `1` | A valid committed deposit contradicts an intentionally false live-Cell count. |

[`verify.sh`](verify.sh) runs the committed case twice on independently fresh OffCKB devnets. It verifies every emitted report, requires stable semantic outcome and environment digests, checks the intentional failure exit code, and confirms that OffCKB account material, pending reports, and ports `8114`/`28114` are cleaned up after every run.

## Bounded adaptation

The producer preserves the pinned upstream deposit sequence: obtain the signer's lock, construct a Nervos DAO-typed output with eight zero data bytes, add the DAO Cell dep, complete inputs and fee, and sign the transaction. The local adaptation is intentionally narrow:

- the deposit amount is fixed at 200 CKB instead of coming from the browser form;
- secp256k1 and DAO script metadata and Cell deps come from the runner's fresh OffCKB system-script export rather than static hashes or out-points;
- fee completion uses a deterministic `1_000n` shannons/KB rate because a fresh devnet has no useful fee-rate history;
- the producer calls `signTransaction` and writes one versioned result envelope; it never calls `sendTransaction` or submits through RPC;
- the rejected case changes only the first byte of the completed secp256k1 signature, after signing, so runner-owned submission reaches a genuine lock-script rejection.

This does **not** run the original Next.js UI unchanged. It replaces browser wallet selection, form state, notifications, and the UI's submit/wait boundary with the canonical headless `CKB_VERIFY_*` producer seam.

## Scope limits

This showcase covers only a single DAO **deposit**. It does not exercise DAO withdrawal or compensation, iCKB flows, wallet UX, public networks, or the rest of the NervDAO application. A pass means only that all declared claims passed in the recorded environment; it is not a security audit or a broader correctness claim about NervDAO.
