# Contributing

Spark Verify has an unreleased, deliberately narrow `ckb-verify` feasibility runner and executable showcase alongside the broader RFC. The most valuable contribution is a concrete CKB flow that proves either the implemented subset or proposed vocabulary useful—or insufficient.

## Good feedback

Open an issue that includes:

1. repository/project link;
2. CKB toolchain used today;
3. transaction sequence in plain language;
4. observable claim a reviewer needs to verify;
5. whether the draft `cell`, `balance`, and `tx`/cycles/error vocabulary can express it;
6. the smallest proposed field or semantic change if it cannot.

Examples of useful questions:

- How should a rejected CCC transaction be handed to the runner?
- Does an OffCKB built-in script have a stable name and metadata shape?
- Which exact script group should an error expectation identify?
- Is a step/output-index reference stable enough for your flow?
- Does your token data use the standard 16-byte little-endian amount prefix?

“Add a generic plugin system” is not a v0.1 proposal unless accompanied by a real deliverable that cannot use a repository command.

## RFC changes

Normative changes should include:

- motivation and a concrete example;
- before/after TOML;
- parser/schema validation rules;
- report, outcome-digest, environment-fingerprint, and replay-status effects;
- valid and invalid conformance fixtures;
- compatibility impact.

Unknown keys are errors, so renames are breaking until a compatibility rule is documented.

## Documentation checks

Run the repository validator before proposing an RFC/documentation change:

```bash
./scripts/validate-docs.sh --examples
```

It runs validator regression tests, parses every TOML and JSON fence, applies selected high-risk draft invariants, checks local links and common secret patterns, runs the pinned Markdown linter, and checks both staged and unstaged Git whitespace. It is not the future machine-readable manifest schema and does not exhaustively reject every missing or unknown field. Add `--external-links` when intentionally rechecking every public URL.

## Draft.4 fixture and evidence

The private `0.0.2` runner retains draft.3 and adds [bounded draft.4 Cell-property claims](docs/cell-claims-draft.4.md). Keep the generic DAO fixture repository-owned, not NervDAO adoption. Preserve historical grant/RFC/example bytes and never convert legacy evidence in place.

Use `bun run showcase:cell-properties` for the six-case matrix plus fresh committed repeat after static checks. Its initial implementation has offline coverage only; real clean-checkpoint acceptance and independent reviews remain gates. Verify every complete saved PASS/FAIL artifact with `verifyReport`, not the v1-only component helper `verifyEvidenceDigests`. Check actual failure predicates and run file/account/pending/port checks independently of secondary audits. Compare outcomes, require environment equality where raw provenance repeats, and preserve differing deployment/genesis bindings. Presence/membership/length is not script-execution proof; verifier consistency is not authenticity.

The Python validator now checks selected draft.4 grammar/bounds and report-version tuples while retaining historical RFC checks; it is not a full runtime manifest/report schema or public #18 verifier. For offline checks, invoke `python3 -B scripts/test-validate-docs.py` and `python3 -B scripts/validate-docs.py --examples`, plus an already installed local Markdown validator without package resolution. The existing convenience shell wrapper uses `npx` and must not be used in a no-network/no-install gate. CI artifact publication is separate #19 work.

## Implementation standards

- TypeScript strict mode;
- no floating-point asset arithmetic;
- explicit timeouts and cleanup;
- no shell-string interpolation for untrusted paths;
- redaction tests for logs/reports;
- unit tests plus real OffCKB integration fixtures;
- clean-run repeatability: the secp harness compares both digests; the Cell-property harness retains/report differences in raw devnet bindings instead of forcing environment equality;
- Linux required, macOS targeted, Windows support claimed only after real verification.

## Security

Read [`SECURITY.md`](SECURITY.md) before running the implementation. A manifest executes repository commands and is not safe merely because it is declarative TOML.

## License

By contributing, you agree that your contribution is licensed under the repository's MIT License.
