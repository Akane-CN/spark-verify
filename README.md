# Spark Verify / `ckb-verify`

**Executable acceptance claims for CKB projects.**

> **Status: unreleased feasibility implementation.** This repository now contains a working vertical slice, not only an RFC. The implemented manifest vocabulary is intentionally smaller than the draft RFC and is not a stable public interface yet.

`ckb-verify` starts a fresh pinned [OffCKB](https://github.com/ckb-devrel/offckb) devnet, lets trusted project code construct and sign one transaction per step, submits that transaction itself, evaluates declared CKB outcomes, and writes a structured evidence report.

It composes the existing CKB stack instead of replacing it:

- **OffCKB** owns the isolated devnet, deterministic development accounts, built-in scripts, and failed-transaction cache.
- **CCC** builds and signs fixture transactions.
- **CKB RPC** is the authority for transaction status and live Cells.
- **ckb-debugger** replays rejected script groups and reports error codes and cycles.

A passing report is not an audit, a sandbox, or proof that the manifest declared every important property. It means the runner observed all declared claims passing in the recorded environment.

## Verified showcase

The first repository showcase packages three secp256k1 transfer fixtures behind one reproducible acceptance command:

1. A signed transfer commits and output `0` is asserted live.
2. The same transaction with a tampered signature is rejected with script error `-11`; the runner records `Inputs[0].Lock`, the resolved script and script hash, and debugger cycles.
3. A valid committed transfer intentionally declares the wrong live-Cell count and returns `FAIL` with process exit code `1`.

The acceptance harness runs the committed fixture twice on fresh devnets and requires identical outcome and environment digests.

`PASS` means exactly: **All declared claims passed in the recorded environment.** It does not claim broader contract correctness or a security audit.

```bash
bun install --frozen-lockfile
bun run check
bun run showcase:secp-transfer
```

The current pinned fixture environment is:

- Bun `1.2.19`
- `@offckb/cli` `0.4.13`
- CKB `0.209.0`
- `@ckb-ccc/core` `1.14.0`
- ckb-debugger `1.1.1` for rejected-script replay

The first devnet run may download the pinned CKB binary and debugger.

## CLI

```text
ckb-verify run [manifest]
ckb-verify --help
ckb-verify --version
```

Run one fixture directly:

```bash
bun run src/cli.ts run showcases/secp-transfer/verify.committed.toml
bun run src/cli.ts run showcases/secp-transfer/verify.rejected.toml
```

A completed run uses these exit codes:

- `0`: all declared claims passed;
- `1`: execution completed but at least one declared claim failed;
- `2`: manifest, setup, producer, RPC, debugger, or evidence error; no valid verdict.

The intentionally failing fixture therefore returns `1`. Use `bun run showcase:secp-transfer` (or its `test:devnet` compatibility alias) when validating all three paths because the harness checks that exit code and post-run cleanup explicitly.

## Implemented manifest subset

```toml
[meta]
name = "secp-transfer-committed"
spec = "0.1.0-draft.3"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "transfer"
run = "bun run showcases/secp-transfer/produce.ts committed"
timeout = "60s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "transfer", index = 0 }
count = 1
```

The feasibility implementation supports only:

- exact spec `0.1.0-draft.3`;
- exact CKB and OffCKB versions accepted by the current adapter;
- optional exact ckb-debugger version;
- `[replay].dependencies = []`;
- `1..20` OffCKB development accounts;
- one signed transaction envelope per step;
- `expect.tx = "committed"` or `"rejected"`;
- optional `expect.error.code` for a rejected script;
- exact live-Cell count assertions targeting `{ step, index }`.

Unknown keys fail closed. Script deployment declarations, balance/UDT assertions, script filters, cycle comparators, non-empty replay dependencies, and multi-transaction steps remain RFC targets and are not silently accepted.

See [`docs/verify-toml-rfc-v0.2.md`](docs/verify-toml-rfc-v0.2.md) for the broader design. Its unimplemented sections are proposals, not current CLI behavior.

## Producer boundary

For each step the runner executes the trusted repository command with:

- `CKB_VERIFY_RESULT`: fresh path for the result envelope;
- `CKB_VERIFY_RPC_URL`: loopback OffCKB node RPC for chain queries;
- `CKB_VERIFY_ACCOUNTS`: mode-`0600` JSON file containing selected OffCKB development accounts;
- `CKB_VERIFY_SYSTEM_SCRIPTS`: OffCKB system-script export;
- `CKB_VERIFY_CONTEXT`: normalized devnet context.

The producer writes exactly one object to `CKB_VERIFY_RESULT`:

```json
{
  "protocol": 1,
  "transaction": {
    "version": "0x0",
    "cell_deps": [],
    "header_deps": [],
    "inputs": [],
    "outputs": [],
    "outputs_data": [],
    "witnesses": []
  }
}
```

`transaction` must be a signed CKB JSON-RPC transaction. Stdout and stderr are logs only. The producer must not submit the transaction; `ckb-verify` computes the raw transaction hash and submits through OffCKB's proxy so rejected transactions remain available for debugger replay. The unreleased interface exports only the canonical `CKB_VERIFY_*` namespace.

## Evidence and digests

Each run writes an ignored directory under:

```text
.ckb-verify/runs/<timestamp>-<pid>-<manifest-name>/
```

Evidence includes the manifest, producer result and sanitized logs, signed transaction, RPC response or structured rejection, resolved script-group evidence, debugger output/full transaction when applicable, Cell query responses, and `report.json`.

The report records:

- expected and observed transaction status;
- script RPC code, script error code, source Cell/index, role, normalized script, script hash, and debugger cycles;
- exact Cell assertion definitions and observations;
- requested and observed tool versions;
- Git commit and dirty state;
- manifest hash, platform, genesis hash, and normalized OffCKB system scripts.

It emits two RFC-8785 canonical SHA-256 identities:

- **outcome digest**: declared claims and normalized observations, excluding raw transaction identity and runtime paths;
- **environment fingerprint**: the recorded manifest, source, toolchain, runtime, platform, genesis, and system-script environment.

The runner recomputes both embedded canonical objects before writing the report, checks that normalized evidence agrees with the embedded outcome claims, and verifies that the top-level verdict is the verdict derived from those claims. It also scans the run evidence for the selected OffCKB development private keys with case-insensitive matching; any match is redacted and turns the run into an execution error. The temporary account file is removed when the devnet stops.

## Trust and safety

`run` executes arbitrary repository code with the current user's permissions. The MVP is **not a security sandbox**. Use only trusted repositories on a disposable environment with no production wallets, SSH agents, cloud credentials, or unrelated secrets.

The producer receives a loopback node URL for queries, but the current feasibility implementation does not provide a network namespace or cryptographically enforce read-only access. Runner-owned submission is an architectural protocol for trusted code, not a containment boundary.

OffCKB `0.4.13` advertises the proxy through a loopback URL but its proxy process binds port `28114` on the wildcard interface. The adapter cannot narrow that inherited bind behavior. Run behind a host firewall or inside a disposable VM/container whose devnet ports are not reachable from untrusted networks.

See [`SECURITY.md`](SECURITY.md) before running or modifying CI execution.

## Repository map

- [`src/`](src/) — CLI, strict manifest parser, OffCKB adapter, runner, RPC boundary, and report canonicalization
- [`showcases/`](showcases/) — bounded, executable integrations built on the runner
- [`showcases/secp-transfer/`](showcases/secp-transfer/) — the first showcase: committed, rejected, and assertion-failure secp transfer paths
- [`tests/`](tests/) — unit and orchestration tests
- [`.github/workflows/verify.yml`](.github/workflows/verify.yml) — read-only CI for unit/docs checks and the fresh-devnet showcase
- [`showcases/secp-transfer/verify.sh`](showcases/secp-transfer/verify.sh) — real fresh-devnet acceptance, cleanup, and digest-stability harness
- [`docs/verify-toml-rfc-v0.2.md`](docs/verify-toml-rfc-v0.2.md) — broader draft vocabulary and report design
- [`docs/spark-proposal.md`](docs/spark-proposal.md) — Spark Program application material
- [`docs/design-review.md`](docs/design-review.md) — prior design review and gates

## Next conformance target

The current secp transfer is a runner-owned fixture proving the orchestration mechanics. Adapting a completed real project, CKB-UGMP, is intentionally reserved for a separate follow-up change so project-specific integration does not blur the runner MVP review.

Relevant tracking issues:

- [#1 — committed/rejected transaction feasibility and two-hash replay](https://github.com/Akane-CN/spark-verify/issues/1)
- [#2 — OffCKB package boundary and built-in script references](https://github.com/Akane-CN/spark-verify/issues/2)
- [#3 — completed-project conformance example](https://github.com/Akane-CN/spark-verify/issues/3)

## License

[MIT](LICENSE)
