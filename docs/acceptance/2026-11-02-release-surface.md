# Release verification surface record, 2026-11-02

Produced by `bun run verify:release` (`scripts/verify-release.sh`) on commit `5cf0d92`, the head squash-merged as `b47099c`. All nine proposal §8.B items pass, including item 7, which was pending in the 2026-11-01 record: the drift manifest is refused by default and passes with `--allow-version-drift`, with a different environment fingerprint and replay tainted `tool_version_drift`.

- candidate: `5cf0d92879c5a87d1c707b1a5b90b2187cae916d`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- date: 2026-11-02T01:03:24Z

| item | result | detail |
| --- | --- | --- |
| 1 validate manifests | PASS | 19 manifests valid, nothing executed |
| 2 root verify.toml with this checkout's CLI | PASS | exit 0, verdict PASS, .ckb-verify/runs/2026-11-02T01-00-49-240Z-20167-ckb-verify-dogfood/report.json |
| 3 positive example | PASS | verdict PASS, outcome sha256:1c517951a248884cdf00440f68db7774b1b62dee6ac070958aaa302559c2a4eb |
| 4 failing claim | PASS | exit 1; 1 failed field(s) printed with expected/observed |
| 5 script rejection | PASS | code -11, group role "lock", script "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8" |
| 6 repeated clean run | PASS | outcome and environment digests equal across two fresh devnets |
| 7 tool-version drift | PASS | default exit 2 (no pinned CKB for the requested version); --allow-version-drift PASS with a different environment fingerprint and replay tainted: tool_version_drift |
| 8 cross-environment case | PASS | equal outcome, different environment fingerprint, replay tainted: dirty_source |
| 9 recompute report hashes | PASS | 7 reports re-derived offline (digest exit 0), including the FAIL and the drifted report |

The root manifest is dogfooding, not independent proof. Reports stay under `.ckb-verify/runs/`; nothing was tagged or published.
