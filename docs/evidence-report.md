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

> **Current contract:** the unreleased runner emits `ckb-verify-report/1` with `ckb-verify-environment/3` environment fields. The nested [`ckb-verify-provenance/2` JSON Schema](../schemas/ckb-verify-provenance-v2.schema.json) validates structure; the runner's semantic verifier enforces cross-field replay status, reason, runtime, lockfile, source, and binary invariants. Both checks are required before trusting replay qualification. A complete report/manifest schema and compatibility fixtures remain v0.1 work.

The outer `ckb-verify-report/1` and `ckb-verify-outcome/1` contracts are unchanged. `verifyEvidenceDigests(report)` accepts only the current environment `/3` + provenance `/2` pair. The explicit option `{ allowLegacy: true }` additionally accepts exactly historical environment `/2` + provenance `/1`, applying the historical consistency checks without inventing debugger identity from current pins. Unknown or mixed pairs are rejected.

## Checked example

[`examples/secp-transfer-committed-report.json`](examples/secp-transfer-committed-report.json) is the complete report from a real fresh-devnet run of the committed secp transfer fixture. It is not hand-written sample output. Its historical environment `/2` + provenance `/1` bytes and v1 schema remain unchanged. The documentation test explicitly opts into legacy verification and retains its file-hash and source-manifest checks. This example is not evidence of the new debugger-integrity path.

- Generated on `2026-10-01` from clean source commit `2fd12ea291fba2c4c6f266934a29466df47265b0`.
- Report file SHA-256: `40f2c99e860e945119e2cd8037a1f908beee07a89d35a0ee0b72f95d84fe6c71`.
- Embedded outcome digest: `sha256:fe66eb2511d31ebf5a095e86bc315eeff0900d453d774627be0139d5821169f8`.
- Embedded environment fingerprint: `sha256:98737579275d690ddc8552867716ca49dec3a8bda598d479b24d0857cbcf2f38`.
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

The normalized claim/result layer identified by `ckb-verify-outcome/1`. It keeps only the declared expectations and normalized observations used to derive the verdict, including observed cycles and structured rejection data. A transaction that is accepted and later reaches terminal `rejected` status records `kind: "node"` and the node-provided `reason`; an immediate script rejection records its normalized script group and code when available.

For a Cell claim, the runner independently derives `observationValid` and verifies that `ok` agrees with the expected and observed count. It then derives the top-level verdict from all normalized claims rather than trusting a stored boolean.

### `environment`

The current replay-comparison layer is identified by `ckb-verify-environment/3`. It has six fixed top-level fields and no free-form extension keys:

- `runner`: the `ckb-verify` name and runner version;
- `toolchain`: requested and observed CKB, OffCKB, and optional ckb-debugger versions;
- `provenance`: source, manifest, lockfile, runtime, CKB and debugger binary identities, and replay qualification; validate its v2 schema and semantic consistency;
- `platform`: OS and architecture;
- `devnet`: network kind, genesis hash, and normalized OffCKB system-script identities and Cell dependencies;
- `schema`: the environment contract identifier.

`provenance.replay.status` is `stable` only when the manifest declares no replay dependencies, the recorded source revision is identifiable and clean, the Bun runtime is exactly pinned and matches the observed version, `package.json` and `bun.lock` are hashable, and the verified CKB archive provenance is internally consistent. Otherwise it is `tainted`, with structured environment- or outcome-scoped reasons. The runner also requires matching source snapshots as described below; a mismatch is an execution error, not a tainted verdict. Standard JSON Schema cannot portably compare arbitrary sibling values, so `verifyEvidenceDigests` invokes the semantic verifier before accepting the report even when its environment digest has been recomputed. A tainted run may still produce a `PASS` verdict for its declared claims; it must not be presented as clean replay evidence.

#### Debugger identity

Current provenance requires `binaries.ckbDebugger`: explicit `null` when unused, otherwise path-free `DebuggerBinaryEvidence`. Requested and observed debugger fields must appear together with that identity. The observed string must be exactly `ckb-debugger 1.1.1`; requested/binary versions must agree. The verifier checks the official source URL, Linux/x64 asset, and expected/observed archive and executable byte lengths and SHA-256 hashes against source-controlled pins. It compares the binary platform to the **recorded report platform**, not the verifier host. Script rejection requires this identity; all declared rejections require a pin in the manifest.

Missing identity, contradictory measurements, and unsupported selections are integrity errors even with recomputed digests or valid replay-taint reasons. They are not replay waivers. Offline verification checks internal consistency, not whether the recorded execution happened or whether an actively hostile same-UID writer changed bytes between measurement and execution.

#### Source snapshot boundary

The runner compares two Git-visible snapshots: one after loading the manifest but before creating runtime/evidence artifacts or starting the devnet, and one after the declared steps/assertions but before constructing the report. A difference in Git commit, dirty state, or dirty-tree digest fails closed without publishing `report.json`.

The dirty-tree digest covers Git status, the tracked binary diff against `HEAD`, and sorted non-ignored untracked entries with their repository-relative paths, content hashes, and Git-relevant modes (`100644`, `100755`, or `120000`). Symlinks contribute their stored link text rather than the contents of their referents; a tracked or non-ignored file inside the repository is still covered independently. The checkout's absolute root path is not added to the digest.

This is an endpoint comparison, not continuous monitoring or hermetic execution. It does not guarantee detection of changes made and restored between snapshots, changes after the final snapshot, ignored files, or external inputs such as environment variables, network responses, and external symlink referents. Matching clean snapshots can therefore still yield `stable` despite such changes. `stable` means stable under the recorded inputs and the author's replay declaration, not proof that every input remained unchanged throughout execution.

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

1. Confirm that `environment.provenance.source.gitCommit` is the commit under review and `dirty` is `false`, interpreting these fields within the [source snapshot boundary](#source-snapshot-boundary).
2. Run the semantic verifier, then confirm that `environment.provenance.replay.status` and every structured reason match the claimed replay boundary.
3. Confirm the requested and observed tools, runtime and lockfile hashes, CKB binary digests, platform, genesis, and system scripts.
4. Inspect each manifest claim and its corresponding normalized outcome.
5. Inspect raw rejection or Cell evidence where a result is security-sensitive.
6. Recompute the digests with the version of `ckb-verify` named by the report once the v0.1 verification command is released.
7. Treat a passing report as bounded acceptance evidence, never as an audit or proof that omitted properties are correct.

For the input side of the contract, continue with the [line-by-line annotated manifest](annotated-manifest.md).
