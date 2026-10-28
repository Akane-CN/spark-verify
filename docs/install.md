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

## 2. Install into a clean consumer project

```bash
mkdir my-project && cd my-project && git init
bun init -y
bun add ./path/to/ckb-verify-0.0.2.tgz @ckb-ccc/core@1.14.0
./node_modules/.bin/ckb-verify --version
```

`@ckb-ccc/core` is only needed because the producer in this guide is written with it; the runner itself does not require it in your project.

## 3. Activate the OffCKB security patch (required)

`ckb-verify` depends on `@offckb/cli@0.4.13`, whose bundled copies of `adm-zip` and `tar` have known advisories. The repository patches the bundle to use audited external versions, but **a package manager applies `patchedDependencies` only from the installing project's own `package.json`**. After step 2 your `node_modules/@offckb/cli` is therefore still unpatched, and `ckb-verify run` refuses to start a devnet:

```text
ERROR: OffCKB installation is not the verified patched build: OffCKB bundle retains 2 bundled vulnerable adm-zip import(s). The shipped patch must be active in the installing project (see docs/install.md); refusing to start a devnet.
```

Copy the shipped patch into your project and declare it, then reinstall:

```bash
mkdir -p patches
cp node_modules/ckb-verify/patches/@offckb%2Fcli@0.4.13.patch patches/
```

```jsonc
// package.json of your project
{
  "patchedDependencies": {
    "@offckb/cli@0.4.13": "patches/@offckb%2Fcli@0.4.13.patch"
  },
  "overrides": {
    "adm-zip": "0.6.1",
    "fast-uri": "3.1.9",
    "follow-redirects": "1.16.1",
    "tar": "7.5.22"
  },
  "packageManager": "bun@1.2.19"
}
```

```bash
bun install
grep -c 'require("adm-zip")' node_modules/@offckb/cli/build/index.js   # prints 2
```

Keep the `overrides` so the external libraries resolve to the audited versions. `packageManager` pins the Bun version the runner records in each report's provenance; without a pin every report is marked `tainted` with `runtime_pin_missing`. The runner re-checks the installed bundle and resolved versions before every devnet start, so a later `bun install` that drops the patch fails closed instead of silently running vulnerable archive code.

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
