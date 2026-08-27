# Showcases

Showcases are bounded, executable integrations that demonstrate what `ckb-verify` can prove today. Each showcase owns its project-specific producer commands and manifests while using the shared runner, OffCKB lifecycle, evidence model, and CLI.

A showcase is deliberately **not** a plugin API. We add a new abstraction only when a real project cannot use the existing repository-command boundary.

## Current showcases

| Showcase | Scope | Acceptance command |
| --- | --- | --- |
| [`secp-transfer`](secp-transfer/) | Committed transfer, genuine script rejection, intentional assertion failure, and semantic digest stability | `bun run showcase:secp-transfer` |
| [`ckb-ugmp`](ckb-ugmp/) | Fixed-revision CKB-UGMP Spore mint with fresh OffCKB identity injection, genuine rejection, intentional assertion failure, and digest stability | `bun run showcase:ckb-ugmp` |

## Showcase contract

A repository showcase should contain:

1. a README that states what the integration proves and does not prove;
2. one or more strict `verify.*.toml` manifests;
3. trusted project code that constructs and signs transactions without submitting them;
4. a `verify.sh` entry point that checks expected verdicts and exit codes;
5. fresh-devnet cleanup and independently recomputed report-digest checks;
6. no production secrets, public-network dependencies, or claims beyond the recorded assertions.

The producer interface is the canonical `CKB_VERIFY_*` environment documented in the [root README](../README.md). Runner-owned submission remains the seam between project-specific transaction construction and shared acceptance evidence.

## CKB-UGMP status and maintainer-consent boundary

The CKB-UGMP entry is a bounded repository-side adaptation of a fixed public revision, prepared independently at a grant cost of $0. It is feasibility evidence only—not maintainer consent, adoption, endorsement, or a funded pilot. The integration reuses the existing command boundary and does not justify a generic adapter system by itself.
