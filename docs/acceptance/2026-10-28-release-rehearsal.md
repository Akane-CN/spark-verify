# Release rehearsal (no publication)

- candidate: `d0d7a88eb909fe7062ccd18d5339550de130c70f`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.0.2.tgz`
- tarball sha256: `4b05e93af2e9845f837deea4434b43a6d898e19e730f1aa4fe2da74263f53af7`
- date: 2026-10-28T08:24:13Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 0s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 1s |
| regression | `bun run check` | PASS | 28s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 3s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 83s |
| pack | `bun pm pack --destination dist` | PASS | 0s |

No tag, release, or package was published by this rehearsal.
