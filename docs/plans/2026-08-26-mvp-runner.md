# CKB Verify MVP Runner Implementation Plan

> **For Hermes:** Use subagent-driven-development and test-driven-development to implement this plan task-by-task.

**Goal:** Deliver a working Bun/TypeScript CLI that runs a trusted repository command, receives exactly one signed CKB JSON-RPC transaction through a result file, submits it to a fresh OffCKB `0.4.13` devnet, evaluates committed/rejected and live-Cell claims, and emits independently recomputable canonical outcome/environment digests.

**Architecture:** Keep the runner thin. Pure modules parse and normalize the implemented `verify.toml` subset, canonicalize/hash report objects, parse CKB RPC responses, and evaluate claims. Side-effectful adapters own child processes, OffCKB lifecycle, Git/runtime provenance, and report file writes. The initial real fixture uses deterministic OffCKB dev accounts and CCC to produce one valid transfer and one signature-invalid rejected transaction; project commands never submit transactions themselves.

**Tech Stack:** Bun 1.2+, TypeScript, `bun:test`, `@ckb-ccc/core`, `@offckb/cli@0.4.13`, `json-canonicalize`, OffCKB/CKB JSON-RPC.

---

## MVP contract and exclusions

Implemented manifest paths:

- `[meta]`: `name`, `spec = "0.1.0-draft.3"`
- `[toolchain]`: exact `ckb`, exact `offckb = "0.4.13"`
- `[replay]`: `dependencies = []` only in the feasibility slice
- `[setup]`: `accounts` from 1 through 20
- `[[step]]`: `name`, `run`, optional `timeout`, `expect.tx`
- `[step.expect.error]`: optional `code`; normalized group evidence is recorded even before named-script matching is implemented
- `[[step.assert.cell]]` and `[[assert.cell]]`: `out_point = { step, index }`, exact `count`

Result protocol:

```json
{"protocol":1,"transaction":{"version":"0x0","cell_deps":[],"header_deps":[],"inputs":[],"outputs":[],"outputs_data":[],"witnesses":[]}}
```

The runner injects the canonical `CKB_VERIFY_*` variables. Commands receive a read-only loopback query facade when implemented; the feasibility showcase initially receives the local node query endpoint and cannot count as isolated CI for untrusted repositories. The CLI must print that it executes trusted repository code.

Explicitly excluded from this PR: browser wallet automation, public networks, hosted dependencies, arbitrary OffCKB versions, script deployment, balance/UDT assertions, multi-transaction steps, generic plugins, dashboards, signed attestations, package publication, and security/audit verdicts.

---

### Task 1: Bootstrap the Bun package and CLI contract

**Objective:** Establish an installable `ckb-verify` package with deterministic scripts and a CLI that exposes version/help without side effects.

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/cli.ts`
- Create: `src/version.ts`
- Test: `tests/cli.test.ts`
- Modify: `.gitignore`

**TDD steps:**

1. Write a subprocess test expecting `bun run src/cli.ts --version` to print `0.0.1` and `--help` to mention `run [manifest]`.
2. Run the focused test and verify it fails because the package/CLI is absent.
3. Add the minimal package metadata, shebang CLI parser, and exported version.
4. Run the focused test, then the full unit suite.
5. Commit `feat: bootstrap ckb-verify CLI`.

### Task 2: Parse and strictly validate the manifest subset

**Objective:** Convert TOML bytes into a normalized, typed manifest while rejecting unknown keys, vacuous claims, duplicate steps, unsupported versions, invalid timeouts, and invalid output references.

**Files:**

- Create: `src/errors.ts`
- Create: `src/manifest.ts`
- Create: `src/types.ts`
- Test: `tests/manifest.test.ts`
- Create: `tests/fixtures/manifests/valid.toml`
- Create invalid TOML fixtures under: `tests/fixtures/manifests/invalid/`

**TDD tracer bullets:**

1. Valid minimal committed step parses and normalizes.
2. Unknown root/nested keys fail with a path-specific message.
3. Empty claim set fails.
4. Duplicate step names fail.
5. Cell output reference to an unknown/later step or negative index fails.
6. Only exact OffCKB `0.4.13` and spec `0.1.0-draft.3` are accepted.
7. Timeout accepts integer seconds or `<n>s`, bounded to a safe range.

For every bullet: write one failing test, run RED, add only enough implementation for GREEN, run focused plus full tests, refactor while green.

Commit `feat: validate MVP manifest subset`.

### Task 3: Produce RFC 8785 canonical hashes and stable report objects

**Objective:** Build separately canonicalized outcome and environment objects and SHA-256 digests that can be recomputed from the emitted report.

**Files:**

- Create: `src/canonical.ts`
- Create: `src/report.ts`
- Test: `tests/canonical.test.ts`
- Test: `tests/report.test.ts`

**TDD tracer bullets:**

1. RFC 8785 fixture canonicalizes to the expected bytes.
2. SHA-256 uses `sha256:<lowercase hex>`.
3. Outcome digest excludes timestamps, durations, absolute paths, and raw transaction hashes.
4. Environment fingerprint changes when a recorded tool version changes.
5. Recompute functions reject an embedded digest that does not match its canonical object.

Commit `feat: add canonical evidence digests`.

### Task 4: Implement process and JSON-RPC primitives

**Objective:** Run repository commands with timeout/output capture and make safe JSON-RPC calls with typed errors.

**Files:**

- Create: `src/process.ts`
- Create: `src/rpc.ts`
- Test: `tests/process.test.ts`
- Test: `tests/rpc.test.ts`

**TDD tracer bullets:**

1. Process runner returns stdout/stderr/exit code.
2. Timeout terminates the child process tree and reports a no-verdict execution error.
3. RPC helper returns `result` and preserves structured error code/data/message.
4. Transaction polling recognizes committed/rejected/timeout states.
5. Result envelope loader requires atomic final JSON shape, protocol `1`, and exactly the CKB JSON-RPC transaction keys.

Commit `feat: add process and RPC primitives`.

### Task 5: Add the OffCKB 0.4.13 lifecycle adapter

**Objective:** Start and stop an isolated fresh OffCKB devnet, parse programmatic account/system-script output, and record observed environment metadata.

**Files:**

- Create: `src/offckb.ts`
- Create: `src/provenance.ts`
- Test: `tests/offckb.test.ts` (unit parsing tests)
- Test: `tests/provenance.test.ts`
- Create: `scripts/offckb-integration.ts`

**TDD tracer bullets:**

1. Parse OffCKB JSON-line result envelopes without accepting human log lines as data.
2. Resolve requested dev accounts and reject private-key-free/account-short output.
3. Normalize `system-scripts --output` into code hash/hash type/cell dep records.
4. Sanitize Git remote userinfo and record commit/dirty-state digest.
5. Lifecycle cleanup runs after success, assertion failure, command failure, and signal.

**Real verification:** Run exact local `@offckb/cli@0.4.13` commands against an isolated data directory, capture actual output, and adjust parser tests only from observed facts. Do not mock the final lifecycle run.

Commit `feat: manage isolated OffCKB devnet`.

### Task 6: Implement runner-owned submission and claim evaluation

**Objective:** Execute ordered steps, accept one signed result file, submit through OffCKB proxy, normalize terminal evidence, evaluate exact live-Cell count assertions, and always emit a report.

**Files:**

- Create: `src/runner.ts`
- Create: `src/claims.ts`
- Test: `tests/runner.test.ts`
- Test: `tests/claims.test.ts`
- Modify: `src/cli.ts`

**TDD tracer bullets:**

1. Successful command + committed submission passes `expect.tx = "committed"`.
2. Structured node script rejection passes `expect.tx = "rejected"` and matching code.
3. Committed when rejected was expected produces a claim failure, not an execution error.
4. Malformed/missing result file produces no verdict and nonzero CLI exit.
5. Referenced output `count = 1` resolves to `get_live_cell` status `live`.
6. Deliberately wrong `count = 0` produces a report with `pass = false` and distinct outcome digest.
7. `finally` cleanup and report write execute on every terminal path.

Commit `feat: run signed CKB acceptance claims`.

### Task 7: Build real committed/rejected conformance fixtures

**Objective:** Demonstrate the complete runner path using fresh OffCKB and CCC instead of mocks.

**Files:**

- Create: `showcases/secp-transfer/produce.ts`
- Create: `showcases/secp-transfer/verify.committed.toml`
- Create: `showcases/secp-transfer/verify.rejected.toml`
- Create: `showcases/secp-transfer/verify.assertion-failure.toml`
- Create: `tests/integration/runner.test.ts`
- Modify: `package.json`

**Producer behavior:**

1. Read deterministic dev account and RPC context files supplied by the runner.
2. Build a small transfer from account 0 to account 1 with CCC.
3. Complete fee and sign without submitting.
4. For the rejected fixture, corrupt only the signed witness after transaction construction so the transaction remains parseable but fails the lock script.
5. Atomically write the versioned result envelope.

**Real verification:**

- committed fixture reaches committed and its output remains live;
- rejected fixture is retained and records normalized script rejection/code plus cycles when OffCKB/ckb-debugger exposes them;
- wrong assertion exits with claim-failure status while preserving report evidence.

Commit `test: add real OffCKB conformance fixtures`.

### Task 8: Prove repeatability and version-drift behavior

**Objective:** Run clean fixtures repeatedly and compare canonical evidence.

**Files:**

- Create: `scripts/verify-repeatability.ts`
- Test: `tests/integration/repeatability.test.ts`
- Modify: `src/report.ts`

**Acceptance:**

1. Two clean committed runs produce equal outcome digests.
2. Two clean runs with identical recorded environment inputs produce equal environment fingerprints.
3. A synthetic recorded-version drift changes only the environment fingerprint while preserving the outcome digest.
4. Both report digests recompute successfully from embedded canonical objects.

Commit `test: prove MVP report repeatability`.

### Task 9: Document the working slice and automate CI

**Objective:** Replace pre-implementation-only messaging with exact supported behavior, safety boundaries, and verification commands.

**Files:**

- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/verify-toml-rfc-v0.2.md` only where implementation status must be distinguished
- Create: `.github/workflows/ci.yml`
- Create: `CHANGELOG.md`

**Verification:**

1. `bun install --frozen-lockfile`
2. `bun test`
3. `bun run typecheck`
4. `bun run lint` or formatting check selected by package scripts
5. `bun run test:integration`
6. `./scripts/validate-docs.sh --require-external-links`
7. `git diff --check`

Commit `docs: publish MVP runner verification path`.

### Task 10: Independent review, PR, and handoff

**Objective:** Land a reviewable external artifact backed by fresh local and hosted evidence.

**Steps:**

1. Run static secret/injection scan over added lines.
2. Dispatch an independent spec-compliance reviewer over `origin/main...HEAD`.
3. Fix all blocking gaps and rerun the reviewer.
4. Dispatch an independent code-quality/security reviewer.
5. Fix all blocking issues and rerun complete verification.
6. Push `feat/mvp-runner` as `Akane-CN`.
7. Open one PR linked to issue `#1`; mention that issue `#2` system-script evidence is recorded but maintainer outreach remains separate, and issue `#3` CKB-UGMP adoption remains a follow-up PR.
8. Capture live PR head/check state, perform Akane review, and enable squash auto-merge only if required checks and review policy allow it.

---

## Completion definition

The MVP is complete only when a fresh real run—not a mocked or fabricated transcript—has produced:

- one committed transaction report;
- one rejected signed transaction report retained after node rejection;
- one failed live-Cell assertion report;
- recomputable outcome/environment SHA-256 digests;
- clean full test/type/doc validation output;
- a GitHub PR whose head SHA matches the verified local commit.
