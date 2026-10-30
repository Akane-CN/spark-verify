# Security policy

## Pre-release status

Spark Verify now includes an unreleased `ckb-verify` feasibility implementation. Its supported manifest subset and trust boundary are documented in the README; broader RFC behavior is not implemented merely because it appears in a draft.

## Core trust boundary

A `verify.toml` file can contain `run` commands. Running `ckb-verify` therefore executes code from the target repository with the current operating-system user's permissions.

**A passing report does not mean the repository is safe.** It means the runner evaluated the declared claims and observed passing values.

## Safe-use rules for v0.1

- Run only repositories and revisions you trust.
- Use an isolated machine, VM, container, or disposable CI runner.
- Remove production wallets, API tokens, cloud credentials, SSH agents, and unrelated secrets.
- Never point a manifest at mainnet or testnet. v0.1 starts its own fresh loopback OffCKB devnet and records the observed genesis fingerprint, but it does not yet compare that fingerprint with an independent allowlist.
- Treat `CKB_VERIFY_ACCOUNTS` keys as public devnet test keys. Never fund them with real assets.
- Do not run a contributor's modified manifest or scripts in a privileged `pull_request_target` workflow.
- Pin Action revisions and package/tool versions; do not execute an unpinned `latest` dependency in acceptance CI.
- Review produced artifacts before publishing them. Exclude unrelated credentials before execution/canonicalization. Do not redact and rehash retained signed evidence to make it publishable; withhold unsafe artifacts and rerun safely.

## GitHub Actions guidance

A safe default is a workflow on trusted pushes after review. If pull-request checks are needed:

- use the `pull_request` event, not `pull_request_target`;
- grant `contents: read` only;
- expose no repository/environment secrets;
- use an ephemeral hosted runner;
- do not persist package-manager credentials;
- upload only explicitly selected report files.

A fork pull request is untrusted code even if its `verify.toml` looks harmless; the referenced `run` command or package lifecycle scripts can execute arbitrary code.

## Network and wallet protections

The runner design requires:

1. The runner obtains RPC and proxy URLs from a fresh OffCKB devnet and requires loopback HTTP endpoints.
2. The report records the observed genesis hash, CKB version, OffCKB system scripts, and source revision.
3. The runner supplies only freshly selected OffCKB development accounts; arbitrary trusted repository code can still access its ambient process environment and filesystem.
4. Producer logs and evidence are checked against the selected development private keys, matches are redacted, and the account file is removed on shutdown.
5. Runtime cleanup targets the repository's ignored `.ckb-verify/` area through the pinned OffCKB adapter.

The producer receives the local node RPC URL for queries. The current feasibility implementation does not enforce a read-only RPC facade or network namespace, so runner-owned submission is a protocol for trusted code rather than a hostile-code security boundary.

The pinned OffCKB `0.4.13` proxy advertises a loopback URL but, unpatched, binds proxy port `28114` on the wildcard interface. The shipped OffCKB patch narrows that listen to `127.0.0.1`, and the supply-chain gate and the runtime installation check both require the loopback-bound listen and reject the wildcard one. The CKB node's RPC `8114` is loopback-only; its peer-to-peer port `8115` still follows OffCKB's devnet configuration. Loopback binding is listener scope, not a sandbox: keep the host firewalled or use a disposable VM/container for anything beyond trusted code.

External network denial is recommended in CI but may not be enforceable portably in the MVP. The report must not imply a sandbox when none was applied.

## Runtime ownership boundary

The Linux x64 / Bun adapter holds the abstract Unix socket `@ckb-verify-offckb-8114-28114` (`@` denotes the leading NUL byte) in the **network namespace**, before any OffCKB runtime mutation. The name is fixed, not derived from the checkout, UID, HOME, or temporary directory. All cooperating users and checkouts in that namespace contend for the same kernel resource. There is no lock file to unlink, PID to reuse, TTL to expire, or stale-owner process to signal. Only the acquiring adapter may invoke shutdown or remove its account file; a losing adapter's `stop()` is a no-op.

This is cooperative exclusion, not authorization. Another user can reserve the abstract name and deny service; trusted code or a privileged user can bypass the protocol. Port preflight checks both `8114` and `28114` using IPv4/IPv6 wildcard bind probes and fails closed on a conflict or an inability to check. The probes cannot reserve the ports through OffCKB's later bind, so a non-cooperating process can still race startup. The runner does not kill a listener to resolve a conflict. After a crash, a surviving daemon is treated as an occupied-port conflict, not automatically adopted or killed. Use a disposable environment and inspect orphaned processes before any manual recovery.

Separate network namespaces have separate ownership locks. Do not share a checkout's `.ckb-verify/` runtime directory between those namespaces; use separate checkouts/runtime files as well as isolated networks. The lock provides no network isolation, read-only RPC guarantee, or sandbox, and the loopback-bound proxy does not make the devnet a sandbox. macOS, Windows, other architectures, and non-Bun runtimes are not supported by this ownership adapter.

## Toolchain supply-chain controls

`ckb-verify` does not let OffCKB fetch an unverified CKB archive. For the supported CKB `0.209.0` toolchain, it selects a platform-specific official GitHub Release asset whose byte length and SHA-256 digest are pinned in `src/ckb-binary.ts`. It verifies the complete archive before extraction; rejects traversal paths, links, device nodes, and unknown entry types; and records the platform, architecture, expected and observed archive digests, and extracted binary digest. OffCKB starts with `--binary-path`, so the verified binary is the one actually executed.

OffCKB `0.4.13` bundles vulnerable archive-library versions and `follow-redirects@1.16.0`. The committed Bun package patch redirects both active bundled `adm-zip` imports, both active bundled `tar` imports, and the one active `follow-redirects` import to the externally resolved `adm-zip@0.6.1`, `tar@7.5.22`, and `follow-redirects@1.16.1`. Exact direct pins and overrides keep these replacements reproducible. The old module definitions remain in the generated bundle, but none of their bundled import calls remain; this is an import redirection, not an upstream rebuild. The redirect import is in bundled `http-proxy`'s web-incoming module; request use is conditional on `options.followRedirects`, which OffCKB's current RPC proxy does not enable. A lockfile override alone would not fix that embedded module.

The `ajv@8.20.0` dependency (a runtime dependency since the published schemas are checked by the offline commands) declares `fast-uri@^3.0.1`; an exact override selects the patched `3.1.9`, not the unsupported-for-this-parent `4.x` major. `http-proxy@1.18.1` declares `follow-redirects@^1.0.0`, so `1.16.1` is also within its supported range. Both are the first patched versions in their existing release lines for the findings assessed on 2026-10-26. `bun run check:supply-chain` checks the exact installed versions from the consumers' resolution contexts (OffCKB for the three patched imports, Ajv for `fast-uri`), requires all five patch markers, the loopback-bound proxy listen, and zero old import or wildcard listen calls, and validates the audit process status before evaluating its advisory data. Local loopback regression tests exercise the redirect import without running OffCKB or a devnet.

The audit gate fails on every finding except the exact low-severity `elliptic` advisory [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84), audit ID `1112030`, while its waiver is unexpired. `elliptic@6.6.1` is a transitive dependency through `@ckb-ccc/core` → `@joyid/ckb` → `@nervosnetwork/ckb-sdk-utils`; the registry still has no fixed release as of 2026-10-26. This temporary waiver is limited to the current feasibility runner and its disposable devnet keys; it does not permit production-wallet use. A changed severity, advisory identity, URL, package, or any additional finding fails the gate and requires a new review.

### Debugger integrity

Debugger support is deliberately limited to `1.1.1` on Linux/x64. `src/debugger-binary.ts` pins the official `ckb-debugger_v1.1.1_x86_64-unknown-linux-gnu.tar.gz` archive (2,523,369 bytes, SHA-256 `0dee02804af46386527c8bb94c2ee63592594ca1ec952ea42ffa9df07a9f005e`) and executable (7,582,264 bytes, SHA-256 `24641357274ca464ecd86fd63b715ad96b5490d27b5ca029df37511e435d96f0`). Preparation never executes bytes. An entirely absent cache can download; an existing incomplete or tampered cache fails closed without repair or an ambient fallback. Archive and executable are remeasured on cache reuse.

Only after successful devnet startup may the adapter prepare one private snapshot beneath the owned OffCKB data directory. It verifies that capability before `--version` and each debug call. The exact version output must match. Run-owned `offckb-nodejs/settings.json` preserves existing selected settings and points `tools.rootFolder` at that snapshot; malformed or changed settings fail. `OFFCKB_DEBUGGER_GUARD=1` suppresses OffCKB's ambient PATH probe. This does not use an invented `offckb config set tools...` option. Stop closes admission, drains complete native/filesystem/verification/process operations and failure cleanup, then cleans the node/endpoints, owned account/snapshot material, and lease. Cleanup uses a non-aborted context and reports multiple failures. It retains the verified cache.

These checks assume trusted code and caller-controlled directories; private copies and hash-before-dispatch do not defeat an actively hostile same-UID writer. Current environment `/3` + provenance `/2` records path-free expected and observed identities, or explicit `null` when unused. Legacy environment `/2` + provenance `/1` remains verifiable only with explicit opt-in and carries no new debugger-integrity guarantee. Neither version provides offline execution authenticity.

### Elliptic waiver governance

- **Owner:** Akane-CN, through the security contact below.
- **Review date:** 2026-10-26 (dependency and reachability assessment, not an independent security audit). The advisory concerns risky cryptographic primitives used for signing/verification; disposable devnet keys bound the accepted impact, not the underlying defect. A forced unrelated cryptographic implementation would require compatibility review, not an audit-only override.
- **Expiry and schedule:** 2026-11-25 at 00:00:00 UTC, a 30-day window. Reassess no later than expiry, and sooner on any affected dependency/advisory change, fixed upstream release, or proposed expansion beyond disposable devnet keys. The gate uses the current clock; only tests inject a clock.
- **Replacement/removal:** when a fixed `elliptic` release exists and is compatible with the parent, update the exact dependency path; otherwise migrate to a compatible upstream CCC/JoyID/CKB SDK release that removes the affected implementation. After frozen installation, full audit, and signing/verification regression checks prove that this advisory no longer affects the graph, delete the allowlist entry. An expanded trust boundary requires removal or separate security review before use, not inheritance of this exception.
- **Expired disposition:** if this advisory remains at or after expiry, `check:supply-chain` and `bun run check` fail closed and the candidate must not be released. There is no automatic renewal. Any time-bounded renewal requires the owner's explicit review of current advisory metadata, dependency paths, reachability, and upstream replacement options, with recorded rationale and updated dates in both this policy and the gate. A clean audit can pass after expiry; it does not renew the waiver.

## Installed-consumer boundary

A package manager applies `patchedDependencies` only from the installing project's own `package.json`, and some ignore a dependency's declaration entirely. An installed `ckb-verify` therefore verifies, before any devnet preflight, download, configuration, clean, or launch, that the OffCKB it resolved from its own dependency tree is `0.4.13`, that the bundle carries exactly the patched `adm-zip`, `tar`, and `follow-redirects` callsites, and that those libraries resolve to the audited versions. Failure is exit `2` with no verdict and no runtime mutation; the runner never repairs an install. The consumer must place and declare the shipped patch as described in [`docs/install.md`](docs/install.md). This check protects against an unpatched bundle, not against a hostile same-UID writer who can also edit the runner.

## Hash and replay limitations

The outcome digest is tamper-evident only for the normalized claim definitions, relevant artifact identities, and observations it covers. The environment fingerprint is tamper-evident only for the recorded environment object. Replay status qualifies known drift and the required author declaration in `[replay].dependencies`, but cannot detect every dependency of arbitrary repository code. An empty declaration is an attestation, not proof of determinism.

None of these fields is a signature, an audit, a proof of completeness, evidence that the environments were actually secure, or evidence that unrecorded side effects did not occur. A malicious author can omit important assertions or lie about undeclared dependencies.

## Draft.4 retained evidence

[Draft.4 Cell claims](docs/cell-claims-draft.4.md) use report/outcome `/2` with unchanged environment `/3`, provenance `/2`, and producer envelope protocol 1. The generic DAO/plain fixture is not NervDAO adoption. It adds no dependency or deployment framework and does not weaken the trusted-code boundary. The initial offline implementation does not establish real DAO acceptance.

Type presence, args/data length and CellDep membership do not establish protocol semantics or prove VM execution. A committed fixture is bounded acceptance, not a generic script-execution attestation. `verifyReport` checks complete-artifact version/semantic consistency, including valid FAIL reports, not authenticity or a full deep schema; `verifyEvidenceDigests` is a v1-only component compatibility helper. A consistently rewritten report can still verify.

Report `/2` retains full signed transactions, witnesses and manifest text. Raw signed evidence may be sensitive. The scanner knows selected exported development keys, not arbitrary credentials. Known-key detection or cleanup failure withholds the pending/canonical report; never redact-and-rehash a report for publication. Keep immutable historical samples unchanged. The added CI job has no upload; public artifact policy/download verification remains #19.

Independent closeout checks must run after secondary report-audit failure: account/pending-report absence and IPv4/IPv6 port availability are separate checks. Do not terminate foreign listeners. The new repeat comparison preserves differing real genesis/deployment bindings; matching hashes do not independently authenticate or allowlist genesis.

## Reporting a vulnerability

Once implementation starts, report vulnerabilities privately to [akane@random-walk.co.jp](mailto:akane@random-walk.co.jp). Do not include private keys, production wallet material, or weaponized proof-of-concept details in a public issue. A minimal public issue may state that a private report was sent without disclosing the vulnerability.
