# Version policy

`ckb-verify` carries several independent version identifiers. Each one names a contract, changes for its own reasons, and is checked explicitly; nothing is inferred from another identifier or migrated silently. This page is the written policy behind the compatibility table in [offline verification](offline-verification.md#version-compatibility).

## The identifiers

| Identifier | Where | Current | Names |
| --- | --- | --- | --- |
| Manifest spec | `meta.spec` in `verify.toml` | `0.1.0` (frozen), `0.1.0-draft.5` (the same grammar), `0.1.0-draft.4`, `0.1.0-draft.3` | the grammar and claim vocabulary the author wrote against |
| Report envelope | `schema` in `report.json` | `ckb-verify-report/1` (draft.3), `ckb-verify-report/2` (draft.4), `ckb-verify-report/3` (`0.1.0` and draft.5) | the top-level artifact layout and which verifier branch applies |
| Outcome claims | `outcomeClaims.schema` | `ckb-verify-outcome/1`, `ckb-verify-outcome/2`, `ckb-verify-outcome/3` | the normalized object whose RFC 8785 hash is the outcome digest |
| Environment | `environment.schema` | `ckb-verify-environment/3`, `ckb-verify-environment/4` (`0.1.0` and draft.5: adds the exported accounts) (historical `/2`) | the object whose hash is the environment fingerprint |
| Provenance | `environment.provenance.schema` | `ckb-verify-provenance/2`, `ckb-verify-provenance/3` (`0.1.0` and draft.5: adds the tool-version drift record) (historical `/1`) | source, runtime, lockfile, binary, and replay provenance inside the environment |
| Evidence bundle | `bundle.json` `schema` | `ckb-verify-evidence-bundle/1` | the CI bundle layout and its checksum manifest |
| Runner | `ckb-verify --version`, `environment.runner.version`, `package.json` | `0.0.2` (unreleased, private) | the code that produced or verified an artifact |
| Producer result | `protocol` in the file written to `CKB_VERIFY_RESULT` | `1` | the envelope a step command hands to the runner |

The manifest spec is chosen by the author; every other identifier is written by the runner and read back by the verifier. The runner version is never a substitute for a schema identifier: two runner versions may write the same schemas, and one runner version reads several.

## Accepted tuples

A report is accepted only as a whole tuple. The verifier does not accept a report whose nested identifiers disagree with its envelope, however plausible the content.

| Report | Outcome | Specs (`evidence.spec`, `outcomeClaims.spec`) | Environment | Provenance | Accepted by |
| --- | --- | --- | --- | --- | --- |
| `report/3` | `outcome/3` | both `0.1.0`, or both `0.1.0-draft.5` | `environment/4` | `provenance/3` | current runner, `digest`, `check-digest`, `check-bundle` |
| `report/2` | `outcome/2` | both `0.1.0-draft.4` | `environment/3` | `provenance/2` | current runner, `digest`, `check-digest`, `check-bundle` |
| `report/1` | `outcome/1` | both `0.1.0-draft.3` | `environment/3` | `provenance/2` | current runner, `digest`, `check-digest`, `check-bundle` |
| `report/1` | `outcome/1` | both `0.1.0-draft.3` | `environment/2` | `provenance/1` | historical only: `digest`/`check-digest` with `--allow-legacy`; never written any more; gains no debugger-identity guarantee |
| anything else | | | | | rejected as `unsupported …`, exit `1` |

Legacy acceptance is an explicit reader opt-in and never widens what `report/2` accepts. The evidence packager refuses legacy reports, so CI bundles always carry current tuples.

## What changes a version

- **Manifest spec**: any change to the grammar that a strict parser can observe — a new key, a changed bound, a new claim kind, a changed default. A new spec string is a separate explicit choice by the author; an existing spec string keeps its grammar forever. Draft specs (`-draft.N`) may be retired after the first release, with the retirement announced one minor release ahead and the fixtures retained as long as the verifier still reads them.
- **Report, outcome, environment, provenance**: any change to the set of fields, their meaning, or the normalization that feeds a digest. Adding a field that is included in a digest is a new version, because older verifiers would recompute a different hash; adding a field outside both digests is also a new version, because the published schema rejects unknown fields. A renamed or re-typed field is a new version. Versions are integers; there are no minor variants.
- **Evidence bundle**: any change to the file allowlist, the manifest fields, or the checksum format.
- **Runner**: semantic versioning of the package. Patch releases never change any schema or spec; they fix behaviour within existing contracts. A minor release may add a spec or schema version and must keep reading the previous one. A major release may stop reading a schema version, with the deprecation announced in `CHANGELOG.md` at least one minor release ahead.
- **Producer protocol**: a new integer when the envelope shape changes; the runner rejects unknown protocol numbers.

## Reading and writing rules

- The runner **writes** exactly one tuple per manifest spec: draft.3 → report/1 and draft.4 → report/2, both with environment/3 + provenance/2; `0.1.0` and draft.5 → report/3 with environment/4 + provenance/3, recording the manifest's own identifier in `evidence.spec` and `outcomeClaims.spec`. It never writes historical tuples.
- A verifier **reads** every tuple listed as accepted and nothing else. Unsupported, missing, mixed, or inferred-from-content versions fail closed with an explicit message naming the identifier; a report is never reinterpreted under a different version to make it pass.
- There is **no automatic migration** of manifests or reports. A manifest written for a retired spec is rejected by `validate` with the exact spec string; a report of a retired version is rejected by `digest` as unsupported, and the previous runner release remains the way to read it. A migration tool, if one is ever written, produces a new artifact with new digests; it never rewrites hashes inside an existing one.
- Digest comparison across versions is undefined: an outcome digest from `outcome/1` and one from `outcome/2` are different objects and must not be compared, even for the same manifest. Repeatability claims are made within one tuple.
- The published JSON Schemas are versioned with the identifiers they validate; `schemas/ckb-verify-report.schema.json` covers every accepted report tuple and is extended, not replaced, when a tuple is added.

## The frozen v0.1 contract

The proposal's first deliverable is a frozen `verify.toml` v0.1 contract. It is this tuple:

| Identifier | Frozen value |
| --- | --- |
| Manifest spec | `0.1.0` (the [v0.1 vocabulary](vocabulary-v0.1.md); the same grammar as `0.1.0-draft.5`) |
| Report, outcome, environment, provenance | `ckb-verify-report/3`, `ckb-verify-outcome/3`, `ckb-verify-environment/4`, `ckb-verify-provenance/3` |
| Evidence bundle, producer protocol | `ckb-verify-evidence-bundle/1`, protocol `1` |

**Frozen means:** none of these identifiers will ever accept, reject, or normalize anything differently than it does today. A change to the grammar, a claim's meaning, a schema field, or a digest's normalization gets a new identifier under the rules above, and the frozen ones keep being read. Fixes that change no observable behaviour remain possible; a fix that changes what a frozen identifier accepts is a new identifier, not a fix.

The RFC is broader than the contract on purpose. The proposal asked to "reconcile the draft RFC with the deliberately smaller implemented subset", and the RFC sections deferred by [release decisions 2–4](release-decisions.md) (`[setup.scripts]`, pure steps, `expect.error.group`) stay drafts for a later spec. They are not part of `0.1.0` and will never be added to it.

**How it is checked.** `tests/frozen-contract.test.ts` runs in `bun run check`, in CI, and in the [platform boundary](../.github/workflows/platform-boundary.yml) jobs, against `tests/fixtures/frozen-v0.1/lock.json`:

- the parts of the published schemas the v0.1 tuple uses (the manifest schema's common properties and its `0.1.0` branch, the `report/3` branch, the claims-v3 and provenance-v3 schemas) are pinned by RFC 8785 digest, so adding another spec or tuple to a shared schema file leaves the lock untouched while any edit to a frozen part fails;
- the committed golden report `tests/fixtures/frozen-v0.1/report.json` (synthetic, spec `0.1.0`) must re-verify offline with its locked outcome and environment digests, so a change to derivation or normalization fails;
- every draft.5 conformance fixture, valid and invalid, must parse and fail identically under `0.1.0`, in the parser and the schema, so the two identifiers cannot drift apart.

`lock.json` is never edited to make a change pass.

**Relationship to the drafts.** `0.1.0-draft.5` stays readable and writable with exactly the `0.1.0` grammar; a report records which of the two identifiers its manifest used, so their outcome digests differ even for the same claims and are not compared (see above). `0.1.0-draft.3` and `0.1.0-draft.4` keep their own grammars and tuples. Draft identifiers may be retired after the first release as described above; `0.1.0` is not a draft: it is read by every `v0.1.x` runner, and only a major release may stop reading it, under the runner rule above.

## Fixtures that pin the policy

- `docs/examples/secp-transfer-committed-report.json` is the retained historical `report/1` + `environment/2` + `provenance/1` artifact; `tests/documentation-evidence.test.ts` verifies it with the legacy opt-in and its exact file hash.
- `tests/fixtures/claims-v2/synthetic.ts` is the synthetic `report/2` artifact used by the verifier, schema, and bundle tests.
- `tests/fixtures/claims-v3/synthetic.ts` builds the synthetic `report/3` artifact under either `0.1.0` or `0.1.0-draft.5`; `tests/fixtures/frozen-v0.1/` holds the golden `0.1.0` report and the lock described above.
- `tests/fixtures/conformance/manifests/` holds the manifest fixtures for every spec, including the `0.1.0` twin of the draft.5 vocabulary fixture.
- Real acceptance records under `docs/acceptance/` name the runner version and source commit that produced them.

## Decisions recorded (#18)

[Release decision 6](release-decisions.md#6-spec-naming-at-release-draft-identifiers-stay), reopened on 2026-11-02 ([entry](release-decisions.md#2026-11-02-decision-6-reopened-the-v01-contract-is-frozen-as-spec-010)): at `v0.1.0` the manifest spec identifiers are `0.1.0` (frozen, as above), `0.1.0-draft.5`, `0.1.0-draft.4`, and `0.1.0-draft.3`, all read and written as in the tables above. `0.1.0-draft.3` is retained through `v0.1.x`; its retirement, if any, is announced one minor release ahead and report `/1` keeps being written for draft.3 manifests until then.
