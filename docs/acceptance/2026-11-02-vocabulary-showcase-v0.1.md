# v0.1 vocabulary showcase record (spec `0.1.0`), 2026-11-02

Produced by `bun run showcase:vocabulary` on commit `904658c` on this host (Linux x86_64, Bun 1.2.19), with every vocabulary manifest on spec `0.1.0`: the committed case, the four declared failures (`cycles-too-low`, `wrong-data`, `wrong-capacity`, `balance-short`), and a fresh committed repeat, each report loaded with `verifyReport` and the closeout checks passing.

The outcome digests of the three property failures equal those of the hosted run on `e025425`, so the outcomes are reproducible across hosts. `balance-short` differs because that hosted run recorded a stale empty selection from a lagging node indexer, the defect `b615f4f` fixes; here it fails only on the declared shortfall.

| case | verdict | outcome digest |
| --- | --- | --- |
| committed | PASS | `sha256:ccc1253dcd57ee89edf272168044bb8bceef8c02ef131929b9f4f4698eeb93be` |
| cycles-too-low | FAIL | `sha256:a21df07fc8704147e2e1995afacc508e45f8c6e08528ed4f032258c82f57557b` |
| wrong-data | FAIL | `sha256:462f9472e2a45c6f823441eb8043c59bf7831326f0e5e828e92b373cd7869168` |
| wrong-capacity | FAIL | `sha256:34e01e9f2b6b7bdc3c5c80eddfa4709de86f09fd21437bfc6324130ef50fbd2c` |
| balance-short | FAIL | `sha256:f5cab190b37040cf89e81be61abf6c1a1fa42939b8866e373807e2d8afcc105c` |
| committed (fresh repeat) | PASS | `sha256:ccc1253dcd57ee89edf272168044bb8bceef8c02ef131929b9f4f4698eeb93be` |

The wrapper's repeat comparison:

```json
{
  "outcome": "equal",
  "reports": [
    "/home/user/spark-verify/.ckb-verify/runs/2026-11-02T04-19-11-788Z-32116-vocabulary-xudt-mint/report.json",
    "/home/user/spark-verify/.ckb-verify/runs/2026-11-02T04-21-01-807Z-8773-vocabulary-xudt-mint/report.json"
  ],
  "outcomes": [
    "sha256:ccc1253dcd57ee89edf272168044bb8bceef8c02ef131929b9f4f4698eeb93be",
    "sha256:ccc1253dcd57ee89edf272168044bb8bceef8c02ef131929b9f4f4698eeb93be"
  ],
  "environments": [
    "sha256:8672cfdec4fee280300c55ca369bc30448d19352702ceb7b86b9138914282e6c",
    "sha256:8672cfdec4fee280300c55ca369bc30448d19352702ceb7b86b9138914282e6c"
  ]
}
```
