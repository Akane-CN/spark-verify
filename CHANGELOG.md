# Changelog

All notable changes to `ckb-verify` are recorded here. The project is unreleased: versions below are
the private `version` field of `package.json`, not published packages. Dates are UTC.

## Unreleased

### Added

- Published whole-manifest and whole-report JSON Schemas (`schemas/ckb-verify-manifest-v1.schema.json`,
  `schemas/ckb-verify-report.schema.json`) run by the offline commands next to the strict parser and
  semantic verifier, with field-path diagnostics and manifest conformance fixtures; `ajv` is now a
  runtime dependency (#18).
- Offline commands `validate`, `digest`, `check-digest`, and `check-bundle` with text and `--json`
  output and documented exit codes; validity is reported separately from the recorded verdict
  ([offline verification](docs/offline-verification.md), #18).
- Sanitized, checksummed CI evidence bundles: packaged after each showcase job, uploaded with a
  commit-pinned action, read back through the GitHub API, downloaded into a separate directory and
  re-verified offline by the `verify-evidence` job (#19).
- Installable package layout (`files` allowlist), a fail-closed runtime check that the installed
  OffCKB bundle carries the shipped security patch, and the consumer
  [installation guide](docs/install.md) (#20).
- `scripts/acceptance-matrix.sh`: a repository-owned matrix of real CLI processes covering cold/warm
  caches, repeatability, pinned-debugger rejection, assertion failure, tampered reports, occupied
  ports, concurrent exclusion and reuse, SIGINT cleanup, producer timeout, tampered debugger cache,
  download failure and recovery; `--consumer` runs it against the packed, installed package.
- Maintenance material: [release checklist](docs/release-checklist.md),
  [maintenance loop](docs/maintenance.md), bug report template, `scripts/release-rehearsal.sh` (#20, #21).

### Changed

- The shipped OffCKB patch now binds the RPC proxy (`28114`) to `127.0.0.1` instead of every
  interface; the supply-chain gate and the runtime installation check require the loopback-bound
  listen and reject the wildcard one (#15).
- The devnet adapter resolves the OffCKB CLI from `ckb-verify`'s own dependency tree instead of the
  verified project's `node_modules/.bin`.
- The cell-properties showcase wrapper tolerates hosts where IPv6 cannot bind, matching the runner's
  port preflight.

### Fixed

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
