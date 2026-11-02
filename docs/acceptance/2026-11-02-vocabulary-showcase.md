# Draft.5 vocabulary showcase record, 2026-11-02

Produced by `bun run showcase:vocabulary` on commit `5cf0d92` (squash-merged as `b47099c`) on this host (Linux x86_64, Bun 1.2.19): the committed case, the four declared failures (`cycles-too-low`, `wrong-data`, `wrong-capacity`, `balance-short`), and a fresh committed repeat, each report loaded with `verifyReport` and the closeout checks passing. The same wrapper passed in the hosted `Draft.5 vocabulary showcase` job of run 41369996406. The repeat comparison printed by the wrapper:

```json
{
  "outcome": "equal",
  "reports": [
    ".ckb-verify/runs/2026-11-02T00-58-24-092Z-8960-vocabulary-xudt-mint/report.json",
    ".ckb-verify/runs/2026-11-02T01-00-14-897Z-18074-vocabulary-xudt-mint/report.json"
  ],
  "outcomes": [
    "sha256:0d5bc813eb5fe8aea01297a22b83b3e35e2224b86a0cbd751abed540b0d3648e",
    "sha256:0d5bc813eb5fe8aea01297a22b83b3e35e2224b86a0cbd751abed540b0d3648e"
  ],
  "environments": [
    "sha256:33c20b3efc8894f692d5c2b2afdd57e32920144a8ba807143716db8c234408a1",
    "sha256:33c20b3efc8894f692d5c2b2afdd57e32920144a8ba807143716db8c234408a1"
  ]
}
```

Equal outcome digests across two fresh devnets mean the aggregate balances, including the fresh genesis Cells, repeated; the wrapper asserts only the per-claim verdicts and reports the digests.
