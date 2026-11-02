# Pre-release review of the v0.1.0 candidate `d99117b`, 2026-11-02

Three AI agent reviewers read the frozen candidate `d99117b` independently. Each was given the code and a scope but none of the authors' conclusions. The scopes were offline verification soundness, runner execution safety, and documentation against behavior. **This is not the independent review that #20 requires**: that needs a reviewer outside the project, and it is still outstanding. It is recorded because it found real defects and changed the candidate.

Every finding below was reproduced or traced by its reviewer and then checked again before being fixed. Fixes carry regression tests. Because they change code, the candidate is re-frozen and re-gated; the new candidate's record supersedes `2026-11-02-candidate-d99117b.md`.

## Offline verification

No path was found where a FAIL report verifies as PASS, or where a stored outcome or verdict differs from what the verifier derives.

| Finding | Severity | Disposition |
| --- | --- | --- |
| CKB drift hidden by editing the observed version and binary; drift record contradicting the manifest | medium | fixed: platform, observed version, and requested version or drift record must agree with the executed binary |
| Rejection evidence copied into the outcome unchecked; a node rejection could satisfy `expect.error.code` | medium | fixed: exact shapes, script hash, source bounds, output script match; only script evidence satisfies the code |
| CKB binary not checked against the runner's pin table offline | low–medium | documented in the release notes; checking it would change the frozen golden report |
| `check-bundle` accepted a missing or incomplete `SHA256SUMS` | low–medium | fixed: full coverage required, `bundle.json` included |
| `check-bundle` crashed (exit 2) on a null entry or null digests in `bundle.json` | medium | fixed: INVALID, exit 1 |
| Duplicate JSON keys accepted (last key wins) | low | fixed: refused in reports, `bundle.json`, and `release-evidence.json` |
| Exported accounts not bound to `setup.accounts`; platform not bound to the binary | low | fixed |
| RFC said node rejection reasons are excluded from the outcome digest; they are included | low (docs) | fixed in the RFC text |

## Runner execution

| Finding | Severity | Disposition |
| --- | --- | --- |
| Source guard switched off by an untracked nested repository or unreadable entry; reproduced as PASS after a step edited a tracked file | high | fixed: snapshot failures inside a repository refuse the run |
| Monorepo: untracked changes outside the project directory missed | medium | fixed: repository-wide untracked listing |
| Timeout and SIGINT not enforced when a descendant left the process group holding the pipes | medium | fixed: pipes released after the forced kill; the escaped process itself is a documented limitation |
| Only the first `setup.accounts` development keys redacted | medium | fixed: every key OffCKB reports |
| A project not ignoring `.ckb-verify/` always failed with "source revision changed" | low | fixed: runner output excluded from the snapshot; the install guide adds the ignore |
| A step's detached background process outlives the step | low | documented in the release notes (trusted code, no sandbox) |

## Documentation

All 15 findings were fixed; none was high.

- **Release checklist:** its `SHA256SUMS` did not verify beside the download. It also omitted the vocabulary showcase and bundle.
- **Install guide:** it lacked the `.gitignore` and commit steps, so runs were tainted or refused.
- **`run` usage errors:** they exited 1, the FAIL code. This was a code fix, not a docs fix.
- **Stale report versions:** shipped pages described only report `/1` and `/2`.
- **README:** it contradicted itself on implemented vocabulary and cell-properties acceptance.
- **Node 20:** it was claimed but never exercised.
- **Smaller fixes:** the changelog contradictions, a missing `repository` field for links in shipped pages, a wrong step number, an archive name mismatch, the documents count, the `check-bundle` synopsis, text-output examples, and stale wording.

## What was checked and found sound

- **Verdicts and outcomes:** they are re-derived from raw inputs for every report version. Stored claims and digests are compared semantically. Manifest text is bound by hash. Indexer pages are chain- and key-checked.
- **Canonical JSON and the schema gate:** both hold, and VALID requires both.
- **Archives:** extraction refuses links, traversal, duplicates, and oversized archives.
- **Keys:** they never reach the CLI output, and every evidence file is scanned.
- **Cleanup:** it runs on every exit path that reaches the runner.
- **Binaries:** the CKB and debugger binaries are integrity-checked before execution.
- **Platform gate:** the refusal comes before any write.
