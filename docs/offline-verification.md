# Offline verification

`ckb-verify validate`, `ckb-verify digest`, and `ckb-verify check-digest` let a consumer who only holds a manifest or a report check it without starting OffCKB, executing any producer command, installing tools, opening listeners, or using the network. They run the **same** strict grammar and the **same** semantic verifier the runner uses before it publishes a report; they do not add a second, weaker checker.

| Command | Input | Checks | Exit `0` means |
| --- | --- | --- | --- |
| `validate [manifest]` | `verify.toml` (default) | strict TOML grammar, unknown keys, selectors, timeouts, spec/toolchain rules | the manifest parses; nothing was executed |
| `digest <report.json>` | a complete saved report | structure, version tuple, provenance/replay invariants, re-derived claims, verdict, both canonical digests | the report is internally consistent |
| `check-digest <report.json> --outcome … [--environment …]` | a report plus expected digests | everything `digest` checks, then compares the **re-derived** digests with the supplied values | consistent **and** every supplied digest matched |
| `check-bundle <dir>` | a downloaded evidence bundle | file allowlist, `SHA256SUMS`, every listed report's checksum and digests, source binding | every report is consistent and matches its bundle entry |

## What "valid" means and does not mean

Validity is internal consistency: the retained evidence, the normalized outcome claims, the recorded verdict, the environment/provenance relationships, and the two canonical digests all agree after re-derivation. The commands never trust a stored `ok`, `verdict`, or digest string; they rebuild the projection from retained inputs and compare.

**Validity is not claim success.** A report whose declared claims failed is a valid `FAIL` artifact: `digest` exits `0` and prints `verdict: FAIL`. A report whose stored verdict contradicts its own claims is **invalid** and exits `1`, however the verdict reads. Read the `verdict` line (or JSON field) separately from the exit code; never treat exit `0` as "the tests passed".

Validity is also not authenticity. A consistent rewrite is possible for anyone who can edit every dependent field, so offline verification shows that a report was not altered carelessly or partially, not that the recorded run happened. There is no signature. See [evidence report anatomy](evidence-report.md).

## Exit codes

| Exit | `validate` | `digest` / `check-digest` |
| --- | --- | --- |
| `0` | manifest parsed under the strict grammar | report internally consistent; for `check-digest`, every supplied digest also matched |
| `1` | manifest rejected (grammar, unknown key, invalid selector, bad encoding, missing file) | report invalid, unsupported version tuple, malformed JSON, or a supplied digest did not match |
| `2` | usage error (unknown option, extra positional) | usage error, malformed `--outcome`/`--environment`, report path missing or not a regular file |

`check-bundle` follows the `digest` column: `0` only when the bundle is complete and every report verifies; `1` for any altered, missing, unlisted, or inconsistent file, or a source/repository that differs from `--source-sha`/`--repository`.

Exit `2` is "the tool could not evaluate the input"; exit `1` is "the tool evaluated the input and rejected it". Scripts should not collapse the two.

## Text output

`validate` prints one `VALID:` or `INVALID:` headline, then one `key: value` line per fact, and always ends with `executed: nothing (no commands, listeners, installs, or network)`:

```text
VALID: manifest parsed under the strict 0.1.0-draft.4 grammar
manifest: /work/showcases/cell-properties/verify.committed.toml
name: cell-properties-dao
sha256: sha256:01766a52787f341a42395f2deee1063a62d0fe84ca8c24c35a02c4c643c2265e
toolchain: ckb 0.209.0, offckb 0.4.13, no debugger
accounts: 2
replay dependencies: none
step: deposit (committed; 2 claims; timeout 60000ms)
final claims: 0
claims: 3
executed: nothing (no commands, listeners, installs, or network)
```

`digest` and `check-digest` print a `VALID:` or `INVALID:` headline, the file hash, the report's version tuple, the recorded verdict with an explicit reminder, the **re-derived** digests, replay status, source revision, runner identity, any expected-digest comparison, and one `problem:` line per failure. When the report is invalid, the stored digests are printed as `stored … (unverified)` and never as `outcome:`/`environment:`.

```text
VALID: report is internally consistent
report: /work/.ckb-verify/runs/2026-10-28T06-34-04-526Z-543-cell-properties-dao/report.json
file sha256: sha256:950ecada3a026f1c7fd6878f966625fa5bd5c90f2ac9e7880af3e0d3ce5ac4cd
schema: ckb-verify-report/2 (spec 0.1.0-draft.4)
name: cell-properties-dao
verdict: PASS (recorded claim result; validity is not claim success)
outcome: sha256:e106a8c037cd91813660fb7cfddebbe5a7a7bbbb01d668ee1bdb3489c118917e
environment: sha256:c3c579306a6bfefd42a123dd92b4e3760dc04e6cfdf764913cdd6b1e321563e5
replay: stable
source: 53fa758e64e5d011257d1f30a26b9d0def6e28bb (clean)
runner: ckb-verify 0.0.2
expected outcome: match
```

## Machine-readable output

Add `--json` to any offline command to print exactly one JSON object and nothing else on stdout. Diagnostics for exit `2` still go to stderr. Field names are stable across patch releases; new fields may be added, so consumers should ignore unknown keys.

`validate --json` emits `{ command, ok, executed, path, manifest, problems }`, where `manifest` is `null` when `ok` is false and otherwise contains `path`, `sha256`, `name`, `spec`, `description`, `toolchain`, `replayDependencies`, `accounts`, `steps[]` (`name`, `timeoutMs`, `expect`, `claims`), `finalClaims`, `claimCount`, and `requiresDebugger`.

`digest --json` and `check-digest --json` emit (abridged; this is command output, not a report):

```jsonc
{
  "command": "check-digest",
  "ok": true,
  "valid": true,
  "path": "/work/report.json",
  "sha256": "sha256:950ecada3a026f1c7fd6878f966625fa5bd5c90f2ac9e7880af3e0d3ce5ac4cd",
  "schema": "ckb-verify-report/2",
  "spec": "0.1.0-draft.4",
  "name": "cell-properties-dao",
  "verdict": "PASS",
  "digests": {
    "stored": { "outcome": "sha256:…", "environment": "sha256:…" },
    "recomputed": { "outcome": "sha256:…", "environment": "sha256:…" }
  },
  "expected": { "outcome": "sha256:…", "environment": null, "outcomeMatches": true, "environmentMatches": null },
  "replay": { "status": "stable", "reasons": [] },
  "source": { "gitCommit": "53fa758e64e5d011257d1f30a26b9d0def6e28bb", "dirty": false },
  "runner": { "name": "ckb-verify", "version": "0.0.2" },
  "legacyAllowed": false,
  "problems": []
}
```

- `valid` is internal consistency. `ok` is `valid` **and** every supplied expected digest matched. `verdict` is the recorded claim result and is only meaningful when `valid` is true.
- `digests.recomputed` is `null` when re-derivation itself failed; `digests.stored` echoes the file and is never authoritative.
- `expected` is `null` for `digest`; for `check-digest` each `…Matches` flag is `null` when that digest was not supplied.
- `problems` lists every reason the input was rejected, in the verifier's own words (for example `report integrity mismatch: … semantic mismatch`, `outcome digest mismatch: expected …`).

## Version compatibility

| Report `schema` | Nested tuple | Supported by | Notes |
| --- | --- | --- | --- |
| `ckb-verify-report/2` | outcome `/2`, specs `0.1.0-draft.4`, environment `/3`, provenance `/2` | `digest`, `check-digest` | current draft.4 envelope |
| `ckb-verify-report/1` | outcome `/1`, specs `0.1.0-draft.3`, environment `/3`, provenance `/2` | `digest`, `check-digest` | current draft.3 envelope |
| `ckb-verify-report/1` | outcome `/1`, specs `0.1.0-draft.3`, environment `/2`, provenance `/1` | only with `--allow-legacy` | historical reports predate debugger identity; no retroactive debugger guarantee |
| anything else | — | rejected as `unsupported …` (exit `1`) | missing, mixed, or unknown versions are never inferred |

Manifest specs `0.1.0-draft.3` and `0.1.0-draft.4` are accepted by `validate`; the spec string selects the grammar and there is no automatic migration. A historical report is verified against the rules that applied when it was written; `--allow-legacy` never widens what report `/2` accepts.

## Published schemas

Two whole-document JSON Schemas (Draft 2020-12) ship in `schemas/` and inside the package, next to the [provenance `/1`](../schemas/ckb-verify-provenance-v1.schema.json), [provenance `/2`](../schemas/ckb-verify-provenance-v2.schema.json), and [claims-v2](../schemas/ckb-verify-claims-v2.schema.json) definitions they reference:

| Schema | `$id` | Validates |
| --- | --- | --- |
| [`ckb-verify-manifest-v1.schema.json`](../schemas/ckb-verify-manifest-v1.schema.json) | `https://github.com/Akane-CN/spark-verify/schemas/ckb-verify-manifest-v1.schema.json` | the parsed `verify.toml` object for specs `0.1.0-draft.3` and `0.1.0-draft.4`; unknown keys are rejected at every level |
| [`ckb-verify-report.schema.json`](../schemas/ckb-verify-report.schema.json) | `https://github.com/Akane-CN/spark-verify/schemas/ckb-verify-report.schema.json` | a complete `report.json` for report `/1` (current and historical environment) and report `/2` |

`validate` runs the manifest schema on the parsed TOML **and** the strict parser; `digest`, `check-digest`, and `check-bundle` run the report schema **and** the semantic verifier. The two layers must agree: a manifest the parser accepts but the schema rejects (or the reverse) is reported as invalid with both diagnostics, never hidden. Schema violations are listed as `problem: schema <json-pointer> <message>`, for example `schema /step/0/expect/tx must be equal to one of the allowed values (["committed","rejected"])`, and `--json` carries them under `schema` (manifest) or `schemaCheck` (report) with the schema `$id`.

Rules only the parser or the verifier can enforce stay outside the schemas and are listed in each schema's `description`: step-name uniqueness and ordering of `out_point.step` references, the at-least-one-claim rule, `rejected` requiring a debugger pin, UTF-8 round-tripping for draft.4, and every hash, alignment, membership, verdict, and digest relationship in a report. Shape validation alone never makes a report trustworthy.

Conformance fixtures live under `tests/fixtures/conformance/manifests/`: `valid/` manifests must pass both layers; each file in `invalid/` is listed in `cases.json` with the parser message and the schema JSON Pointer it must produce, and `semantic-cases.json` lists the rules the schema cannot express. `tests/schemas.test.ts` also validates the historical sample report and synthetic report/2 artifacts and checks that structural damage is pinpointed to its field.

## Typical uses

```bash
# Check a manifest before committing it; nothing runs.
bun run src/cli.ts validate verify.toml

# Re-derive the digests of a report someone sent you.
bun run src/cli.ts digest path/to/report.json

# Confirm a report matches the digests printed in a CI log, as JSON for scripting.
bun run src/cli.ts check-digest path/to/report.json \
  --outcome sha256:… --environment sha256:… --json

# Verify a historical environment/2 report explicitly.
bun run src/cli.ts digest docs/examples/secp-transfer-committed-report.json --allow-legacy
```

The same commands are available as `ckb-verify validate|digest|check-digest` once the package is installed. They read only the named file; sibling evidence files are not consulted and are not needed.

## Evidence bundles

Every showcase job in [`verify.yml`](../.github/workflows/verify.yml) ends by running `scripts/package-evidence.ts`, which turns the job's finished runs into one bundle:

```text
evidence/<job>/
  bundle.json      schema ckb-verify-evidence-bundle/1: repository, source SHA, workflow run, runner version, one entry per report
  SHA256SUMS       sha256 of every file below plus bundle.json
  reports/<run-directory>/report.json
```

Packaging is all-or-nothing and applies both a file allowlist and a field allowlist:

- only `report.json` files are copied; step output, `transaction.json`, account files, pending reports, and runtime roots are never read into the bundle;
- a leftover `accounts.json`, a `.report.json.pending`, a symlink, hard link, or other non-regular entry anywhere under the run directory refuses the bundle;
- every report must have exactly the seven top-level report fields, pass the strict verifier, record a clean source revision equal to the job's commit, and pass a secret scan for generic credential markers (tokens, PEM blocks, URL credentials, private-key field names, CI secret variable names) and the exact OffCKB development keys;
- the bundle records which commit, workflow run and attempt, and runner version produced it.

The bundle is uploaded with a commit-pinned `actions/upload-artifact`, named `evidence-<job>-<commit>`, with a 30-day retention. A separate `verify-evidence` job reads the run's artifact list back through the GitHub API (so an upload step that merely printed success is not enough), downloads every bundle into its own directory with a commit-pinned `actions/download-artifact`, and runs `ckb-verify check-bundle <dir> --source-sha <commit> --repository <owner/repo>` on each. Fork pull requests run the same read-only steps; nothing uses `pull_request_target` or repository secrets.

To inspect a bundle yourself, download it from the run's **Artifacts** list (or `gh run download <run-id> -n evidence-<job>-<commit>`), unpack it into an empty directory, and run `check-bundle` there. Checksums and digests detect alteration; they are not an authenticity signature, and a valid bundle may contain valid `FAIL` reports: read each `verdict` separately.

CI artifacts expire; evidence for a release must be attached to that release as a durable asset (see the release checklist) rather than referenced from workflow storage.
