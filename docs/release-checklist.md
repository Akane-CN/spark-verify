# Release checklist and patch-release flow

This checklist turns a frozen candidate commit into a reviewable, installable artifact. It does **not** authorize a public release: tagging, creating a GitHub prerelease, and publishing a package each require explicit maintainer approval recorded on #20. Everything below can be rehearsed without publishing, and `scripts/release-rehearsal.sh` performs steps 1–5 and writes a record.

## 1. Freeze the candidate

- Pick the exact `main` commit; record its SHA in the release notes. No further pushes to that candidate.
- `git status --porcelain` is empty on the checkout used for every step below. Dirty trees produce `tainted` reports and are refused by the evidence packager.

## 2. Dependency and supply-chain gate

```bash
bun install --frozen-lockfile
bun run check:supply-chain
```

- The gate must print `supply-chain gate passed`. It fails closed on unknown audit findings, severity or URL drift, an expired waiver, or an unpatched OffCKB bundle.
- Review the one documented waiver (`elliptic`, low) in `src/supply-chain.ts` and `SECURITY.md`: owner, review date, and expiry must still be valid on the release date. Renewing the waiver is a reviewed change, not an edit during release.

## 3. Regression

```bash
bun run check                                 # unit tests, typecheck, supply-chain gate, whitespace
./scripts/validate-docs.sh --examples         # documentation validators and Markdown lint
bun run showcase:secp-transfer
bun run showcase:cell-properties
bun run showcase:ckb-ugmp
scripts/acceptance-matrix.sh --results acceptance-source.md
```

Hosted CI on the candidate must be green for all jobs, including `verify-evidence`. Local results never substitute for the hosted run; record the run ID.

## 4. Package

```bash
bun pm pack --destination dist
sha256sum dist/ckb-verify-<version>.tgz > dist/SHA256SUMS
```

- The tarball contains only the `files` allowlist (`src`, `schemas`, `patches`, user docs, `SECURITY.md`, `LICENSE`, `README.md`, `package.json`).
- `ckb-verify --version` from the installed package equals the `version` in `package.json` and the changelog heading.

## 5. Installed-consumer acceptance

```bash
scripts/acceptance-matrix.sh --consumer --results acceptance-consumer.md
```

Both gates (install-time missing patch, runtime unpatched bundle) and every scenario row must read `PASS`. The record names the platform, Bun and Node versions, tarball checksum, and consumer source revision. Only combinations that actually ran are claimed as supported.

## 6. Evidence

- Download the three `evidence-*-<sha>` bundles of the candidate's CI run and verify each with `ckb-verify check-bundle <dir> --source-sha <sha> --repository Akane-CN/spark-verify`.
- CI artifacts expire after 30 days. For a release, attach the verified bundles and both acceptance records to the GitHub release as assets together with `SHA256SUMS`, so the evidence outlives workflow storage.

## 7. Release notes

- Move the `Unreleased` section of `CHANGELOG.md` under the new version heading with the date.
- State known limitations (see [maintenance](maintenance.md#supported-combinations)), the report/manifest versions the runner reads and writes, and the upgrade and rollback notes below.
- State what was **not** run (platforms, external pilots). Silence from external maintainers is not a gate.

## 8. Publication (separately authorized)

Only after a written go-ahead: create the annotated tag `v<version>` on the frozen SHA, create a **prerelease** with the assets from steps 4 and 6, then install the exact published package in a fresh consumer and repeat step 5 against it. `v0.1.0` is published only when every gate above passed on the same SHA; otherwise the project stays an explicitly labeled preview.

## Patch-release flow (`x.y.z` → `x.y.z+1`)

1. Open a scoped issue with a reproducer and acceptance criteria; link the fix PR to it.
2. Fix on a branch from `main`; add the regression test first; keep the change minimal.
3. Bump `version` in `package.json` and `src/version.ts` together (`tests/cli.test.ts` pins the printed version) and add a changelog entry under `Unreleased`.
4. Run steps 2–5 of this checklist on the merge commit. Patch releases never change report or manifest schema versions; a change that needs one is a minor release with a migration note.
5. Publish per step 8 if authorized; otherwise the patch ships as the next preview.

## Rollback

- Consumers: reinstall the previous tarball (`bun add ./ckb-verify-<previous>.tgz`), keep the same `patches/` file and declarations, and run `ckb-verify --version` to confirm. Reports written by the newer version remain readable by `digest`/`check-digest` of the same major report schema; a report schema a consumer's verifier does not support is rejected as `unsupported`, never misread.
- Repository: revert the release commit with a merge-safe revert PR; do not force-push `main`. Delete nothing that was published; mark a withdrawn prerelease as such in its notes.
