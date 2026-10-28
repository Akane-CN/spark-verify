# Spark Verify / `ckb-verify`

**Executable acceptance claims for CKB projects.**

> **Status: unreleased feasibility implementation.** This repository now contains a working vertical slice, not only an RFC. The implemented manifest vocabulary is intentionally smaller than the draft RFC and is not a stable public interface yet.

Start with the [line-by-line annotated manifest](docs/annotated-manifest.md), then inspect the [evidence report anatomy and checked fresh-devnet example](docs/evidence-report.md). The [Spark Program application](docs/spark-proposal.md) records the exact pre-funding implementation and remaining requested scope.

`ckb-verify` starts a fresh pinned [OffCKB](https://github.com/ckb-devrel/offckb) devnet, lets trusted project code construct and sign one transaction per step, submits that transaction itself, evaluates declared CKB outcomes, and writes a structured evidence report.

It composes the existing CKB stack instead of replacing it:

- **OffCKB** owns the isolated devnet, deterministic development accounts, built-in scripts, and failed-transaction cache.
- **CCC** builds and signs fixture transactions.
- **CKB RPC** is the authority for transaction status and live Cells.
- **ckb-debugger** replays rejected script groups and reports error codes and cycles.

A passing report is not an audit, a sandbox, or proof that the manifest declared every important property. It means the runner observed all declared claims passing in the recorded environment.

## Spore mint walkthrough

[Watch the workflow video (3:26, English captions)](docs/media/spore-mint-workflow.mp4)

A real Spore mint on a local CKB test chain, from defining the expected result to
running the check and inspecting its report. The recording shows a valid mint
passing its checks, an intentionally incorrect assertion failing, a transaction
with a bad signature being rejected as expected, and matching verification
results when rerun in the same environment.

Follow the [setup and reproduction steps for the recorded revision](https://github.com/Akane-CN/spark-verify/blob/a7562917939e603f9e2d0dc3e55cb9e1ecd9a35e/showcases/ckb-ugmp/README.md)
to run the example locally.

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

## Draft.4 Cell-property fixture

The private `0.0.2` runner also accepts [draft.4 type/args-length/data-length and CellDep claims](docs/cell-claims-draft.4.md). The repository-owned [generic DAO-deposit fixture](showcases/cell-properties/README.md) adds six declared cases plus a fresh positive repeat through `bun run showcase:cell-properties`. It is not NervDAO adoption. Its initial Phase B implementation is offline-tested; native acceptance is **NOT_RUN**, and no new real report is bundled. The existing secp historical evidence does not establish DAO acceptance.

The new wrapper verifies each complete PASS/FAIL report with `verifyReport`, checks the intended failing predicates, and independently checks account/pending-report absence and ports even if report readback fails. Repeats require equal outcomes; repeated raw provenance requires equal environments. Differing real genesis/deployment bindings remain visible, not scrubbed to force equality. CI execution is separate from artifact publication (#19).

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

## Runtime ownership (Linux x64 / Bun)

The devnet adapter supports Linux x64 with Bun (tested with `1.2.19`). Before tool installation, configuration, cleaning, or node startup, it acquires one kernel-backed abstract Unix socket for the fixed RPC/proxy namespace `8114/28114`. Runs in the same checkout, sibling checkouts, or under different users in the same network namespace serialize by failing fast: the loser exits with a `runtime busy` error and must retry after the owner finishes. It cannot stop the owner or delete its account file.

Both ports are checked for IPv4 and IPv6 bind conflicts before setup. Existing listeners are never stopped to make room. Normal shutdown, setup failure, producer timeout, and SIGINT/SIGTERM drain in-flight setup/commands, remove the owned account file, and release ownership after cleanup. Cancellation may wait for the current bounded setup operation; repeated signals do not skip cleanup. Interrupted cleanup does not publish `report.json`; SIGINT and SIGTERM return `130` and `143` respectively.

A crash releases the kernel lock without PID files, expiry-based stealing, or signals to a recorded PID. A surviving daemon still makes the next run fail port preflight: inspect it in your disposable environment rather than deleting a lock or killing an unknown listener. Ownership coordinates cooperating runners, not arbitrary processes, and is neither a network isolation mechanism nor a sandbox. See the [multi-user and namespace boundary](SECURITY.md#runtime-ownership-boundary).

## Debugger artifact boundary

Declared rejected transactions require `ckb-debugger = "1.1.1"`; runs that do not need the debugger may omit it. Selection is checked before devnet startup. The only supported debugger artifact is Linux/x64. Unexpected script rejection without that pin fails with no verdict instead of installing a mutable latest release.

After startup succeeds, the adapter prepares one private execution snapshot from archive and executable bytes checked against source-controlled size/SHA-256 pins. It verifies the snapshot before `--version` and every debug call, requires exactly `ckb-debugger 1.1.1`, and sets `OFFCKB_DEBUGGER_GUARD=1` with run-owned settings to prevent an ambient PATH probe. Concurrent preparation coalesces; debug is refused until preparation completes. Shutdown drains entire preparation/validation/process operations before removing snapshots and releasing ownership. Verified cache bytes remain for later reuse; an existing incomplete or tampered cache fails without repair or fallback.

New reports use environment `/3` and provenance `/2`, including explicit debugger identity or `null`. Historical environment `/2` + provenance `/1` reports require explicit legacy verification and gain no debugger-integrity guarantee. Hash consistency is not execution authenticity or protection against an actively hostile same-UID writer. See the [report contract](docs/evidence-report.md) and [supply-chain boundary](SECURITY.md#debugger-integrity).

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

- exact legacy spec `0.1.0-draft.3` or new `0.1.0-draft.4`;
- exact CKB and OffCKB versions accepted by the current adapter;
- ckb-debugger `1.1.1` when requested, mandatory for every declared rejected transaction (Linux/x64 only);
- a required replay dependency list containing zero or more unique RFC dependency codes;
- `1..20` OffCKB development accounts;
- one signed transaction envelope per step;
- `expect.tx = "committed"` or `"rejected"`;
- optional `expect.error.code` for a rejected script;
- exact live-Cell count assertions targeting `{ step, index }`;
- draft.4 only: count 0/1, type builtin `dao`/`spore` plus `args_bytes`, data `min_bytes`, and separate `cell_deps.contains` **table** membership. Properties require count 1. See [bounds and semantics](docs/cell-claims-draft.4.md).

Unknown keys fail closed. A non-empty replay dependency list is accepted but makes the report explicitly `tainted`; it never silently claims stable replay. Script deployment declarations, balance/UDT assertions, script filters, cycle comparators, and multi-transaction steps remain RFC targets and are not silently accepted.

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
- requested and observed tool/runtime versions plus `package.json` and `bun.lock` hashes;
- CKB platform/architecture, pinned release asset/source, expected and observed archive SHA-256, and executed binary SHA-256;
- Git commit, dirty state, and deterministic dirty-tree digest;
- manifest hash, platform, genesis hash, and normalized OffCKB system scripts;
- structurally schema-validated and semantically verified `stable`/`tainted` replay qualification with structured reasons.

It emits two RFC-8785 canonical SHA-256 identities:

- **outcome digest**: declared claims and normalized observations, excluding raw transaction identity and runtime paths;
- **environment fingerprint**: the recorded manifest, source, toolchain, runtime, platform, genesis, and system-script environment.

The source guard compares Git-visible snapshots before setup and after the declared steps/assertions, before report construction; a mismatch prevents report publication. It covers tracked changes visible to Git and non-ignored untracked paths, contents, and Git-relevant modes. Symlinks are fingerprinted by their stored link text, not their referents. It does not continuously monitor execution: mutate-then-restore changes between snapshots, changes after the final snapshot, ignored files, and external inputs (including external symlink referents) are outside this guard. `stable` qualifies recorded inputs and the author's replay declaration, not hermetic execution. See the [source snapshot boundary](docs/evidence-report.md#source-snapshot-boundary).

The runner recomputes both embedded canonical objects before writing the report, checks cross-field provenance and replay-qualification semantics, checks that normalized evidence agrees with the embedded outcome claims, independently derives legacy Cell results from observation validity and counts, and draft.4 results from retained manifest/transaction/query inputs plus the declared type, length and dependency predicates, and verifies that the top-level verdict is the verdict derived from those claims. It scans the run evidence for the selected OffCKB development private keys with case-insensitive matching; any match is redacted and turns the run into an execution error. `report.json` is published only after that scan and devnet shutdown both succeed, so an execution or cleanup error leaves no valid verdict artifact. The temporary account file is removed when the devnet stops. Complete-artifact verification requires `verifyReport`; the schema-less `verifyEvidenceDigests` compatibility helper is v1-only. Report/outcome `/2` does not mean a full deep report schema or new verification CLI (#18). Known-key scanning does not detect arbitrary credentials. Raw signed inputs may be sensitive: do not redact and rehash them for publication. Offline verification establishes internal consistency, not authenticity; presence/membership/length is not protocol semantics or proof a script executed. Genesis is observed, not independently allowlisted.

## Trust and safety

`run` executes arbitrary repository code with the current user's permissions. The MVP is **not a security sandbox**. Use only trusted repositories on a disposable environment with no production wallets, SSH agents, cloud credentials, or unrelated secrets.

The producer receives a loopback node URL for queries, but the current feasibility implementation does not provide a network namespace or cryptographically enforce read-only access. Runner-owned submission is an architectural protocol for trusted code, not a containment boundary.

OffCKB `0.4.13` advertises the proxy through a loopback URL but its proxy process binds port `28114` on the wildcard interface. The adapter cannot narrow that inherited bind behavior. Run behind a host firewall or inside a disposable VM/container whose devnet ports are not reachable from untrusted networks.

See [`SECURITY.md`](SECURITY.md) before running or modifying CI execution.

## Repository map

- [`src/`](src/) — CLI, strict manifest parser, OffCKB adapter, runner, RPC boundary, and report canonicalization
- [`showcases/`](showcases/) — bounded, executable integrations built on the runner
- [`showcases/cell-properties/`](showcases/cell-properties/) — generic DAO/plain draft.4 matrix; native acceptance pending
- [`showcases/secp-transfer/`](showcases/secp-transfer/) — the first showcase: committed, rejected, and assertion-failure secp transfer paths
- [`tests/`](tests/) — unit and orchestration tests
- [`.github/workflows/verify.yml`](.github/workflows/verify.yml) — read-only CI for unit/docs checks and the fresh-devnet showcase
- [`showcases/secp-transfer/verify.sh`](showcases/secp-transfer/verify.sh) — real fresh-devnet acceptance, cleanup, and digest-stability harness
- [`docs/verify-toml-rfc-v0.2.md`](docs/verify-toml-rfc-v0.2.md) — broader draft vocabulary and report design
- [`docs/annotated-manifest.md`](docs/annotated-manifest.md) — legacy manifest walkthrough and the link to new draft.4 predicates
- [`docs/evidence-report.md`](docs/evidence-report.md) — current report contract, digest boundaries, and checked real output
- [`schemas/ckb-verify-provenance-v2.schema.json`](schemas/ckb-verify-provenance-v2.schema.json) — current provenance schema; cross-field replay and debugger consistency are enforced by the runtime verifier
- [`schemas/ckb-verify-provenance-v1.schema.json`](schemas/ckb-verify-provenance-v1.schema.json) — unchanged historical provenance schema
- [`docs/spark-proposal.md`](docs/spark-proposal.md) — Spark Program application material
- [`docs/design-review.md`](docs/design-review.md) — prior design review and gates

## Next conformance target

The current secp transfer is a runner-owned fixture proving the orchestration mechanics. A bounded, independently prepared CKB-UGMP Spore-mint adaptation is available in [PR #7](https://github.com/Akane-CN/spark-verify/pull/7). It remains outside `main` pending review and is technical feasibility evidence, not CKB-UGMP maintainer adoption, endorsement, or a funded deliverable already completed.

Relevant tracking issues:

- [#1 — committed/rejected transaction feasibility and two-hash replay](https://github.com/Akane-CN/spark-verify/issues/1)
- [#2 — OffCKB package boundary and built-in script references](https://github.com/Akane-CN/spark-verify/issues/2)
- [#3 — completed-project conformance example](https://github.com/Akane-CN/spark-verify/issues/3)

## License

[MIT](LICENSE)
