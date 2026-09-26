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
- Review produced artifacts before publishing them. Reports and logs must redact environment values, URL credentials, remote userinfo, and private material not explicitly part of the public devnet context.

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

The pinned OffCKB `0.4.13` proxy advertises a loopback URL but binds proxy port `28114` on the wildcard interface. `ckb-verify` currently cannot narrow that inherited bind. Keep the host firewalled or use a disposable VM/container whose devnet ports are unreachable from untrusted networks.

External network denial is recommended in CI but may not be enforceable portably in the MVP. The report must not imply a sandbox when none was applied.

## Toolchain supply-chain controls

`ckb-verify` does not let OffCKB fetch an unverified CKB archive. For the supported CKB `0.209.0` toolchain, it selects a platform-specific official GitHub Release asset whose byte length and SHA-256 digest are pinned in `src/ckb-binary.ts`. It verifies the complete archive before extraction; rejects traversal paths, links, device nodes, and unknown entry types; and records the platform, architecture, expected and observed archive digests, and extracted binary digest. OffCKB starts with `--binary-path`, so the verified binary is the one actually executed.

OffCKB `0.4.13` bundles vulnerable archive-library versions. The committed Bun package patch redirects both active bundled `adm-zip` imports and both active bundled `tar` imports to the externally resolved `adm-zip@0.6.1` and `tar@7.5.22`; package overrides also force OffCKB's declared dependencies to those reviewed versions. `bun run check:supply-chain` verifies the versions actually resolved from the patched OffCKB bundle, checks all four patch markers, and validates the audit process status before evaluating its advisory data.

The audit gate fails on every finding except the exact low-severity `elliptic` advisory [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84). `elliptic@6.6.1` is a transitive dependency through `@ckb-ccc/core` → `@joyid/ckb` → `@nervosnetwork/ckb-sdk-utils`, and no fixed release currently exists. This temporary waiver is limited to the current feasibility runner and its disposable devnet keys; it does not permit production-wallet use. A changed severity, advisory identity, URL, package, or any additional finding fails the gate and requires a new review.

## Hash and replay limitations

The outcome digest is tamper-evident only for the normalized claim definitions, relevant artifact identities, and observations it covers. The environment fingerprint is tamper-evident only for the recorded environment object. Replay status qualifies known drift and the required author declaration in `[replay].dependencies`, but cannot detect every dependency of arbitrary repository code. An empty declaration is an attestation, not proof of determinism.

None of these fields is a signature, an audit, a proof of completeness, evidence that the environments were actually secure, or evidence that unrecorded side effects did not occur. A malicious author can omit important assertions or lie about undeclared dependencies.

## Reporting a vulnerability

Once implementation starts, report vulnerabilities privately to [akane@random-walk.co.jp](mailto:akane@random-walk.co.jp). Do not include private keys, production wallet material, or weaponized proof-of-concept details in a public issue. A minimal public issue may state that a private report was sent without disclosing the vulnerability.
