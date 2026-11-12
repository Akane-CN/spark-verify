# Release notes: `ckb-verify` v0.1.1

> These notes are published with the `v0.1.1` release. The evidence archive's checksum is filled in when the archive is assembled for publication.

A patch release on top of [`v0.1.0`](release-notes-draft.md). The runner, the manifest specs, and the report formats are the same. If `v0.1.0` works for you, nothing forces an upgrade.

## Release identity

| Field | Value |
| --- | --- |
| Commit | `75db9702a4066b607c8026b732a5b09573d7e11e` (frozen 2026-11-11, #53) |
| Hosted CI run | Verify run 43120063559, every job green including `verify-evidence`; Platform boundary run 43120150845 on the same commit |
| Package tarball | `ckb-verify-0.1.1.tgz`, sha256 `589319cb38a1e6e166911d381a55e88c481e38aaea9c5b88359add6144ddf3c3` (reproducible from the commit) |
| Release evidence | CI artifact 13900382597: `release-evidence-75db9702a4066b607c8026b732a5b09573d7e11e.tar.gz`, sha256 `33d59b943a499b6ff95f22b0a2aa6d7f330d8a92cdbb7d96bb23b15abd1232f1`, five bundles and 29 reports |
| Acceptance records | [`2026-11-12-candidate-75db970.md`](acceptance/2026-11-12-candidate-75db970.md) (release checklist steps 1–6), with the source matrix, the release rehearsal, the ordinary-user consumer matrix, and the release surface beside it |

## What changed since v0.1.0

The two tarballs were compared file by file. Eight files differ:

- **`src/supply-chain.ts` and `SECURITY.md`:** the `elliptic` waiver was reviewed again on 2026-11-11 and now expires on 2027-01-25 instead of 2026-12-25 ([record](waiver-renewal-fallback.md#reassessment-2026-11-11)). This affects only this repository's own supply-chain gate, not a run of `ckb-verify` in your project.
- **`README.md` and `docs/install.md`:** the quick start downloads the release tarball and runs the setup script out of it.
- **`docs/annotated-manifest.md` and `docs/cell-claims-draft.4.md`:** they no longer name a runner version.
- **`package.json` and `src/version.ts`:** version `0.1.1`.

No other source file changed. Reports written by `v0.1.0` verify with `v0.1.1`, and the other way round.

## Fixed in the repository, not in the package

The installed-consumer acceptance matrix had a tamper fixture that only worked as root ([#52](https://github.com/Akane-CN/spark-verify/issues/52)). An ordinary user's install-back of `v0.1.0` therefore reported one failed row out of 29. The defect was in the test fixture: the runner's check of its debugger cache was not bypassed, and the `v0.1.0` assets are sound. With the fixture fixed, the matrix passes against the published `v0.1.0` tarball both as an ordinary user and as root ([record](acceptance/2026-11-11-v0.1.0-install-back.md)).

For this release the matrix was gated both ways: 29 of 29 as root and 29 of 29 as an ordinary user.

## Install

Download `ckb-verify-0.1.1.tgz` from this release, check it with `sha256sum -c SHA256SUMS`, and set up a project with the script inside the tarball:

```bash
tar -xzf ckb-verify-0.1.1.tgz package/src/setup-project.ts
bun package/src/setup-project.ts ckb-verify-0.1.1.tgz ./my-project --example
cd my-project && git add -A && git commit -m "Add ckb-verify"
bunx ckb-verify run
```

To upgrade a project set up with `v0.1.0`, run the same `setup-project` command with the new tarball in that project (without `--example`). It points the dependency at `vendor/ckb-verify-0.1.1.tgz` and installs it; the old `vendor/ckb-verify-0.1.0.tgz` is left in place and can be deleted. Commit the result. This path was tried on a project set up from the published `v0.1.0` tarball. The [quick start](../README.md#quick-start) and the [installation guide](install.md) have the details.

## Supported, formats, and known limitations

Unchanged from `v0.1.0`: Linux x64 with Bun 1.2.19 and Node.js 22 only; manifest specs `0.2.0` and `0.1.0` (frozen) and the draft identifiers; the same report tuples. The full statements are in the [`v0.1.0` release notes](release-notes-draft.md#supported), with one date changed: the `elliptic` waiver in this release runs until 2027-01-25.

## What was not run

- No devnet execution on any platform other than Linux x64 / Bun 1.2.19. macOS 15 and Windows Server 2022 ran the install, the platform-independent tests, and the offline commands only.
- No independent review by someone outside the project, as for `v0.1.0`.
- No external pilot. Nobody outside the project has reported using it yet.
- No registry package: this is a GitHub release only.

## Verify this release yourself

1. `sha256sum -c SHA256SUMS` on the downloaded tarball, and `sha256sum -c release-evidence-0.1.1-<sha>.tar.gz.sha256` on the evidence archive.
2. Extract the archive, `sha256sum -c --strict SHA256SUMS` inside it, then `ckb-verify check-bundle <bundle> --source-sha <sha> --repository Akane-CN/spark-verify` for each bundle ([offline verification](offline-verification.md#release-evidence-archive)).
3. Install as above and run your own manifest; compare `environment.runner.version` in the report with `ckb-verify --version`.

## Changes

The [`0.1.1` section of `CHANGELOG.md`](../CHANGELOG.md).
