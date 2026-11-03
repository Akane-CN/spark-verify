# v0.1.0 release runbook (step 8)

The exact commands for [release checklist](release-checklist.md#8-publication-separately-authorized) step 8 on the frozen candidate `e311ad3`. Step 8 is approved on #20, and the release is a **GitHub release only**, with no npm package ([decision](release-decisions.md#2026-11-02-package-identity-and-publication-path)). The maintainer runs these commands; nothing here runs in CI.

## Before you start

- The **independent review** of `e311ad3` is recorded on #20 with no blocking finding (see the [review guide](independent-review-guide.md)). A blocking finding means a fix, a new candidate, new gates, and a new runbook.
- **Date:** the run must finish by **2026-11-24**. The `elliptic` waiver expires on 2026-11-25, and the supply-chain gate fails after that. A later release first needs a reviewed waiver renewal, which means a new candidate.
- **Host:** Linux x64 with Bun `1.2.19`, Node 22, `git`, and `gh` signed in as an account with write access to `Akane-CN/spark-verify`. Run `gh auth setup-git` once, so `git push` of the tag uses the same credentials.

```bash
export SHA=e311ad3db8cc58f751928f01c881646da45f5a72 V=0.1.0 RUN=41507235776 REPO=Akane-CN/spark-verify
```

## 1. Rebuild the tarball from the candidate and compare it

```bash
git clone https://github.com/$REPO.git release && cd release
git checkout --detach $SHA && test "$(git rev-parse HEAD)" = $SHA && test -z "$(git status --porcelain)"
bun install --frozen-lockfile
bun run check:supply-chain                       # must print: supply-chain gate passed
bun pm pack --destination dist
(cd dist && sha256sum ckb-verify-$V.tgz > SHA256SUMS && cat SHA256SUMS)
grep -q '^61fca14b5b00762021b13bd67049aed01da41e9b45053cdb08a554e2ee8eda0b  ckb-verify-0.1.0.tgz$' dist/SHA256SUMS && echo "tarball matches the gated candidate"
```

The tarball is byte-reproducible. If the checksum differs, stop: something other than the candidate is being packed.

## 2. Assemble and verify the release evidence

Use the durable CI archive, retained until 2027-01-31, plus the acceptance records committed on `main` after the candidate:

```bash
gh run download $RUN --repo $REPO -n release-evidence-$SHA -D ci
(cd ci && sha256sum -c release-evidence-$SHA.tar.gz.sha256)
bun run scripts/release-evidence.ts verify ci/release-evidence-$SHA.tar.gz --source-sha $SHA --repository $REPO
mkdir x && tar -xzf ci/release-evidence-$SHA.tar.gz -C x

git fetch origin main && mkdir records
git show origin/main:docs/acceptance/2026-11-02-candidate-e311ad3-source-matrix.md     > records/acceptance-source.md
git show origin/main:docs/acceptance/2026-11-02-candidate-e311ad3-release-rehearsal.md > records/rehearsal-2026-11-02.md
git show origin/main:docs/acceptance/2026-11-02-candidate-e311ad3-release-surface.md   > records/verify-release-2026-11-02.md
git show origin/main:docs/acceptance/2026-11-02-candidate-e311ad3.md                    > records/candidate-e311ad3.md

B=x/release-evidence/bundles
bun run scripts/release-evidence.ts assemble --out release-evidence-$V-$SHA.tar.gz \
  --bundle $B/evidence-secp-transfer-$SHA --bundle $B/evidence-cell-properties-$SHA \
  --bundle $B/evidence-ckb-ugmp-$SHA --bundle $B/evidence-vocabulary-$SHA \
  --record records/acceptance-source.md --record records/rehearsal-2026-11-02.md \
  --record records/verify-release-2026-11-02.md --record records/candidate-e311ad3.md \
  --repository $REPO --source-sha $SHA --run-id $RUN
bun run scripts/release-evidence.ts verify release-evidence-$V-$SHA.tar.gz --source-sha $SHA --repository $REPO
cat release-evidence-$V-$SHA.tar.gz.sha256       # record this checksum in the release notes
```

## 3. Release notes

```bash
git show origin/main:docs/release-notes-draft.md > notes.md
```

Edit `notes.md` before publishing:

- delete the `> **Draft.** …` paragraph at the top;
- in the **Release evidence** row, replace the sentence about the archive attached at step 8 with the name and checksum printed at the end of step 2;
- change the title line to `# ckb-verify v0.1.0`.

Leave everything else as written: the known limitations, what was not run, and the verification steps.

## 4. Tag and publish the prerelease

```bash
git tag -a v$V $SHA -m "ckb-verify v$V"
git push origin v$V
gh release create v$V --repo $REPO --prerelease --verify-tag --title "ckb-verify v$V" --notes-file notes.md \
  dist/ckb-verify-$V.tgz dist/SHA256SUMS release-evidence-$V-$SHA.tar.gz release-evidence-$V-$SHA.tar.gz.sha256
```

## 5. Install back what was published

Download the published assets into a fresh directory, check them, and run the installed-consumer matrix against the downloaded tarball itself. Run the matrix from a checkout of `main`, because `--tarball` was added after the candidate:

```bash
mkdir back && gh release download v$V --repo $REPO -D back
(cd back && sha256sum -c SHA256SUMS && sha256sum -c release-evidence-$V-$SHA.tar.gz.sha256)
bun run scripts/release-evidence.ts verify back/release-evidence-$V-$SHA.tar.gz --source-sha $SHA --repository $REPO
git checkout --detach origin/main && bun install --frozen-lockfile
scripts/acceptance-matrix.sh --consumer --tarball back/ckb-verify-$V.tgz --results install-back.md
```

This exact matrix was rehearsed on 2026-11-02 against a local repack of the candidate tarball (sha256 `61fca14b…`, identical to the gated one): 24 of 24 cases passed, so a failure here points at the published asset, not at the harness.

Every row in `install-back.md` must read `PASS`. Post its contents, the archive checksum, and the release URL on #20; the record is filed from there.

## 6. Promote, or withdraw

- **Every check passed:** promote the prerelease with `gh release edit v$V --repo $REPO --prerelease=false`. That is the `v0.1.0` release.
- **Something failed:** leave the prerelease marked as a prerelease, add a line to its notes saying which check failed, and open an issue. Delete nothing that was published, per the [rollback](release-checklist.md#rollback) rule.
