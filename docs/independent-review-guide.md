# Independent review of the v0.1.0 candidate

Release gate on #20: someone outside the project reviews the frozen candidate before it is published. This page is for that reviewer. An agent pre-review already ran and its findings are fixed ([record](acceptance/2026-11-02-candidate-review.md)); it does not count as this review.

## What is being reviewed

- **Candidate:** `e311ad3db8cc58f751928f01c881646da45f5a72` in `Akane-CN/spark-verify`, version `0.1.0`, unpublished.
- **What it claims:** `ckb-verify` runs a repository's `verify.toml` on a fresh local OffCKB devnet. It writes a `report.json` whose claims, verdict, and environment anyone can re-check offline. **PASS means every declared claim passed in the recorded environment.** That is not a security audit or a sandbox.
- **What it does not claim** is listed in the [release notes draft](release-notes-draft.md#known-limitations). Judge the candidate against what it claims, not against a broader tool.

## 1. The 15-minute check (please time it)

The proposal estimates that a reviewer can verify the release in 15 minutes after the tools are downloaded, and asks for that estimate to be replaced with a real timing. On a Linux x64 host with Bun `1.2.19` and Node 22:

```bash
git clone https://github.com/Akane-CN/spark-verify.git && cd spark-verify
git checkout --detach e311ad3db8cc58f751928f01c881646da45f5a72
bun install --frozen-lockfile
bun run build
bun run verify:release
```

`verify:release` must end with `VERIFY RELEASE PASS` and nine `PASS` items. Each item maps to one of the proposal's verification points. Note the wall-clock time, and anything that was unclear or failed.

## 2. Check the published evidence without running anything

```bash
gh run download 41507235776 --repo Akane-CN/spark-verify -n release-evidence-e311ad3db8cc58f751928f01c881646da45f5a72 -D ev
(cd ev && sha256sum -c *.sha256)
bun run scripts/release-evidence.ts verify ev/release-evidence-e311ad3db8cc58f751928f01c881646da45f5a72.tar.gz \
  --source-sha e311ad3db8cc58f751928f01c881646da45f5a72 --repository Akane-CN/spark-verify
```

The archive must print `VALID` with four bundles and 21 reports. Then try to break it. Edit a report's verdict or a stored digest, re-pack it, and confirm the verifier refuses it ([offline verification](offline-verification.md)).

## 3. Where to look in the code, if you read it

- **Trust boundary:** `src/runner.ts` (the run lifecycle, the source guard, redaction) and `src/offckb.ts` (devnet ownership and cleanup).
- **Verifier:** `src/report.ts`, `src/claims-v3.ts`, and `src/cell-claims.ts`. Every verdict must be re-derived from raw inputs.
- **Bundles and archives:** `src/evidence-bundle.ts` and `src/release-evidence.ts` (file allowlists, checksums, extraction).
- **The frozen contract:** `docs/version-policy.md#the-frozen-v01-contract` and `tests/frozen-contract.test.ts`.

## 4. How to report

Comment on #20 with the title **Independent review of `e311ad3`**, covering:

- who you are and your relationship to the project (none is expected);
- what you ran, and the wall-clock time of step 1;
- findings, each marked **blocking** or **not blocking**, with a file and line or a command that reproduces it;
- a one-line verdict: *no blocking findings*, or *blocking findings above*.

A blocking finding stops the release: it is fixed, the candidate is re-frozen and re-gated, and you are asked to look at the fix. A security issue goes through the private channel in [`SECURITY.md`](../SECURITY.md#reporting-a-vulnerability), not the issue.
