# Generic DAO-deposit Cell-property fixture

Repository-owned fixture for [draft.4 Cell claims](../../docs/cell-claims-draft.4.md), **not NervDAO adoption**, endorsement, a full DApp test, or a protocol decoder. It uses the existing `@ckb-ccc/core@1.14.0`, OffCKB `0.4.13`, and CKB `0.209.0` without new dependencies, builds, or script deployments.

## Producer

`produce.ts dao` constructs output zero with 200 CKB, the development signer's lock, `Script.fromKnownScript(client, KnownScript.NervosDao, "0x")`, and eight zero data bytes. It adds the exported DAO dependencies, completes capacity and fees at explicit `1_000n`, signs, then atomically writes a private protocol-1 JSON-RPC envelope to `CKB_VERIFY_RESULT`. It never broadcasts. Known-script identities (including secp/ACP needed by CCC signing) come from `CKB_VERIFY_CONTEXT`, normalized from the fresh OffCKB export.

`produce.ts plain` follows the existing secp transfer sequence: 100 CKB to the second account, no type, empty data, no DAO deps. Both modes require runner context and a mode-0600 account file. Errors do not render private account material. The runner owns account cleanup and submission; the trusted producer boundary is not a hostile-code sandbox.

## Expected cases

Every manifest keeps `expect.tx = "committed"`; no debugger pin is added for assertion failures.

| Manifest | Mode | Declared difference from positive | Expected CLI |
| --- | --- | --- | --- |
| [`verify.committed.toml`](verify.committed.toml) | dao | Count 1, type dao/args 0, data minimum 1, DAO deps; run twice fresh | PASS / 0 |
| [`verify.wrong-type.toml`](verify.wrong-type.toml) | dao | Only expected builtin becomes spore; args stays 0 | FAIL / 1: code/hash identity mismatch |
| [`verify.wrong-data.toml`](verify.wrong-data.toml) | dao | Only minimum becomes 9; actual remains eight bytes | FAIL / 1: data length |
| [`verify.missing-dep.toml`](verify.missing-dep.toml) | plain | Count 1 plus DAO deps only; no type/data predicates | FAIL / 1: missing DAO dependency |
| [`verify.ordinary-cell.toml`](verify.ordinary-cell.toml) | plain | Full positive DAO conjunction retained | FAIL / 1: type, data and deps; count succeeds |
| [`verify.wrong-args.toml`](verify.wrong-args.toml) | dao | Only expected DAO args length becomes 1; actual empty | FAIL / 1: args length |

Missing-dep is a valid ordinary transfer, **not** an invalid DAO transaction with its required dep removed. Unexpected script rejection without a debugger pin is `NO_VERDICT` and blocks the gate.

## Run and inspect

On a clean trusted Linux/x64 checkout with Bun `1.2.19` and a compatible Node runtime:

```bash
bun run showcase:cell-properties
```

The named wrapper bounds each CLI run, executes the six cases plus a fresh committed repeat sequentially, checks exact exits/verdicts and the actual intended failing predicates, and loads **every complete canonical saved report** with `verifyReport`, including valid FAIL artifacts. It checks account/pending-report absence and IPv4/IPv6 ports independently even after a secondary audit error. It does not kill foreign listeners. The CI job is bounded and preserves the existing jobs. After a successful run it packages only the canonical `report.json` files (never step output, account files, or pending reports) into a checksummed evidence bundle that the `verify-evidence` job downloads and checks with `ckb-verify check-bundle`; see [offline verification](../../docs/offline-verification.md#evidence-bundles).

The repeat requires equal outcome digests and equal non-devnet provenance. If raw genesis/deployment bindings repeat, environment fingerprints must also match. Otherwise it prints and retains both real bindings and fingerprints as `recorded-devnet-difference`, not an equal-environment claim. It never scrubs or rehashes published reports. Each actual report remains beneath the printed `.ckb-verify/runs/.../report.json` path.

`PASS` means exactly: **All declared claims passed in the recorded environment.** The wrapper's additional raw capacity/data checks are external fixture checks; they do not expand the manifest's predicates or outcome digest.

## Evidence status and limits

**Native acceptance: NOT_RUN in the initial offline Phase B implementation.** Unit tests use pure CCC construction/signing with synthetic funding data and explicitly synthetic wrapper reports, plus inert refusal-only entrypoint controls. None is CKB execution evidence. Fresh DAO acceptance/repeat, legacy lifecycle regression, independent SPEC/QUALITY review and parent acceptance must run against the later clean checkpoint. Stop and retain a blocker if real creation fails.

Presence, byte length and dependency membership are not full protocol semantics or proof that a script executed. Offline verification proves internal consistency, not authenticity. Genesis is recorded but not independently allowlisted. Raw signed evidence may be sensitive; the scanner only knows selected development keys, not arbitrary credentials. No redact-and-rehash publication, public release, adoption claim or artifact upload is authorized here. Read [SECURITY.md](../../SECURITY.md) and [report anatomy](../../docs/evidence-report.md).
