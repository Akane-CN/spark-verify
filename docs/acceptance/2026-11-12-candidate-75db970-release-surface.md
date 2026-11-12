# Release verification surface on the v0.1.1 candidate `75db970`, 2026-11-12

Produced by `bun run verify:release` in a clean checkout of the candidate `75db970` (release checklist step 3), as uid 0. All nine proposal §8.B items passed. Summary: [`2026-11-12-candidate-75db970.md`](2026-11-12-candidate-75db970.md).

- candidate: `75db9702a4066b607c8026b732a5b09573d7e11e`
- version: `0.1.1`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- date: 2026-11-12T00:02:33Z

| item | result | detail |
| --- | --- | --- |
| 1 validate manifests | PASS | 26 manifests valid, nothing executed |
| 2 root verify.toml with this checkout's CLI | PASS | exit 0, verdict PASS, /tmp/claude-0/-home-user-spark-verify/3d07c0ae-e70f-5c5d-a19f-9b662139f532/scratchpad/candidate-75db970/.ckb-verify/runs/2026-11-11T23-58-26-292Z-15700-ckb-verify-dogfood/report.json |
| 3 positive example | PASS | verdict PASS, outcome sha256:9e3bebe2ac67de635e1e12a9479ee150d739727dc32c32ab029f27cb10b4e1b3 |
| 4 failing claim | PASS | exit 1; 1 failed field(s) printed with expected/observed |
| 5 script rejection | PASS | code -11, group role "lock", script "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"; spec 0.2.0 expect.error.group pinned (code 42, lock witness_lock) PASS, wrong group FAIL |
| 6 repeated clean run | PASS | outcome and environment digests equal across two fresh devnets |
| 7 tool-version drift | PASS | default exit 2 (no pinned CKB for the requested version); --allow-version-drift PASS with a different environment fingerprint and replay tainted: tool_version_drift |
| 8 cross-environment case | PASS | equal outcome, different environment fingerprint, replay tainted: dirty_source |
| 9 recompute report hashes | PASS | 8 reports re-derived offline (digest exit 0), including the FAIL and the drifted report |

The root manifest is dogfooding, not independent proof. Reports stay under `.ckb-verify/runs/`; nothing was tagged or published.
