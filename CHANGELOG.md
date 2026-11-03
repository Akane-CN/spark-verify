# Changelog

All notable changes to `ckb-verify` are recorded here. The project is unreleased: versions below are
the private `version` field of `package.json`, not published packages. Dates are UTC.

## 0.1.0 — 2026-11-03

### Added

- Manifest spec `0.2.0`, which carries the parts of the proposal's target v0.1 that the frozen `0.1.0`
  lacks ([vocabulary](docs/vocabulary-v0.2.md); [decision](docs/release-decisions.md)). It is written
  as `ckb-verify-report/4` with `outcome/4`, `environment/5`, and `provenance/4`, and frozen by
  `tests/frozen-contract-v0.2.test.ts`. The frozen `0.1.0` and its lock are unchanged.
  - `[setup.scripts.<name>]` repository binaries. The runner deploys them with `offckb deploy`
    (`type` via Type ID, or `data`, `data1`, `data2`) and checks each code Cell on chain against the
    binary's bytes. Built-in aliases are also supported.
  - Named references `"name"` and `{ script = "name", args }` in Cell, balance, dependency, and group
    claims.
  - Pure steps, zero steps, and zero accounts.
  - `expect.error.group`. The verifier uses retained input Cells to refuse a reference that matches
    more than one group.
  - Terminal node rejections from `send_transaction`, recorded with their RPC code.
  - provenance/4: every common lockfile, runtime pins with the versions the step environment
    reports, the sanitized repository URL, and the devnet sealing fingerprint (`nondefault_devnet`).
  - The genesis is checked against a pinned allowlist.
  - New schemas: `ckb-verify-manifest-v2`, `ckb-verify-claims-v4`, `ckb-verify-provenance-v4`, and a
    `report/4` branch.
- `run --report <file>` and `run --json`, for every spec.
- The repository-script showcase (`bun run showcase:repository-script`, CI job `repository-script`).
  It uses a lock script assembled from this repository and runs on fresh devnets:
  - deploy, a pure step, create, and a legal spend;
  - a group-pinned illegal spend, and a wrong-group control;
  - a node rejection, and a node rejection that cannot satisfy an error code;
  - a pure step that writes a result, and a missing binary;
  - zero accounts and zero steps;
  - a repeat run, and a variant binary that changes the outcome digest.

- Published whole-manifest and whole-report JSON Schemas (`schemas/ckb-verify-manifest-v1.schema.json`,
  `schemas/ckb-verify-report.schema.json`) run by the offline commands next to the strict parser and
  semantic verifier, with field-path diagnostics and manifest conformance fixtures; `ajv` is now a
  runtime dependency (#18).
- `docs/rfc-implementation-matrix.md` (every RFC v0.2 item marked supported, deferred, or
  release-blocking) and `docs/version-policy.md` (independent version lines, accepted tuples, no
  silent migration) (#18).
- Offline commands `validate`, `digest`, `check-digest`, and `check-bundle` with text and `--json`
  output and documented exit codes; validity is reported separately from the recorded verdict
  ([offline verification](docs/offline-verification.md), #18).
- Sanitized, checksummed CI evidence bundles: packaged after each showcase job, uploaded with a
  commit-pinned action, read back through the GitHub API, downloaded into a separate directory and
  re-verified offline by the `verify-evidence` job (#19).
- Durable release evidence: `scripts/release-evidence.ts` assembles a run's verified bundles and
  acceptance records into one `release-evidence-<commit>.tar.gz` with a complete `SHA256SUMS`, a
  checksum sidecar, and a manifest tied to the repository, source SHA, workflow run and runner
  version; CI assembles it, verifies it with `tar`/`sha256sum`/`check-bundle`, uploads it with 90-day
  retention and reads the artifact back through the API. The archive is what a release attaches
  ([retention](docs/offline-verification.md#retention), #19).
- Installable package layout (`files` allowlist), a fail-closed runtime check that the installed
  OffCKB bundle carries the shipped security patch, and the consumer
  [installation guide](docs/install.md) (#20).
- `scripts/acceptance-matrix.sh`: a repository-owned matrix of real CLI processes covering cold/warm
  caches, repeatability, pinned-debugger rejection, assertion failure, tampered reports, occupied
  ports, concurrent exclusion and reuse, SIGINT cleanup, producer timeout, tampered debugger cache,
  download failure and recovery; `--consumer` runs it against the packed, installed package.
- Maintenance material: [release checklist](docs/release-checklist.md),
  [maintenance loop](docs/maintenance.md), bug report template, `scripts/release-rehearsal.sh` (#20, #21).
- Manifest spec `0.1.0-draft.5` with the promised assertion vocabulary: `expect.cycles` comparators; Cell
  selection by `out_point`, `lock`, and `type` script filters (explicit, any OffCKB built-in with optional
  wildcard args, or an exported account) with `count` comparators, `data.eq`/`len`/`min_bytes`, and
  `capacity` comparators; `balance` claims by account, full-format address, or lock, with or without a
  16-byte little-endian UDT; and `run --allow-version-drift`. Reports are `ckb-verify-report/3` with
  `ckb-verify-outcome/3`, `ckb-verify-environment/4` (exported accounts), and `ckb-verify-provenance/3`
  (tool-version drift record); raw indexer pages are retained and every observation is re-derived offline.
  Published schema branches, 14 conformance fixtures, the `vocabulary` showcase (owner-mode xUDT mint on a
  fresh devnet, five cases plus a repeat) and its CI evidence bundle, `docs/vocabulary-v0.1.md`
  ([release decision 1 reopened](docs/release-decisions.md), #20).
- Repository-root dogfood manifest (`verify.toml`), `bun run verify:release` (the proposal's release
  verification surface with a Markdown record), `bun run build`, the pinned secret-free reusable
  workflow `.github/workflows/ckb-verify-reusable.yml` (called by the `dogfood` job), and
  `docs/proposal-coverage.md` mapping every promised deliverable to its status (#20).
- The frozen v0.1 contract: manifest spec `0.1.0`, the draft.5 grammar under its release identifier,
  written as `ckb-verify-report/3` with the evidence and outcome naming the manifest's identifier.
  `tests/frozen-contract.test.ts` pins the v0.1 parts of the published schemas by RFC 8785 digest,
  re-verifies a golden `0.1.0` report against locked digests, and re-runs the whole draft.5 conformance
  corpus under `0.1.0`; the root `verify.toml` and the vocabulary showcase use `0.1.0`
  ([version policy](docs/version-policy.md#the-frozen-v01-contract), release decision 6 reopened, #20).
  `docs/vocabulary-v0.1.md` (renamed from `vocabulary-draft.5.md`) and `docs/version-policy.md` now ship
  in the package.
- `.github/workflows/platform-boundary.yml` (replacing the manual `macos-boundary` workflow): on macOS 14
  and Windows Server 2022 hosted runners it installs, type-checks, runs the platform-independent tests and
  the offline commands, and proves that `run` is refused with exit 2 before anything is written. It runs
  on demand and on pull requests that change the platform gate (#20).
- `run` prints a field-level expected/observed diff for every failed expectation and claim on FAIL.
- `docs/release-decisions.md` records the six release decisions for `v0.1.0` (#18), two of them reopened
  on 2026-11-02. As they stand: the promised vocabulary (`balance`, script-filter selectors and
  comparators, `expect.cycles`) ships, and the v0.1 contract is frozen as spec `0.1.0` (decisions 1 and
  6, reopened); `[setup.scripts]` deployment, pure steps, `accounts = 0`, and `expect.error.group` are
  v0.3 proposals (decisions 2–4); RFC §7 is rewritten to the shipped report and CLI contract (decision
  5). The matrix, the version policy, and the RFC section status lines point at the record.
- `tests/package-layout.test.ts` packs the tree on every `bun run check` and proves the tarball carries the
  bin, every runtime import, schema, and patch, and nothing from the checkout; `docs/package-identity.md`
  records the registry-name check, the credential and installation-path decisions, and the release
  commit's exact contents; `docs/release-notes-draft.md` is the v0.1.0 candidate notes, filled from the frozen candidate (#20).
- `docs/external-checkpoints.md`: the week-3 and week-8 upstream/pilot checkpoint record with its
  vocabulary (consented, no response, no outreach sent, no-go) and the unpublished draft upstream
  question for #2 (#21).

### Security

- `follow-redirects` pinned and overridden to `1.16.2` (from `1.16.1`) for
  [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p) (high), reported by the audit
  on 2026-10-31; the supply-chain gate, the installed-runtime check, and the consumer install guide
  require the new version. OffCKB's proxy does not enable redirect following, so the runner did not
  exercise the vulnerable path, but a high finding blocks release regardless.

### Changed

- `run` refuses platforms other than Linux x64 under Bun before it writes anything. It previously created
  the run directory and copied the manifest before the runtime-ownership check refused the platform (#20).
- The shipped OffCKB patch now binds the RPC proxy (`28114`) to `127.0.0.1` instead of every
  interface; the supply-chain gate and the runtime installation check require the loopback-bound
  listen and reject the wildcard one (#15).
- `@ckb-ccc/spore` is a devDependency: only the CKB-UGMP showcase uses it, so a consumer install no
  longer pulls it; `tests/package-layout.test.ts` now requires every runtime dependency to be imported
  by `src/` or be a redirect target of the shipped OffCKB patch (#20).
- The devnet adapter resolves the OffCKB CLI from `ckb-verify`'s own dependency tree instead of the
  verified project's `node_modules/.bin`.
- The cell-properties showcase wrapper tolerates hosts where IPv6 cannot bind, matching the runner's
  port preflight.

### Fixed

- Pre-release review of the candidate (2026-11-02), runner: the source guard failed open when an untracked
  nested repository or unreadable entry was present (a step could edit tracked files and still get a
  verdict); it now refuses the run. Untracked files are snapshotted repository-wide (monorepos), the
  runner's own `.ckb-verify/` output is excluded, step timeouts and SIGINT settle even when a descendant
  escaped the process group, every OffCKB development key is redacted, and `run` usage errors exit 2.
- Pre-release review, verifier: reports no runner can write no longer verify. These cover CKB drift
  hidden by editing the observed version, a platform that contradicts the executed binary, unchecked or
  impossible rejection evidence (only script evidence satisfies `expect.error.code`), exported accounts
  that differ from `setup.accounts`, and duplicate JSON keys. `check-bundle` requires a complete
  `SHA256SUMS` and reports a malformed `bundle.json` as INVALID instead of crashing.
- Documentation found by the same review: the install guide adds the `.gitignore` and commit steps,
  without which runs are tainted or refused; the release checklist's `SHA256SUMS` verifies beside the
  download and covers all four showcases; and shipped pages describe report `/3`. Node 22 is stated as
  the only exercised Node version.
- Release-evidence extraction failed on Windows: node-tar opens small files there with `UV_FS_O_FILEMAP`,
  which Bun rejects with `EINVAL`. The archive is now listed into memory, every entry is validated, and only
  then are files written with exclusive create, so a refused archive (link, device, dot-dot path, entry
  outside the root, or a new duplicate-entry check) leaves nothing behind (#20).
- `check-bundle` and bundle verification failed every valid bundle on Windows: the directory walk produced
  `\`-separated paths that never matched the `/`-separated names in `bundle.json` and `SHA256SUMS`. Paths
  are now normalized from the platform separator only; found by the first Windows boundary run (#20).
- Indexer-backed claims (script-filtered Cells and balances) wait, up to 30 s, for the node indexer to reach
  the chain tip before the first `get_cells` page. They read the index right after commit, so a lagging
  indexer could record a self-consistent but wrong empty selection; a hosted vocabulary run on PR #37
  hit it. An indexer that never catches up is now an execution error with no report (#20).
- `scripts/acceptance-matrix.sh` waits for the OffCKB proxy (`28114`) before checking listener scope. The
  check raced the proxy's startup, which failed the 2026-11-02 consumer rehearsal on `ed41b28`, and could
  probe the routable address before the proxy existed (#21).
- `tests/debugger-binary.test.ts` compared unsorted `readdir` results and failed on some runners.
- The CKB-UGMP showcase harness read system scripts from the pre-`environment/3` report location.

## 0.0.2 — 2026-10-28

Merged into `main` as #23, #24, #26, and #7 on top of the maintenance baseline (#25).

### Added

- Exclusive OffCKB runtime ownership: a kernel-backed lease for the `8114/28114` namespace, IPv4/IPv6
  port preflight that never stops foreign listeners, and drained cleanup on normal exit, setup
  failure, timeout, SIGINT and SIGTERM (#15).
- Verified pinned `ckb-debugger 1.1.1` artifacts: archive and executable size/SHA-256 pins, safe
  extraction, cache tamper detection, private execution snapshots, and debugger identity in
  `ckb-verify-provenance/2` (#16).
- Manifest spec `0.1.0-draft.4` with typed Cell, argument-length, data-length and builtin CellDep
  claims; report `ckb-verify-report/2` with retained manifest text and transactions; the strict
  `verifyReport` entry point; the generic DAO/plain cell-properties showcase (#17).
- The CKB-UGMP Spore mint feasibility showcase with fresh OffCKB script injection (#7).

### Changed

- Reports moved to `ckb-verify-environment/3` + `ckb-verify-provenance/2`; historical
  `environment/2` + `provenance/1` reports require explicit legacy verification.

## 0.0.1 — 2026-10-02

Maintenance baseline (#25): pinned CKB release assets with checksum verification and safe
extraction, the patched OffCKB bundle and fail-closed supply-chain gate (#10), formal replay
provenance `ckb-verify-provenance/1` with source-revision guards (#12), delayed terminal rejection
evidence (#11), and the first secp transfer showcase (#5).
