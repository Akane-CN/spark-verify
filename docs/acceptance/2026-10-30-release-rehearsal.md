# Release rehearsal (no publication)

- candidate: `c1afed4d5ed697449d7d9e24931035980cae5b20`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- tarball: `dist/ckb-verify-0.0.2.tgz`
- tarball sha256: `d2e22903c90ecad838c5e739bad77e3f0b88eb41b336af2acb8a4b37c8e04183`
- release evidence: `dist/release-evidence-0.0.2-c1afed4.tar.gz`
- release evidence sha256: `339ceca3c037a37fc4905263832d80cff2248c7c807c052fab681003c44bb1dd`
- date: 2026-10-30T14:52:53Z

| step | command | result | time |
| --- | --- | --- | --- |
| frozen-tree | `git status --porcelain` | PASS | 0s |
| dependency-install | `bun install --frozen-lockfile` | PASS | 0s |
| supply-chain-gate | `bun run check:supply-chain` | PASS | 0s |
| regression | `bun run check` | PASS | 40s |
| documentation | `./scripts/validate-docs.sh --examples` | PASS | 3s |
| showcase-secp-transfer | `bun run showcase:secp-transfer` | PASS | 94s |
| pack | `bun pm pack --destination dist` | PASS | 0s |
| package-evidence | `bun run scripts/package-evidence.ts --out dist/evidence-secp-transfer-c1afed4d5ed697449d7d9e24931035980cae5b20 --repository Akane-CN/spark-verify --source-sha c1afed4d5ed697449d7d9e24931035980cae5b20 --workflow rehearsal --job secp-transfer` | PASS | 1s |
| release-evidence | `bun run scripts/release-evidence.ts assemble --out dist/release-evidence-0.0.2-c1afed4.tar.gz --bundle dist/evidence-secp-transfer-c1afed4d5ed697449d7d9e24931035980cae5b20 --repository Akane-CN/spark-verify --source-sha c1afed4d5ed697449d7d9e24931035980cae5b20` | PASS | 1s |
| verify-release-evidence | `bun run scripts/release-evidence.ts verify dist/release-evidence-0.0.2-c1afed4.tar.gz --source-sha c1afed4d5ed697449d7d9e24931035980cae5b20 --repository Akane-CN/spark-verify` | PASS | 1s |

The release-evidence archive here was assembled from this host's showcase run, not from a hosted CI run; the release attaches the CI archive (release checklist, step 6).
No tag, release, or package was published by this rehearsal.
