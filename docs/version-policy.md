# Version policy

`ckb-verify` carries several independent version identifiers. Each one names a contract, changes for its own reasons, and is checked explicitly; nothing is inferred from another identifier or migrated silently. This page is the written policy behind the compatibility table in [offline verification](offline-verification.md#version-compatibility).

## The identifiers

| Identifier | Where | Current | Names |
| --- | --- | --- | --- |
| Manifest spec | `meta.spec` in `verify.toml` | `0.1.0-draft.3`, `0.1.0-draft.4` | the grammar and claim vocabulary the author wrote against |
| Report envelope | `schema` in `report.json` | `ckb-verify-report/1` (draft.3), `ckb-verify-report/2` (draft.4) | the top-level artifact layout and which verifier branch applies |
| Outcome claims | `outcomeClaims.schema` | `ckb-verify-outcome/1`, `ckb-verify-outcome/2` | the normalized object whose RFC 8785 hash is the outcome digest |
| Environment | `environment.schema` | `ckb-verify-environment/3` (historical `/2`) | the object whose hash is the environment fingerprint |
| Provenance | `environment.provenance.schema` | `ckb-verify-provenance/2` (historical `/1`) | source, runtime, lockfile, binary, and replay provenance inside the environment |
| Evidence bundle | `bundle.json` `schema` | `ckb-verify-evidence-bundle/1` | the CI bundle layout and its checksum manifest |
| Runner | `ckb-verify --version`, `environment.runner.version`, `package.json` | `0.0.2` (unreleased, private) | the code that produced or verified an artifact |
| Producer result | `protocol` in the file written to `CKB_VERIFY_RESULT` | `1` | the envelope a step command hands to the runner |

The manifest spec is chosen by the author; every other identifier is written by the runner and read back by the verifier. The runner version is never a substitute for a schema identifier: two runner versions may write the same schemas, and one runner version reads several.

## Accepted tuples

A report is accepted only as a whole tuple. The verifier does not accept a report whose nested identifiers disagree with its envelope, however plausible the content.

| Report | Outcome | Specs (`evidence.spec`, `outcomeClaims.spec`) | Environment | Provenance | Accepted by |
| --- | --- | --- | --- | --- | --- |
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

- The runner **writes** exactly one tuple per manifest spec: draft.3 → report/1, draft.4 → report/2, both with environment/3 + provenance/2. It never writes historical tuples.
- A verifier **reads** every tuple listed as accepted and nothing else. Unsupported, missing, mixed, or inferred-from-content versions fail closed with an explicit message naming the identifier; a report is never reinterpreted under a different version to make it pass.
- There is **no automatic migration** of manifests or reports. A manifest written for a retired spec is rejected by `validate` with the exact spec string; a report of a retired version is rejected by `digest` as unsupported, and the previous runner release remains the way to read it. A migration tool, if one is ever written, produces a new artifact with new digests; it never rewrites hashes inside an existing one.
- Digest comparison across versions is undefined: an outcome digest from `outcome/1` and one from `outcome/2` are different objects and must not be compared, even for the same manifest. Repeatability claims are made within one tuple.
- The published JSON Schemas are versioned with the identifiers they validate; `schemas/ckb-verify-report.schema.json` covers every accepted report tuple and is extended, not replaced, when a tuple is added.

## Fixtures that pin the policy

- `docs/examples/secp-transfer-committed-report.json` is the retained historical `report/1` + `environment/2` + `provenance/1` artifact; `tests/documentation-evidence.test.ts` verifies it with the legacy opt-in and its exact file hash.
- `tests/fixtures/claims-v2/synthetic.ts` is the synthetic `report/2` artifact used by the verifier, schema, and bundle tests.
- `tests/fixtures/conformance/manifests/` holds the manifest fixtures for both specs.
- Real acceptance records under `docs/acceptance/` name the runner version and source commit that produced them.

## Decisions recorded (#18)

[Release decision 6](release-decisions.md#6-spec-naming-at-release-draft-identifiers-stay): at `v0.1.0` the manifest spec identifiers are `0.1.0-draft.3` and `0.1.0-draft.4`, both read and written as in the tables above, and no `0.1.0` spec string is introduced. `0.1.0-draft.3` is retained through `v0.1.x`; its retirement, if any, is announced one minor release ahead and report `/1` keeps being written for draft.3 manifests until then. A `0.1.0` spec string is reserved for the first grammar freeze after the v0.3 proposals are settled.
