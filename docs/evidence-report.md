# Evidence report anatomy

`ckb-verify` separates the author's claim, raw observations, normalized comparison material, and environment provenance. The current feasibility runner writes a versioned JSON report and a short terminal summary; it does not require or provide a hosted dashboard.

```text
verify.toml + trusted producer
            |
            v
     fresh OffCKB devnet
            |
            v
 raw evidence + normalized claims + environment
            |
            v
 report.json + outcome digest + environment fingerprint
            |
            v
       terminal / CI summary
```

> **Current contract:** the unreleased runner emits `ckb-verify-report/1`. A stable JSON Schema has not been published yet. The implementation types and checked fixture below describe the present technical-preview format; schema stabilization and compatibility fixtures remain v0.1 work.

## Checked example

[`examples/secp-transfer-committed-report.json`](examples/secp-transfer-committed-report.json) is the complete report from a real fresh-devnet run of the committed secp transfer fixture. It is not hand-written sample output.

- Generated on `2026-09-08` from clean source commit `8be27c1fb8c880cd3acc01726d9895b258bfc7b6`.
- Report file SHA-256: `95c87133d477bb9bb9f0176d3f7f96bb9db87de849e608a1d8d361a2af0b14a6`.
- Embedded outcome digest: `sha256:fe66eb2511d31ebf5a095e86bc315eeff0900d453d774627be0139d5821169f8`.
- Embedded environment fingerprint: `sha256:7313f0dbab1e1d3611c070cef0202c303a518195bf013c67bdad4b016e68e7ab`.
- The runner's development-account secret scan completed before the report was published.
- A repository test rejects common token/PEM markers and private-key field names, verifies the clean source revision and source-manifest hash, and recomputes both embedded digests.

Verify the checked example with:

```bash
bun test tests/documentation-evidence.test.ts
```

## Top-level fields

The complete shape is:

```text
schema
verdict
createdAt
evidence
outcomeClaims
environment
digests.outcome
digests.environment
```

### `schema`

`ckb-verify-report/1` identifies the current report envelope. It is versioned separately from the selected `verify.toml` spec and the nested outcome/environment objects.

### `verdict`

A published report currently contains `PASS` or `FAIL`:

- `PASS` means all and only the declared claims passed in the recorded environment.
- `FAIL` means execution completed, but at least one declared claim did not match.
- An execution, evidence-integrity, secret-scan, or cleanup error exits with code `2` and does not publish a valid report.

The verdict does not mean the manifest is complete, the producer is safe, or a script has been audited.

### `createdAt`

UTC timestamp for report creation. It is display/provenance metadata and is excluded from both canonical digests.

### `evidence`

The detailed observation layer. For each step it can record:

- expected and observed transaction status;
- transaction hash, execution duration, and observed cycles;
- structured rejection evidence when applicable;
- each declared Cell claim with expected and observed values;
- the RPC material used to derive the observation.

Raw transaction identity, duration, and full RPC observations remain inspectable here, but are deliberately excluded from the normalized outcome digest.

### `outcomeClaims`

The normalized claim/result layer identified by `ckb-verify-outcome/1`. It keeps only the declared expectations and normalized observations used to derive the verdict, including observed cycles and structured script rejection data when present.

For a Cell claim, the runner independently derives `observationValid` and verifies that `ok` agrees with the expected and observed count. It then derives the top-level verdict from all normalized claims rather than trusting a stored boolean.

### `environment`

The replay-comparison layer identified by `ckb-verify-environment/1`. The current report records:

- runner version;
- requested and observed tool versions;
- manifest SHA-256;
- Git commit, dirty state, and dirty-tree digest when applicable;
- OS and architecture;
- local-chain genesis hash;
- normalized OffCKB system-script identities and Cell dependencies.

The manifest currently must declare `[replay].dependencies = []`, but the feasibility report does not yet emit the broader draft RFC's replay-status object. Explicit replay qualification for non-empty dependencies remains v0.1 work.

### `digests.outcome`

SHA-256 of the RFC-8785-canonicalized `outcomeClaims` object. It answers:

> Did two runs produce the same normalized outcome evidence?

It excludes transaction hashes, runtime duration, raw RPC responses, absolute paths, report timestamp, and environment metadata. It is a comparison identity, not proof of determinism.

### `digests.environment`

SHA-256 of the RFC-8785-canonicalized `environment` object. It answers:

> Were the recorded source, manifest, toolchain, platform, genesis, and system-script inputs identical?

Equal outcome digests do not imply equal environments. A reviewer should compare both values and inspect the underlying fields before drawing a replay conclusion.

## Terminal and CI presentation

A successful command prints only the decision and pointers needed for review:

```text
PASS: All declared claims passed in the recorded environment.
report: <run-directory>/report.json
outcome: sha256:<64 lowercase hex characters>
environment: sha256:<64 lowercase hex characters>
```

This is intentionally not the authority. The report is the reviewable artifact; the terminal line is a concise index into it. CI should preserve the report directory as an artifact when the workflow is intended to publish evidence.

## What a reviewer should check

1. Confirm that `sourceRevision.gitCommit` is the commit under review and `dirty` is `false`.
2. Confirm the requested and observed tool versions, platform, genesis, and system scripts.
3. Inspect each manifest claim and its corresponding normalized outcome.
4. Inspect raw rejection or Cell evidence where a result is security-sensitive.
5. Recompute the digests with the version of `ckb-verify` named by the report once the v0.1 verification command is released.
6. Treat a passing report as bounded acceptance evidence, never as an audit or proof that omitted properties are correct.

For the input side of the contract, continue with the [line-by-line annotated manifest](annotated-manifest.md).
