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

> **Current contract:** the unreleased runner emits `ckb-verify-report/1` for draft.3 and `ckb-verify-report/2` for draft.4, both with `ckb-verify-environment/3` environment fields. The nested [`ckb-verify-provenance/2` JSON Schema](../schemas/ckb-verify-provenance-v2.schema.json) validates structure; the runner's semantic verifier enforces cross-field replay status, reason, runtime, lockfile, source, and binary invariants. Both checks are required before trusting replay qualification. Bounded claims-v2 compatibility fixtures exist; a complete report/manifest schema and public verifier remain #18 work. See the [draft.4 grammar and scope](cell-claims-draft.4.md).

## Verifier entrypoints and compatibility

Use `verifyReport(report, options)` from `src/report.ts` when reading a **complete artifact**, including before runner publication and in both showcase post-checks. Its input is `unknown`. It requires an explicit own top-level `schema` equal to `ckb-verify-report/1` or `ckb-verify-report/2`; missing, inherited, `undefined`, `null`, unknown, or other envelope versions raise `EvidenceIntegrityError`. It does not infer a version from the nested objects or fall back to another evaluator.

Both entrypoints support exactly these v1 tuples:

- `ckb-verify-outcome/1`, **both** `evidence.spec` and `outcomeClaims.spec` equal to `0.1.0-draft.3`, environment `ckb-verify-environment/3`, and provenance `ckb-verify-provenance/2`.
- With explicit `{ allowLegacy: true }` only: the same outcome/specs with historical environment `ckb-verify-environment/2` and provenance `ckb-verify-provenance/1`. Historical consistency checks apply without inventing debugger identity from current pins.

Only `verifyReport` additionally accepts report `/2`, outcome `ckb-verify-outcome/2`, **both** specs `0.1.0-draft.4`, environment `/3`, and provenance `/2`. Missing, unknown, and mixed versions/specs are rejected, even after a TypeScript cast or recomputation of stored hashes. Legacy opt-in never enables a historical environment for report `/2`.

`verifyEvidenceDigests(components, options)` remains a **v1-only component compatibility helper** with its existing verdict/evidence/outcome/environment/digest inputs. Only this helper permits omission of the top-level schema. If an own `schema` property is supplied, it must be exactly `ckb-verify-report/1`; a present `undefined`, `null`, or other value is not omission. The same nested version/spec guards and legacy opt-in apply to schema-less components. Do not use this omission allowance when reading a complete report.

Before v1 normalization and verdict derivation, both entrypoints exclude these semantic markers in their specific slots:

- `evidence.manifestText` and `evidence.steps[].transaction`;
- any immediate or final claim in evidence or outcome with `kind` other than `cell`, or with `input`;
- claim `expected.type`, `expected.data`, or `expected.contains`;
- claim `observed.state`, `observed.status`, `observed.type`, `observed.dataBytes`, or `observed.present`;
- evidence-claim-level `observationValid` (the existing **outcome** `observationValid` is preserved).

This is a finite exclusion, not a recursive field blacklist. Arbitrarily nested `claim.evidence` diagnostics may contain historical RPC fields such as `type`, `data`, and `status`. Existing v1 count semantics, including counts greater than one, are unchanged; these guards do not implement new script/data, CellDep, byte-size, or count-0/1 rules.

These APIs provide version and semantic checks, **not a complete deep structural schema** for the report. For v1, after the guards, verification recomputes both digests, normalizes retained evidence again, checks claim-count/`ok` agreement, validates provenance/debugger consistency, and derives the verdict. This establishes internal consistency, not execution authenticity: a consistently rewritten report is not a signed attestation that the recorded run happened. The entrypoints are source APIs, not a public verification CLI; their unit tests and historical sample readback do not constitute fresh real-devnet acceptance.

## Draft.4 core semantic inputs

The private `0.0.2` core adds output type identity plus args byte length, decoded data minimum byte length, and separate transaction CellDep membership. Builtin names are exactly `dao` and `spore`. Properties require count 1; draft.4 count is 0 or 1 and the output index is u32. Args/data sizes are bounded by `MAX_BYTES = 1048576`, a runner resource policy, not consensus. There are no raw pins, custom aliases, exact-content predicates, decoders, or plugins.

Report `/2` retains exact UTF-8 `evidence.manifestText` and every full signed producer `evidence.steps[].transaction`, including witnesses and steps without claims. Cell claims retain either `{kind:"missing-output"}` or `{kind:"query",outPoint:{tx_hash,index},response:...}` in `input`. CellDep claims derive from the retained transaction and referenced environment binding without a duplicate dependency list. Verification does not read sibling files.

The pure `deriveOutcomeV2(evidence, environment)` seam parses and hashes the manifest, binds its name/spec, **complete ordered** steps and expectations/claims, exact requested toolchain (including optional absence), and ordered replay declarations. Existing provenance checks still apply. It recomputes raw transaction hashes and validates the new semantic closure: outputs/data alignment, exact scripts/outputs/dependencies, referenced nonempty bindings, and full supported live/non-live responses. A live response must match the selected retained output/data and a committed target; only omitted/null type equivalence is allowed. Data hashes use CKB's zero sentinel for empty data and pinned CCC hashing otherwise.

An absent output is an invalid observation and fails even count 0, without RPC. In-range dead/unknown is a valid count-0 observation, even for a rejected candidate; it does not imply an output ever existed on-chain. Properties require live data. Sibling claims share one snapshot per phase/step/index; later steps and final assertions resample. Every declared claim remains ordered and conjunctive, including repeats and claims after a mismatch. Malformed evidence aborts rather than becoming a mismatch.

A matching type normalizes to the **claimed** builtin identity plus measured args length; a mismatching type retains its actual raw code hash/hash type, and a missing type is null. Data observations retain measured byte length only when declared. Dependency observations retain one membership boolean for each exported alias member, in export order; all must be present. Duplicate concrete deps or empty bindings are errors; extra distinct transaction deps are allowed. Rejected transactions can satisfy membership, which neither implies commitment nor script execution.

Report `/2` verification independently rederives stored observations, validity, truth, the complete outcome, verdict and both canonical digests. Valid FAIL reports verify. Outcome `/2` retains names/spec, all ordered steps, statuses, expectations, cycles/rejections and normalized claims, but excludes manifest text, transactions, queries, paths, timestamps and durations. Consistent deployment remaps can preserve outcome but change environment; same-length args/data variations intentionally preserve the length-only projection. Witnesses are excluded by the raw transaction hash primitive; no signature authenticity is asserted.

The [claims-v2 schema fragment](../schemas/ckb-verify-claims-v2.schema.json) provides bounded exact `$defs` for these containers and semantic inputs. Consumers select a definition; its root deliberately is not a whole-report validator. Dev-only Ajv parity tests cover shapes; schema validation alone does not prove hashes, alignment, membership or truth. Complete report/manifest schemas and offline public commands remain #18 work.

Retained manifest/transaction/witness bytes may be sensitive. A known exported development key in the pending report causes NO_VERDICT: cleanup still runs and neither pending nor canonical report survives. Hash-bound inputs must not be redacted/rehashed and then published. The existing scanner only knows exported development keys, not arbitrary credentials.

Offline verification establishes **internal consistency**, not authentic RPC observations, deployment provenance, signatures, block inclusion/finality, or proof a type/dep executed. All-consistent rewrites remain possible. The claims-v2 unit fixtures are explicitly synthetic. The [generic DAO/plain showcase](../showcases/cell-properties/README.md) now supplies the planned six-case real-run entrypoint, but fresh DAO acceptance, legacy secp lifecycle regression, separate Spore feasibility, hosted artifacts and installed-consumer acceptance are **not demonstrated by the initial offline Phase B implementation**. No new real report or converted legacy sample is bundled.

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

`ckb-verify-report/1` identifies the draft.3 envelope; `ckb-verify-report/2` identifies the draft.4 envelope. It is versioned separately from the selected `verify.toml` spec and the nested outcome/environment objects.

### `verdict`

A published report currently contains `PASS` or `FAIL`:

- `PASS` means exactly: **All declared claims passed in the recorded environment.**
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

The normalized claim/result layer is identified by `ckb-verify-outcome/1` for draft.3 and `ckb-verify-outcome/2` for draft.4. It keeps only the declared expectations and normalized observations used to derive the verdict, including observed cycles and structured rejection data. A transaction that is accepted and later reaches terminal `rejected` status records `kind: "node"` and the node-provided `reason`; an immediate script rejection records its normalized script group and code when available.

For a v1 Cell claim, the runner independently derives `observationValid` and verifies that `ok` agrees with the expected and observed count. The v2 branch uses the raw-input and property/dependency derivation described above. It then derives the top-level verdict from all normalized claims rather than trusting a stored boolean.

### `environment`

The current replay-comparison layer is identified by `ckb-verify-environment/3`. It has six fixed top-level fields and no free-form extension keys:

- `runner`: the `ckb-verify` name and runner version;
- `toolchain`: requested and observed CKB, OffCKB, and optional ckb-debugger versions;
- `provenance`: source, manifest, lockfile, runtime, CKB and debugger binary identities, and replay qualification; validate its v2 schema and semantic consistency;
- `platform`: OS and architecture;
- `devnet`: network kind, genesis hash, and normalized OffCKB system-script identities and Cell dependencies;
- `schema`: the environment contract identifier.

`provenance.replay.status` is `stable` only when the manifest declares no replay dependencies, the recorded source revision is identifiable and clean, the Bun runtime is exactly pinned and matches the observed version, `package.json` and `bun.lock` are hashable, and the verified CKB archive provenance is internally consistent. Otherwise it is `tainted`, with structured environment- or outcome-scoped reasons. The runner also requires matching source snapshots as described below; a mismatch is an execution error, not a tainted verdict. Standard JSON Schema cannot portably compare arbitrary sibling values, so `verifyReport` invokes the semantic verifier before accepting the complete artifact even when its environment digest has been recomputed. A tainted run may still produce a `PASS` verdict for its declared claims; it must not be presented as clean replay evidence.

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

Equal outcome digests do not imply equal environments. A reviewer should compare both values and inspect the underlying fields before drawing a replay conclusion. The Cell-property wrapper requires equal outcomes and unchanged non-devnet provenance; it requires equal environment fingerprints when raw provenance repeats. Differing genesis/deployment bindings are retained and printed as `recorded-devnet-difference`, never erased or rehashed to force equality. Genesis is observed, not independently allowlisted.

## Terminal and CI presentation

A successful command prints only the decision and pointers needed for review:

```text
PASS: All declared claims passed in the recorded environment.
report: <run-directory>/report.json
outcome: sha256:<64 lowercase hex characters>
environment: sha256:<64 lowercase hex characters>
```

This is intentionally not the authority. The report is the reviewable artifact; the terminal line is a concise index into it. The added named CI job executes the matrix without artifact upload. Publishing selected evidence and downloading/verifying the exact hosted artifact remains separate #19 work; a green job is not preserved evidence.

## What a reviewer should check

1. Confirm that `environment.provenance.source.gitCommit` is the commit under review and `dirty` is `false`, interpreting these fields within the [source snapshot boundary](#source-snapshot-boundary).
2. Run the semantic verifier, then confirm that `environment.provenance.replay.status` and every structured reason match the claimed replay boundary.
3. Confirm the requested and observed tools, runtime and lockfile hashes, CKB binary digests, platform, genesis, and system scripts.
4. Inspect each manifest claim and its corresponding normalized outcome.
5. Inspect raw rejection or Cell evidence where a result is security-sensitive.
6. Recompute the digests with the version of `ckb-verify` named by the report once the v0.1 verification command is released.
7. Treat a passing report as bounded acceptance evidence, never as an audit or proof that omitted properties are correct.

For the input side of the contract, continue with the [line-by-line annotated manifest](annotated-manifest.md).
