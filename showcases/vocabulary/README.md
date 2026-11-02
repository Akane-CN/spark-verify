# Draft.5 vocabulary fixture

Repository-owned fixture for the [draft.5 assertion vocabulary](../../docs/vocabulary-draft.5.md): one transaction mints an owner-mode xUDT Cell (150 CKB, 1000 units as 16 little-endian bytes) to the development signer and transfers 100 CKB to the second account. It uses the exported OffCKB `xudt`, `secp256k1_blake160_sighash_all`, and `dao` identities from the runner context; nothing is deployed or endorsed.

## Producer

`produce.ts mint` builds the two-output transaction with `@ckb-ccc/core@1.14.0`, adds the exported xUDT dependencies, completes capacity and fees at `1_000n`, signs, and atomically writes a private protocol-1 envelope to `CKB_VERIFY_RESULT`. It never broadcasts. The xUDT args are the owner lock hash; the signer's own input satisfies owner mode. Account 0 and 1 locks are the deterministic OffCKB development accounts, so the committed manifest can name the owner args and account 1's address literally.

## Expected cases

Every manifest keeps `expect.tx = "committed"`; assertion failures need no debugger pin.

| Manifest | Declared difference from positive | Expected CLI |
| --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | cycles `gte 1, lt 100_000_000`; output 0 by `out_point` + account 0 lock + exact xUDT type + `data.eq`/`len = 16` + `capacity eq 150 CKB`; output 1 count 1 + `capacity eq 100 CKB`; xUDT deps; account 0 Cells by lock + wildcard xUDT type `count gte 1, lte 10`, `min_bytes 16`; absence under `always_success`; balances by account, by address, and UDT by owner args `eq 1000`; run twice fresh | PASS / 0 |
| [`verify.cycles-too-low.toml`](verify.cycles-too-low.toml) | `expect.cycles.lt = 2` | FAIL / 1: cycles comparator |
| [`verify.wrong-data.toml`](verify.wrong-data.toml) | `data.eq` names 1001 units | FAIL / 1: data bytes |
| [`verify.wrong-capacity.toml`](verify.wrong-capacity.toml) | `capacity gte 151 CKB` on the 150 CKB Cell | FAIL / 1: capacity |
| [`verify.balance-short.toml`](verify.balance-short.toml) | UDT balance `gte 1001` | FAIL / 1: aggregate below the bound |
| [`verify.drift.toml`](verify.drift.toml) | `toolchain.ckb = "0.208.0"` (not run by the wrapper) | exit 2 by default; PASS with `run --allow-version-drift`, tainted `tool_version_drift` |

## Run and inspect

```bash
bun run showcase:vocabulary
```

The wrapper runs the five cases plus a fresh committed repeat, checks exact exits and verdicts and the intended failing predicates, loads every complete report with `verifyReport` (including valid FAIL reports), checks `report/3` + `environment/4` + two exported accounts, and checks account/pending-report absence and IPv4/IPv6 ports independently. The repeat compares per-claim verdicts and prints both outcome and environment digests: balance claims aggregate fresh genesis Cells, so equal outcome digests are reported when they occur, not asserted. The CI job packages the canonical reports into the sanitized [evidence bundle](../../docs/offline-verification.md#evidence-bundles) that `verify-evidence` downloads and re-checks.
