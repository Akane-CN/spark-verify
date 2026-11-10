# Independent review of the v0.1.0 candidate

Release gate on #20: someone outside the project reviews the frozen candidate before it is published. This page is for that reviewer. An agent pre-review already ran and its findings are fixed ([record](acceptance/2026-11-02-candidate-review.md)); it does not count as this review.

## What is being reviewed

- **Candidate:** `9b39a9882b0b4250e713cce556eef0a7dc3809b8` in `Akane-CN/spark-verify`, version `0.1.0`, unpublished. It supersedes `e311ad3`, which was re-gated out after spec `0.2.0` was added ([decision](release-decisions.md#2026-11-03-decisions-2-3-and-4-reopened-the-rest-of-the-proposals-target-v01-ships-as-spec-020)).
- **What it claims:** `ckb-verify` runs a repository's `verify.toml` on a fresh local OffCKB devnet. It writes a `report.json` whose claims, verdict, and environment anyone can re-check offline. **PASS means every declared claim passed in the recorded environment.** That is not a security audit or a sandbox.
- **What it does not claim** is listed in the [release notes draft](release-notes-draft.md#known-limitations). Judge the candidate against what it claims, not against a broader tool.

## 1. The 15-minute check (please time it)

The proposal estimates that a reviewer can verify the release in 15 minutes after the tools are downloaded, and asks for that estimate to be replaced with a real timing. On a Linux x64 host with Bun `1.2.19` and Node 22:

```bash
git clone https://github.com/Akane-CN/spark-verify.git && cd spark-verify
git checkout --detach 9b39a9882b0b4250e713cce556eef0a7dc3809b8
bun install --frozen-lockfile
bun run build
bun run verify:release
```

`verify:release` must end with `VERIFY RELEASE PASS` and nine `PASS` items. Each item maps to one of the proposal's verification points. Note the wall-clock time, and anything that was unclear or failed.

## 2. Check the published evidence without running anything

```bash
gh run download 42730133984 --repo Akane-CN/spark-verify -n release-evidence-9b39a9882b0b4250e713cce556eef0a7dc3809b8 -D ev
(cd ev && sha256sum -c *.sha256)
bun run scripts/release-evidence.ts verify ev/release-evidence-9b39a9882b0b4250e713cce556eef0a7dc3809b8.tar.gz \
  --source-sha 9b39a9882b0b4250e713cce556eef0a7dc3809b8 --repository Akane-CN/spark-verify
```

The archive must print `VALID` with five bundles and 29 reports. Then try to break it. Edit a report's verdict or a stored digest, re-pack it, and confirm the verifier refuses it ([offline verification](offline-verification.md)).

## 3. Where to look in the code, if you read it

- **Trust boundary:** `src/runner.ts` (the run lifecycle, the source guard, redaction) and `src/offckb.ts` (devnet ownership and cleanup).
- **Verifier:** `src/report.ts`, `src/claims-v3.ts`, `src/claims-v4.ts`, and `src/cell-claims.ts`. Every verdict must be re-derived from raw inputs.
- **Spec `0.2.0` deployment:** `src/manifest-v6.ts` (the parser) and the deployment in `src/runner.ts` and `src/offckb.ts`. A deployed code Cell must be checked on chain against the binary's bytes.
- **Project setup and downloads:** `src/setup-project.ts` writes into a user's project; it must not overwrite a manifest or producer and must refuse a conflicting `package.json` value. `src/download-retry.ts` retries the two pinned downloads; a retried download must pass the same length and checksum checks.
- **The console:** `src/ui/server.ts`. It must bind `127.0.0.1`, refuse foreign Host names, require its token on every API call, and read nothing outside the listed manifests and run directories.
- **Bundles and archives:** `src/evidence-bundle.ts` and `src/release-evidence.ts` (file allowlists, checksums, extraction).
- **The frozen contracts:** `docs/version-policy.md#the-frozen-v01-contract` with `tests/frozen-contract.test.ts`, and `docs/version-policy.md#the-frozen-020-contract` with `tests/frozen-contract-v0.2.test.ts`.

## 4. How to report

Comment on #20 with the title **Independent review of `9b39a98`**, covering:

- who you are and your relationship to the project (none is expected);
- what you ran, and the wall-clock time of step 1;
- findings, each marked **blocking** or **not blocking**, with a file and line or a command that reproduces it;
- a one-line verdict: *no blocking findings*, or *blocking findings above*.

A blocking finding stops the release: it is fixed, the candidate is re-frozen and re-gated, and you are asked to look at the fix. A security issue goes through the private channel in [`SECURITY.md`](../SECURITY.md#reporting-a-vulnerability), not the issue.
