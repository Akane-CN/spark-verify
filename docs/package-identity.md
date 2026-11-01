# Package identity and publication preparation

This records what was checked for the distributable's identity before any publication, and what the maintainer still has to decide. Nothing here publishes: the package stays `private: true` and unreleased until [release checklist step 8](release-checklist.md#8-publication-separately-authorized) is authorized on #20.

## Name and registry

| Fact | State on 2026-10-31 | Evidence |
| --- | --- | --- |
| Package name | `ckb-verify` (`package.json`), binary `ckb-verify` | `package.json` |
| `ckb-verify` on registry.npmjs.org | not found (HTTP 404), so unclaimed at that moment | `curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ckb-verify` |
| `spark-verify` on registry.npmjs.org | not found (HTTP 404) | same check |

A 404 is a snapshot, not a reservation. Re-run the check in the release commit's review. If the unscoped name is taken by then, publish under a scope the maintainer actually controls (their own npm user scope); never assume ownership of an organization scope.

## Ownership and credentials (maintainer decisions)

None of this is verifiable from the repository and none of it is assumed:

1. **Whether to publish to the npm registry at all.** The exercised installation path is the packed tarball attached to a GitHub release (below); registry publication is optional and adds the credential surface in this section.
2. **Which npm account owns the name**, with two-factor authentication enabled.
3. **How the publish is authenticated**: a granular access token limited to this package and used from the maintainer's machine, or npm trusted publishing from a GitHub Actions release workflow. No release workflow exists and none is proposed here; credentials are never stored in the repository and no existing workflow holds a secret.

## Runtime requirements

| Requirement | Value | Where enforced |
| --- | --- | --- |
| Bun | `1.2.19` exercised; `engines.bun >= 1.2.19`; `packageManager: bun@1.2.19` | `package.json`, `bun run check` fails on another version |
| Node.js | `>= 20` (the OffCKB CLI is a Node program); 22 exercised | `package.json` `engines.node` |
| OS / architecture | Linux x64 only | runtime ownership and debugger pins refuse other platforms |

Other platforms are not supported because binary pins exist for them; see [supported combinations](maintenance.md#supported-combinations).

## Primary installation path

The one path exercised end to end is [`docs/install.md`](install.md): obtain `ckb-verify-<version>.tgz` and `SHA256SUMS` (from the release assets at publication, from `bun pm pack` before it), verify the checksum, extract and declare the shipped OffCKB patch, `bun add ./ckb-verify-<version>.tgz`, run, verify offline. The installed-consumer acceptance matrix records this path on every candidate (`docs/acceptance/*consumer-matrix*.md`).

An install from the npm registry is **not exercised**. If registry publication is chosen, step 8 of the release checklist repeats the consumer matrix against the published package before `v0.1.0` is claimed.

## Metadata reconciliation

Checked by `tests/package-layout.test.ts` on every `bun run check`, by packing the tree and listing the tarball:

- the tarball is exactly the `files` allowlist plus `package.json`, `LICENSE`, and `README.md`: `src/` (every module), `schemas/` (every file `src/schemas.ts` reads), `patches/` (the file named by `patchedDependencies`), the five user documents, and `SECURITY.md`; nothing from `tests/`, `showcases/`, `scripts/`, `.github/`, `docs/media/`, `docs/acceptance/`, `docs/plans/`, and no `bun.lock` or `tsconfig.json`;
- the `bin` entry is `./src/cli.ts`, starts with `#!/usr/bin/env bun`, and is executable (`0755`) inside the tarball;
- every relative import inside `src/` resolves to a shipped module, and every bare import resolves to a package in `dependencies`, never `devDependencies`;
- `package.json` `version`, `src/version.ts`, and the changelog heading agree (`tests/cli.test.ts` also pins the printed version).

`private: true` stays until the release commit so an accidental `npm publish` fails; it is removed in that commit only if registry publication is authorized.

## The release commit

A release changes exactly: `version` in `package.json`, `VERSION` in `src/version.ts`, the pinned string in `tests/cli.test.ts`, the `Unreleased` heading in `CHANGELOG.md`, and (registry publication only) `private`. Everything else was already on `main` at the frozen candidate. The tag is `v<version>`, annotated, on that commit, created only under step 8.

## Checklist for the maintainer before step 8

- [ ] registry publication decided (yes/no); if yes, the name or scope, the owning account, and the credential method are written on #20;
- [ ] `curl` check above repeated on the day; result recorded on #20;
- [x] the six release-blocking decisions on #18 recorded in [release decisions](release-decisions.md);
- [ ] independent review of the candidate SHA recorded on #20;
- [ ] the [release notes draft](release-notes-draft.md) completed with the candidate SHA, run id, artifact ids, and checksums.
