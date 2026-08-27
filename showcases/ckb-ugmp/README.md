# CKB-UGMP Spore mint showcase

This showcase is a bounded, headless adaptation of the Spore mint path in [`HNO3Miracle/CKB-UGMP` at `543def6e717b2d67f619a76c3d9283e55b211b83`](https://github.com/HNO3Miracle/CKB-UGMP/tree/543def6e717b2d67f619a76c3d9283e55b211b83), specifically [`lib/sporeMint.ts`](https://github.com/HNO3Miracle/CKB-UGMP/blob/543def6e717b2d67f619a76c3d9283e55b211b83/lib/sporeMint.ts) and [`lib/dobMetadata.ts`](https://github.com/HNO3Miracle/CKB-UGMP/blob/543def6e717b2d67f619a76c3d9283e55b211b83/lib/dobMetadata.ts).

This is independent technical feasibility evidence. The CKB-UGMP maintainers have not endorsed it, and it must not be described as an adoption, partnership, or maintainer-approved integration.

## Run it

From the repository root:

```bash
bun install --frozen-lockfile
bun run showcase:ckb-ugmp
```

The first run may download the pinned CKB `0.209.0` binary and ckb-debugger `1.1.1`.

## Cases

| Manifest | Expected result | Purpose |
| --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | `PASS`, exit `0` | A Spore mint with the fresh local deployment commits and output Cell `0` is live. |
| [`verify.rejected.toml`](verify.rejected.toml) | `PASS`, exit `0` | The same transaction with only its secp256k1 signature tampered is rejected with script error `-11`. |
| [`verify.assertion-failure.toml`](verify.assertion-failure.toml) | `FAIL`, exit `1` | A committed Spore mint contradicts an intentionally false live-Cell count. |

[`verify.sh`](verify.sh) runs the committed case twice on independently fresh OffCKB devnets. It recomputes every report digest, checks cleanup, requires stable semantic outcome and environment digests, and reads each recorded transaction back to confirm that its Spore type and CellDep match that run's normalized OffCKB export.

## Dynamic Spore injection

The pinned upstream uses `@ckb-ccc/spore@1.5.17`, which this repository locks exactly. [`spore.ts`](spore.ts) resolves `devnet.spore.script` only from the raw system-script export produced for the current fresh OffCKB chain. Its `codeHash`, `hashType`, and Cell deps are passed to `createSpore({ scriptInfo })`; public testnet and mainnet presets are not used.

OffCKB's raw export describes on-chain identity and deps but does not encode Spore protocol mode. The adapter therefore adds `cobuild: true` explicitly for the locally deployed Spore V2 binary. This semantic flag is a pinned adapter assumption, not a fact inferred from the raw identity object.

`@ckb-ccc/spore@1.5.17` carries CCC core `1.12.5`, while the shared runner remains on CCC core `1.14.0`. [`produce.ts`](produce.ts) keeps the structural compatibility cast at this package boundary instead of downgrading the runner dependency; the complete fresh-devnet acceptance run exercises that boundary.

## Bounded adaptation

The producer preserves CKB-UGMP's `createSpore` construction seam and DOB/0 content type while replacing browser-only inputs:

- deterministic local game-profile JSON replaces uploaded Pinata content;
- `clusterMode: "skip"` avoids requiring a pre-existing public-network Cluster;
- the Spore identity and CellDep come from the current OffCKB deployment;
- fee completion uses a deterministic `1_000n` shannons/KB rate because a fresh devnet has no useful fee-rate history;
- the producer signs and atomically writes one JSON-RPC transaction envelope, while the runner alone broadcasts it.

The producer does not import `connector-react`, call Pinata, select a browser wallet, or call `sendTransaction`/`send_transaction`.

## Scope limits

This proves only the adapted standalone Spore mint path. It does not run the CKB-UGMP Next.js UI unchanged, validate hosted storage, exercise game UI/state, mint into a Cluster, test public-network presets, or audit the Spore contract or upstream application. A pass means only that the declared claims passed in the recorded environment.
