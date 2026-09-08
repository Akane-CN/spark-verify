# Showcases

Showcases are bounded, executable integrations that demonstrate what `ckb-verify` can prove today. Each showcase owns its project-specific producer commands and manifests while using the shared runner, OffCKB lifecycle, evidence model, and CLI.

A showcase is deliberately **not** a plugin API. We add a new abstraction only when a real project cannot use the existing repository-command boundary.

## Current showcase

| Showcase | Scope | Acceptance command |
| --- | --- | --- |
| [`secp-transfer`](secp-transfer/) | Committed transfer, genuine script rejection, intentional assertion failure, and semantic digest stability | `bun run showcase:secp-transfer` |

## Showcase contract

A repository showcase should contain:

1. a README that states what the integration proves and does not prove;
2. one or more strict `verify.*.toml` manifests;
3. trusted project code that constructs and signs transactions without submitting them;
4. a `verify.sh` entry point that checks expected verdicts and exit codes;
5. fresh-devnet cleanup and independently recomputed report-digest checks;
6. no production secrets, public-network dependencies, or claims beyond the recorded assertions.

The producer interface is the canonical `CKB_VERIFY_*` environment documented in the [root README](../README.md). Runner-owned submission remains the seam between project-specific transaction construction and shared acceptance evidence.

## Candidate external showcase: CKB-UGMP

A bounded Spore-mint adaptation is implemented in [PR #7](https://github.com/Akane-CN/spark-verify/pull/7). It reuses a fixed CKB-UGMP revision and the existing command boundary without adding a generic adapter system. Until that PR is reviewed and the upstream maintainer independently agrees to trial the format, it is feasibility evidence only—not adoption, endorsement, or a current `main` showcase.
