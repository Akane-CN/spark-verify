# External checkpoints

The [roadmap (#13)](https://github.com/Akane-CN/spark-verify/issues/13) runs an upstream and pilot track beside core maintenance and reviews it twice: at the end of **week 3** and the end of **week 8** of the planning window that opened on 2026-10-02. Each review records one of three states per track, with its evidence, so that nobody has to infer the external situation from silence or from internal work:

- **consented participation**: a public, attributable reply from the named external party, linked here;
- **no response**: the question was published (link) and the review date passed without a reply;
- **no outreach sent**: no question has been published, because publication has its own approval and none was given;
- **no-go**: an explicit external decline, or a maintainer decision to stop asking, linked here.

Internal showcases, merged feasibility probes, and committee review of the grant proposal are never counted as upstream feedback or adoption. External silence does not block core maintenance or an accurately scoped release; it only keeps the corresponding claims out of the release notes.

## Record

| Checkpoint | Due | Recorded | Upstream fit (#2) | External pilot (#3) |
| --- | --- | --- | --- | --- |
| Week 3 | 2026-10-23 | 2026-10-30 (late) | no outreach sent; no response | no outreach sent; no consent |
| Week 8 | 2026-11-27 | 2026-11-02 (early, at the maintainer's request) | no outreach sent; no response | no outreach sent; no consent |

### Week 3 (recorded 2026-10-30)

**Upstream fit, [#2](https://github.com/Akane-CN/spark-verify/issues/2).** No public discussion has been opened with the OffCKB maintainers and no maintainer response exists; #2 has no comments and no linked external thread. The roadmap asked for a short evidence-backed question to be prepared in week 1 and required a separate publication approval before posting it; the question is drafted below and the approval has not been requested or given. Until a response exists the runner keeps its **provisional thin-CLI boundary**: a standalone package that drives the unmodified OffCKB CLI (`node`, `node stop`, `clean`, `system-scripts`, `debug`) plus one shipped dependency patch, as recorded in the [RFC implementation matrix](rfc-implementation-matrix.md#9-open-questions-and-deferred-scope) and [RFC §9 question 1](verify-toml-rfc-v0.2.md#9-open-questions). Nothing in this state is endorsement.

**External pilot, [#3](https://github.com/Akane-CN/spark-verify/issues/3).** No project maintainer has been asked for consent and none has given it. The merged [CKB-UGMP showcase](../showcases/ckb-ugmp/) is an independently prepared feasibility adaptation of a pinned public revision and stays labeled as such; it is not a pilot, adoption, or endorsement. #3 was closed automatically on 2026-10-28 when the showcase pull request merged with a closing reference, and was reopened with this record because its consent criterion is unmet.

**Context, not a checkpoint result.** The Spark proposal thread on [Nervos Talk](https://talk.nervos.org/t/spark-program-spark-verify-reproducible-acceptance-checks-for-ckb-projects/10598) is active: on 2026-10-27 a committee member wrote that more details need discussion and that other members would be in contact. That is grant review, not OffCKB feedback or a project pilot, and it changes neither state above.

### Week 8 (due 2026-11-27, recorded early on 2026-11-02)

The maintainer asked on 2026-11-02 for this checkpoint to be recorded, 25 days before its due date. It states what is true on 2026-11-02. If an external party replies, or the maintainer approves outreach or a pilot request, before 2026-11-27, a dated amendment below supersedes this entry; otherwise it stands as the week-8 result.

**Upstream fit, [#2](https://github.com/Akane-CN/spark-verify/issues/2).** Unchanged since week 3. No question has been posted to an OffCKB repository or forum, #2 carries only the week-3 record, and no external thread is linked. The state is **no outreach sent; no response**. The runner keeps its provisional thin-CLI boundary, which is now also the boundary of the frozen `0.1.0` contract ([version policy](version-policy.md#the-frozen-v01-contract)). The draft question below still describes the shipped runner accurately and still needs the maintainer's publication approval.

**External pilot, [#3](https://github.com/Akane-CN/spark-verify/issues/3).** Unchanged since week 3. No project maintainer has been asked for consent and none has given it, and #3 carries only the week-3 record. The state is **no outreach sent; no consent**. It is not a no-go: there is no external decline and no maintainer decision to stop asking. The CKB-UGMP showcase keeps its feasibility label, and the [release notes draft](release-notes-draft.md) already states that no external pilot ran. Deliverable 4 stays external in the [proposal coverage](proposal-coverage.md): recording that nobody was asked is not the proposal's "transparent demand/no-go report", which needs outreach to measure demand.

**Context, not a checkpoint result.** The newest post in the Spark proposal thread on [Nervos Talk](https://talk.nervos.org/t/spark-program-spark-verify-reproducible-acceptance-checks-for-ckb-projects/10598) is still the committee note of 2026-10-27, which said other members would make contact that week; no follow-up had been posted by 2026-11-02. That is grant review and changes neither state.

**What would change these states.** Only maintainer decisions can: approving the draft question for publication (#2), approving a consent request to a named project maintainer (#3), or deciding to stop asking, which would record a no-go. A consented pilot counts only if it is reproducible from a clean checkout, has a maintainer-visible result, and records vocabulary and setup friction.

## Draft upstream question (not published)

Prepared for #2. Posting it to an OffCKB repository or forum requires the maintainer's explicit publication approval; this file is the draft, not the post.

> **Subject:** feedback request: an external acceptance-check runner on top of the OffCKB CLI
>
> `ckb-verify` runs a repository's `verify.toml` on a fresh OffCKB `0.4.13` devnet and writes a report whose claims and environment can be re-verified offline (RFC 8785 digests, published JSON Schemas). It drives the unmodified CLI: `offckb node --binary-path … --daemon`, `offckb system-scripts --output …`, `offckb debug --tx-hash … --single-script …`, `offckb node stop`, `offckb clean`. Source and evidence: <https://github.com/Akane-CN/spark-verify> (RFC `docs/verify-toml-rfc-v0.2.md`, matrix `docs/rfc-implementation-matrix.md`).
>
> Four questions, each with what we currently do:
>
> 1. **Package boundary.** Should this stay a thin external package, become an OffCKB subcommand or plugin, or should only the manifest/report formats and a conformance suite be published? Today it is a standalone package.
> 2. **Shipped patch.** The runner installs `@offckb/cli@0.4.13` with a package patch that redirects the bundled `adm-zip`, `tar`, and `follow-redirects` imports to patched releases and binds the RPC proxy (`28114`) to `127.0.0.1` instead of every interface (`patches/@offckb%2Fcli@0.4.13.patch`, rationale in `SECURITY.md`). Would upstream accept these as changes, so the patch can be dropped?
> 3. **Built-in script references.** Reports resolve `builtin = "spore"` and similar references from `offckb system-scripts` output and record the resolved code hash, hash type, and cell deps. Is that export the intended stable interface, and is `--json` output on `node`/`debug` meant for automation?
> 4. **Rejected transactions.** The runner replays rejected scripts with a pinned `ckb-debugger 1.1.1` and records the error code and group. Are there proxy or debug artifacts OffCKB intends tools to rely on for this, rather than re-running the debugger?
>
> A "keep it external" answer is as useful as any other; we will record whichever decision you give in the RFC.
