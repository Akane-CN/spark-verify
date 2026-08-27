# SoMo Pixel Territory Cluster showcase

This showcase adapts SoMo's Cluster-creation seam to the `ckb-verify` producer boundary and runs it against a fresh pinned OffCKB devnet. The adaptation is intentionally narrow: it creates one Spore Cluster Cell with a local Anyone-Can-Pay (ACP) output lock, signs the transaction without submitting it, and lets the shared runner own submission and evidence capture.

## Upstream provenance

The fixed source is [`LusoCryptoLabs/somo-github-release@d8db7f90b62645d83c58427545fa7fafdaa047d8`](https://github.com/LusoCryptoLabs/somo-github-release/tree/d8db7f90b62645d83c58427545fa7fafdaa047d8), specifically its [`client/src/lib/cluster-mint.ts`](https://github.com/LusoCryptoLabs/somo-github-release/blob/d8db7f90b62645d83c58427545fa7fafdaa047d8/client/src/lib/cluster-mint.ts) and [`client/src/lib/acp-lock.ts`](https://github.com/LusoCryptoLabs/somo-github-release/blob/d8db7f90b62645d83c58427545fa7fafdaa047d8/client/src/lib/acp-lock.ts) flow.

That source tree has no dependency lockfile and declares the CCC/Spore canary line `0.0.0-canary-20251025011602`. This repository pins `@ckb-ccc/spore` to that exact version while retaining the shared root `@ckb-ccc/core` `1.14.0`; Bun installs the Spore package's exact CCC canary dependency beneath Spore. The producer keeps the nested and root CCC values behind an explicit, tested structural conversion boundary rather than downgrading the runner's shared CCC dependency.

This is a local conformance adaptation, not a vendored build or release of the full SoMo application. The SoMo maintainers have not endorsed it, and it must not be described as an adoption, partnership, or maintainer-approved integration.

## Run it

From the repository root:

```bash
bun install --frozen-lockfile
bun run showcase:somo-pixel-territory
```

The first run may download the pinned CKB `0.209.0` binary and ckb-debugger `1.1.1`.

## Cases

| Manifest | Expected result | Purpose |
| --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | `PASS`, exit `0` | The Cluster transaction commits and output Cell `0` is live. |
| [`verify.rejected.toml`](verify.rejected.toml) | `PASS`, exit `0` | The same transaction with a tampered secp256k1 signature is rejected with script error `-11`. |
| [`verify.assertion-failure.toml`](verify.assertion-failure.toml) | `FAIL`, exit `1` | A committed Cluster contradicts an intentionally false live-Cell count. |

[`verify.sh`](verify.sh) runs the committed case twice on independently fresh devnets. It recomputes every report digest, checks cleanup, requires stable semantic outcome and environment digests, and inspects each recorded transaction to prove that its Cluster type and ACP lock match that run's normalized OffCKB export and that the exact exported ACP CellDep remains present.

## Dynamic Cluster/ACP injection

[`script-info.ts`](script-info.ts) resolves these values only from the runner-provided fresh OffCKB raw export:

- `devnet.spore_cluster.script`, copied with `cobuild: true`;
- `devnet.anyone_can_pay.script`;
- the devnet secp256k1 and DAO entries needed by the local CCC client.

[`produce.ts`](produce.ts) then:

1. creates a local CCC client whose known scripts come from that export;
2. derives the signer's 20-byte public-key hash from its recommended secp256k1 lock;
3. builds `to` with the exported ACP `codeHash` and `hashType`, never SoMo's hardcoded public-testnet ACP deployment;
4. invokes the pinned Spore canary's `createSporeCluster` with deterministic plain-text name and description plus the dynamically injected Cluster script info;
5. adds the exact ACP CellDep exported by this fresh devnet because ACP appears only as an output lock and cannot be inferred from an input;
6. completes fees at `1000n`, calls `signOnlyTransaction`, and writes the signed envelope without calling `sendTransaction`.

Runner-owned submission is therefore preserved for both committed and rejected evidence paths.

## What this proves

- the adapted SoMo Cluster-creation seam works on a fresh local chain;
- the dynamically exported local Cluster type script actually executes and commits;
- output `0` is a live ACP-locked Cluster Cell;
- the recorded transaction carries the fresh local ACP CellDep rather than the upstream hardcoded testnet dependency;
- tampering with the signed secp256k1 witness produces a genuine script rejection retained for debugger evidence;
- the false Cell-count fixture is reported as an acceptance failure rather than a producer error;
- repeated fresh runs have stable semantic outcome and environment identities.

## Deliberate limits

This run executes the **Cluster type script**, creates a live **ACP-locked output**, and retains the dynamically exported ACP CellDep. Because the ACP Cell is only created and is not consumed, this does **not** execute or prove the ACP spend path.

The fixture uses a deterministic plain Cluster name and description. It deliberately does **not** call or validate SoMo's DOB decoder lookup, encoded DOB/0 description, backend, database, UI, wallet connector, pixel minting, or cluster-consumption flow. It is not a security audit or proof of the full upstream application.
