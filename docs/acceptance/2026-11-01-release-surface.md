# Release verification surface record, 2026-11-01

Produced by `bun run verify:release` (`scripts/verify-release.sh`) on commit `9a419bb`, the first run of the surface promised in the proposal §8.B. Eight of nine items pass; item 7 (`run --allow-version-drift`) is pending its implementation in spec `0.1.0-draft.5` and is reported as such rather than skipped silently.

- candidate: `9a419bb2f23528103d78b71c1b0cac783cece36d`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- date: 2026-11-01T22:52:47Z

| item | result | detail |
| --- | --- | --- |
| 1 validate manifests | PASS | 13 manifests valid, nothing executed |
| 2 root verify.toml with this checkout's CLI | PASS | exit 0, verdict PASS, .ckb-verify/runs/2026-11-01T22-50-58-664Z-2085-ckb-verify-dogfood/report.json |
| 3 positive example | PASS | verdict PASS, outcome sha256:1c517951a248884cdf00440f68db7774b1b62dee6ac070958aaa302559c2a4eb |
| 4 failing claim | PASS | exit 1; 1 failed field(s) printed with expected/observed |
| 5 script rejection | PASS | code -11, group role "lock", script "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8" |
| 6 repeated clean run | PASS | outcome and environment digests equal across two fresh devnets |
| 7 tool-version drift | PENDING | run --allow-version-drift is not implemented (RFC implementation matrix §2); the default hard-fail is exercised by the parser and setup pins |
| 8 cross-environment case | PASS | equal outcome, different environment fingerprint, replay tainted: dirty_source |
| 9 recompute report hashes | PASS | 5 reports re-derived offline (digest exit 0), including the FAIL report |

The root manifest is dogfooding, not independent proof. Reports stay under `.ckb-verify/runs/`; nothing was tagged or published.
