---
name: Bug report
about: A reproducible problem with the runner, a report, or the offline commands
labels: bug
---

# Bug report

<!-- Never paste private keys, account files, .env contents, tokens, or whole environment dumps.
     A sanitized report.json is enough; the runner already redacts OffCKB development keys. -->

## Versions

- `ckb-verify --version`:
- Report `schema` and `evidence.spec` (from `ckb-verify digest <report> --json`):
- Bun (`bun --version`) and Node (`node --version`):
- OS and architecture (`uname -sm`); container/VM if any:

## Reproduction

- Manifest (`verify.toml`) or the showcase name:
- Producer command or fixture (a minimal one if possible):
- Exact command run and its exit code:

## Observed

<!-- stderr/stdout of the failing command; the `problem:` lines of `digest`/`check-digest` if relevant -->

## Expected

## Evidence

- Sanitized `report.json` (attach) or the `outcome:`/`environment:` digests:
- Source revision of the project that ran it (`git rev-parse HEAD`) and whether the tree was clean:
