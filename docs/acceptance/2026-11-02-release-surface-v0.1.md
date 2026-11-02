# Release verification surface record on the frozen v0.1 contract, 2026-11-02

Produced by `bun run verify:release` (`scripts/verify-release.sh`) on commit `904658c`, the head of PR #37 with the root `verify.toml` and the vocabulary manifests on spec `0.1.0`. All nine proposal §8.B items pass.

Two earlier runs on this branch did not, and both are kept out of the record set on purpose. On `e025425`, item 7 returned FAIL because the indexer-backed claims of the drifted run read the node indexer before it had indexed the committing block (both selections empty while the `out_point` claims on the same Cells passed); `b615f4f` makes indexer-backed claims wait for the indexer to reach the chain tip. On `b615f4f`, items 7–9 exited 2 because a source file was edited while the run was in progress, which the runner refuses by design. This run was made on a clean tree with nothing touched until it finished.

- candidate: `904658c604a0acfbaaa17229bc13a269cf9d8d9c`
- version: `0.0.2`
- platform: Linux x86_64, bun 1.2.19, node v22.22.0
- date: 2026-11-02T04:24:07Z

| item | result | detail |
| --- | --- | --- |
| 1 validate manifests | PASS | 19 manifests valid, nothing executed |
| 2 root verify.toml with this checkout's CLI | PASS | exit 0, verdict PASS, /home/user/spark-verify/.ckb-verify/runs/2026-11-02T04-21-35-063Z-10867-ckb-verify-dogfood/report.json |
| 3 positive example | PASS | verdict PASS, outcome sha256:9e3bebe2ac67de635e1e12a9479ee150d739727dc32c32ab029f27cb10b4e1b3 |
| 4 failing claim | PASS | exit 1; 1 failed field(s) printed with expected/observed |
| 5 script rejection | PASS | code -11, group role "lock", script "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8" |
| 6 repeated clean run | PASS | outcome and environment digests equal across two fresh devnets |
| 7 tool-version drift | PASS | default exit 2 (no pinned CKB for the requested version); --allow-version-drift PASS with a different environment fingerprint and replay tainted: tool_version_drift |
| 8 cross-environment case | PASS | equal outcome, different environment fingerprint, replay tainted: dirty_source |
| 9 recompute report hashes | PASS | 7 reports re-derived offline (digest exit 0), including the FAIL and the drifted report |

The root manifest is dogfooding, not independent proof. Reports stay under `.ckb-verify/runs/`; nothing was tagged or published.
