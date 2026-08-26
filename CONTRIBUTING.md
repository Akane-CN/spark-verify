# Contributing

Spark Verify has an unreleased, deliberately narrow `ckb-verify` feasibility runner alongside the broader RFC. The most valuable contribution is a concrete CKB flow that proves either the implemented subset or proposed vocabulary useful—or insufficient.

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

## Implementation standards

- TypeScript strict mode;
- no floating-point asset arithmetic;
- explicit timeouts and cleanup;
- no shell-string interpolation for untrusted paths;
- redaction tests for logs/reports;
- unit tests plus real OffCKB integration fixtures;
- clean-run outcome digest and environment fingerprint checked twice by `bun run test:devnet`;
- Linux required, macOS targeted, Windows support claimed only after real verification.

## Security

Read [`SECURITY.md`](SECURITY.md) before running the implementation. A manifest executes repository commands and is not safe merely because it is declarative TOML.

## License

By contributing, you agree that your contribution is licensed under the repository's MIT License.
