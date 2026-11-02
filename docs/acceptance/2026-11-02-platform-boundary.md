# macOS and Windows boundary record, 2026-11-02

The proposal promises Ubuntu, macOS, and Windows support statements backed by execution. Ubuntu is covered by every CI job, the acceptance matrices, and the rehearsals. This record covers the other two, from `.github/workflows/platform-boundary.yml` run 41387777640 on commit `904658c` (PR #37), both jobs PASS.

| | macOS | Windows |
| --- | --- | --- |
| Hosted image | `macos-14-arm64` 20260831.0302.1 (macOS 14.8.9) | `windows-2022` 20261025.346.1 (Windows Server 2022 Datacenter 10.0.20348) |
| Bun | 1.2.19 | 1.2.19 |
| `bun install --frozen-lockfile`, `bun run typecheck` | PASS | PASS |
| Platform-independent tests (17 files, including the frozen-contract test) | 555 pass, 0 fail | 555 pass, 0 fail |
| `validate verify.toml` and the `0.1.0` conformance manifest | VALID under the strict `0.1.0` grammar | VALID under the strict `0.1.0` grammar |
| `digest` of the historical report/1 and the golden `0.1.0` report/3 | both VALID | both VALID |
| `run verify.toml` | exit 2, `requires Linux x64 with Bun; darwin/arm64 is not supported`, no `.ckb-verify` directory, clean tree | exit 2, `requires Linux x64 with Bun; win32/x64 is not supported`, no `.ckb-verify` directory, clean tree |

**The statements this supports.** On macOS and Windows a repository checkout installs and the offline commands work: `validate`, `digest`, `check-digest`, and `check-bundle` (the last two through the tests that drive the CLI). `run` is refused before it writes anything. Devnet execution is supported on Linux x64 only. The packed-tarball installation path is exercised on Linux x64 only.

**What the first runs found.** The macOS job also passed on `main` (run 41384894453) and on `e025425`. The Windows job failed its first two runs, and both failures were real defects in offline verification, fixed in this PR rather than excluded from the job:

1. On `e025425`, 9 tests failed because bundle verification compared `\`-separated walk paths with the `/`-separated names in `bundle.json` and `SHA256SUMS`, so every valid bundle failed on Windows. Fixed in `b615f4f`.
2. On `b615f4f`, 3 tests failed with `EINVAL` because node-tar opens small files on Windows with `UV_FS_O_FILEMAP`, which Bun rejects, so release-evidence extraction could not write. Fixed in `904658c` by listing and validating the archive before writing anything.

Before this PR, `run` on these platforms created the run directory and copied the manifest before refusing; the refusal now comes first and the job asserts that nothing is written.
