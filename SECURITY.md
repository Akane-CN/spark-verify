# Security policy

## Pre-release status

Spark Verify is currently a specification draft. No released CLI exists. Security reports about future behavior should begin as design issues until implementation starts.

## Core trust boundary

A `verify.toml` file can contain `run` commands. Running Spark Verify therefore executes code from the target repository with the current operating-system user's permissions.

**A passing report does not mean the repository is safe.** It means the runner evaluated the declared claims and observed passing values.

## Safe-use rules for v0.1

- Run only repositories and revisions you trust.
- Use an isolated machine, VM, container, or disposable CI runner.
- Remove production wallets, API tokens, cloud credentials, SSH agents, and unrelated secrets.
- Never point a manifest at mainnet or testnet. v0.1 must accept only a fresh loopback OffCKB devnet with the expected genesis fingerprint.
- Treat `SPARK_VERIFY_ACCOUNTS` keys as public devnet test keys. Never fund them with real assets.
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

1. RPC URL is loopback.
2. Node genesis/config fingerprint matches the fresh run.
3. Production address prefixes or external private-key inputs are rejected.
4. The account context is clearly marked `devnet_only`.
5. Cleanup targets only the run-specific temporary directory.

External network denial is recommended in CI but may not be enforceable portably in the MVP. The report must not imply a sandbox when none was applied.

## Hash and replay limitations

The outcome digest is tamper-evident only for the normalized claim definitions, relevant artifact identities, and observations it covers. The environment fingerprint is tamper-evident only for the recorded environment object. Replay status qualifies known drift and the required author declaration in `[replay].dependencies`, but cannot detect every dependency of arbitrary repository code. An empty declaration is an attestation, not proof of determinism.

None of these fields is a signature, an audit, a proof of completeness, evidence that the environments were actually secure, or evidence that unrecorded side effects did not occur. A malicious author can omit important assertions or lie about undeclared dependencies.

## Reporting a vulnerability

Once implementation starts, report vulnerabilities privately to [akane@random-walk.co.jp](mailto:akane@random-walk.co.jp). Do not include private keys, production wallet material, or weaponized proof-of-concept details in a public issue. A minimal public issue may state that a private report was sent without disclosing the vulnerability.
