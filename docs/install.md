# Installing ckb-verify in your own project

This guide covers the one installation path that has been exercised end to end: **Linux x64, Bun 1.2.19, Node.js 20 or newer**, installing the packed tarball into a separate project. Other operating systems, architectures, Node-only execution, and other Bun versions are not supported merely because `engines` metadata or binary pins exist. Nothing here publishes a package; the package is unreleased and `private`.

## 1. Build or obtain the tarball

From a clean checkout of the verified revision:

```bash
bun install --frozen-lockfile
bun pm pack --destination dist
sha256sum dist/ckb-verify-0.0.2.tgz
```

The tarball contains only `src/`, `schemas/`, `patches/`, the user-facing docs, `SECURITY.md`, `LICENSE`, `README.md`, and `package.json`. Tests, showcases, CI configuration, and media are not shipped. Record the checksum next to the revision you packed; `ckb-verify --version` reports the packed version.

## 2. Declare the shipped OffCKB patch, then install

`ckb-verify` depends on `@offckb/cli@0.4.13`, whose bundled copies of `adm-zip` and `tar` have known advisories. The repository patches that bundle to use audited external versions and ships the patch file inside the package. Two facts shape the installation order:

- Bun resolves every `patchedDependencies` path, including the one declared by the `ckb-verify` package itself, **relative to the installing project**. If `patches/@offckb%2Fcli@0.4.13.patch` is absent from your project, `bun install` refuses with `could not find patch file` before anything is linked.
- Other package managers may ignore a dependency's patch declaration entirely. The runner therefore re-checks the installed bundle and the resolved library versions before every devnet start and fails closed (see step 3).

Extract the patch from the tarball and declare it explicitly before the first install:

```bash
mkdir my-project && cd my-project && git init
mkdir patches
tar -xzf ../path/to/ckb-verify-0.0.2.tgz -C patches --strip-components=2 'package/patches/@offckb%2Fcli@0.4.13.patch'
```

```jsonc
// package.json of your project
{
  "name": "my-project",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.2.19",
  "dependencies": {
    "ckb-verify": "file:../path/to/ckb-verify-0.0.2.tgz",
    "@ckb-ccc/core": "1.14.0"
  },
  "patchedDependencies": {
    "@offckb/cli@0.4.13": "patches/@offckb%2Fcli@0.4.13.patch"
  },
  "overrides": {
    "adm-zip": "0.6.1",
    "fast-uri": "3.1.9",
    "follow-redirects": "1.16.2",
    "tar": "7.5.22"
  }
}
```

```bash
bun install
./node_modules/.bin/ckb-verify --version                              # packed version
grep -c 'require("adm-zip")' node_modules/@offckb/cli/build/index.js  # prints 2
```

`@ckb-ccc/core` is only needed because the producer in this guide is written with it; the runner itself does not require it in your project. Keep the `overrides` so the external libraries resolve to the audited versions, and keep `packageManager` so the runner can record a pinned Bun version in each report's provenance; without a pin every report is marked `tainted` with `runtime_pin_missing`.

## 3. What the runtime gate refuses

Before any preflight, download, configuration, clean, or node launch, the runner verifies that the OffCKB it resolved **from its own dependency tree** is `0.4.13`, that its bundle contains exactly the patched `adm-zip`, `tar`, and `follow-redirects` callsites, and that those libraries resolve to `0.6.1`, `7.5.22`, and `1.16.2`. An unpatched or substituted bundle produces exit `2` and no verdict:

```text
ERROR: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable adm-zip import(s). The shipped patch must be active in the installing project (see docs/install.md); refusing to start a devnet.
```

Fix the patch declaration and reinstall; the runner does not repair installs. The consumer acceptance script (`scripts/acceptance-matrix.sh --consumer`) exercises both gates: the install-time refusal without the patch file and the runtime refusal of an unpatched bundle.

## 4. Write a producer and a manifest

The runner executes the `run` command of each step inside your project with `CKB_VERIFY_RESULT`, `CKB_VERIFY_RPC_URL`, `CKB_VERIFY_ACCOUNTS`, `CKB_VERIFY_SYSTEM_SCRIPTS`, and `CKB_VERIFY_CONTEXT` set. The command builds and signs a transaction and writes a protocol-1 envelope to `CKB_VERIFY_RESULT` without submitting it; the runner submits it. The secp transfer producer from this repository (`showcases/secp-transfer/produce.ts`) is a complete example and is what the consumer acceptance script installs.

```toml
[meta]
name = "my-transfer"
spec = "0.1.0-draft.4"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"
ckb-debugger = "1.1.1"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "transfer"
run = "bun run produce.ts committed"
timeout = "60s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "transfer", index = 0 }
count = 1
```

Read [`SECURITY.md`](../SECURITY.md) first: a manifest executes repository commands and the devnet is not a sandbox. Run only in a disposable environment with no production secrets.

## 5. Run, then verify offline

```bash
./node_modules/.bin/ckb-verify validate verify.toml      # nothing runs
./node_modules/.bin/ckb-verify run verify.toml           # exit 0 PASS, 1 FAIL, 2 no verdict
./node_modules/.bin/ckb-verify digest .ckb-verify/runs/<run>/report.json
```

The first run downloads the pinned CKB release (and the pinned debugger when a manifest declares `ckb-debugger`) into `.ckb-verify/offckb/` under your project; later runs reuse the verified cache. Reports record **your project's** git revision and lockfile as `provenance.source`/`provenance.lockfile`, and the installed runner's version as `environment.runner.version`; the two identities are deliberately separate. See [offline verification](offline-verification.md) for the `digest`, `check-digest`, and `check-bundle` commands and their exit codes.

## Known limits of the installed path

- Linux x64 with Bun 1.2.19 only. The runner refuses other platforms before touching the runtime.
- Node.js is required because the OffCKB CLI is a Node program; `node --version` must print 20 or newer.
- Ports `8114` and `28114` must be free; the runner never stops a foreign listener.
- The devnet cache lives under the project; cold runs need network access to GitHub releases.
- A `FAIL` report is a valid report. Exit code and verdict are distinct; see the offline verification guide.
