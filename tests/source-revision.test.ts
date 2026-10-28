import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { collectSourceRevision } from "../src/runner";
import { runProcess } from "../src/process";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess(["git", ...args], { cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function sourceProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "ckb-verify-source-revision-"));
  directories.push(project);
  await git(project, "init", "-q");
  await git(project, "config", "user.name", "Test");
  await git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "tracked.txt"), "clean\n");
  await writeFile(join(project, ".gitignore"), "ignored-input.txt\n");
  await git(project, "add", ".");
  await git(project, "commit", "-qm", "initial");
  return project;
}

describe("source revision evidence", () => {
  test("fingerprints tracked contents rather than collapsing all changes to dirty=true", async () => {
    const project = await sourceProject();

    const clean = await collectSourceRevision(project);
    await writeFile(join(project, "tracked.txt"), "dirty one\n");
    const first = await collectSourceRevision(project);
    await writeFile(join(project, "tracked.txt"), "dirty two\n");
    const second = await collectSourceRevision(project);

    expect(clean).toMatchObject({ dirty: false, dirtyDigest: null });
    expect(first).toMatchObject({ dirty: true });
    expect(first.dirtyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.dirtyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.dirtyDigest).not.toBe(first.dirtyDigest);
  });

  test("fingerprints the executable mode of an untracked file", async () => {
    const project = await sourceProject();

    const untrackedPath = join(project, "script.sh");
    await writeFile(untrackedPath, "#!/bin/sh\nexit 0\n");
    await chmod(untrackedPath, 0o644);
    const regular = await collectSourceRevision(project);
    await chmod(untrackedPath, 0o755);
    const executable = await collectSourceRevision(project);

    expect(regular.dirtyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(executable.dirtyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(executable.dirtyDigest).not.toBe(regular.dirtyDigest);
  });

  test.each(["contents", "path"] as const)("fingerprints changes to an untracked file's %s", async (change) => {
    const project = await sourceProject();
    const path = join(project, "input.bin");
    await writeFile(path, new Uint8Array([0, 1, 2]));
    const before = await collectSourceRevision(project);

    if (change === "contents") await writeFile(path, new Uint8Array([0, 1, 3]));
    else await rename(path, join(project, "renamed-input.bin"));
    const after = await collectSourceRevision(project);

    expect(before).toMatchObject({ dirty: true, dirtyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(after).toMatchObject({ gitCommit: before.gitCommit, dirty: true });
    expect(after.dirtyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(after.dirtyDigest).not.toBe(before.dirtyDigest);
  });

  test("does not fingerprint an external symlink referent", async () => {
    const project = await sourceProject();
    const external = await mkdtemp(join(tmpdir(), "ckb-verify-external-input-"));
    directories.push(external);
    const target = join(external, "input.txt");
    const link = join(project, "linked-input.txt");
    await writeFile(target, "original\n");
    await symlink(relative(project, target), link);
    const before = await collectSourceRevision(project);

    await writeFile(target, "changed outside the repository\n");

    expect(await Bun.file(link).text()).toBe("changed outside the repository\n");
    expect(before).toMatchObject({ dirty: true, dirtyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(await collectSourceRevision(project)).toEqual(before);
  });

  test("does not fingerprint ignored inputs", async () => {
    const project = await sourceProject();
    const before = await collectSourceRevision(project);
    await writeFile(join(project, "ignored-input.txt"), "not included\n");

    expect(before).toMatchObject({ dirty: false, dirtyDigest: null });
    expect(await collectSourceRevision(project)).toEqual(before);
  });

  test("does not add the checkout's absolute root to the dirty-tree digest", async () => {
    const project = await sourceProject();
    const relocated = await mkdtemp(join(tmpdir(), "ckb-verify-relocated-source-"));
    directories.push(relocated);
    await git(project, "clone", "-q", "--no-hardlinks", project, relocated);
    for (const root of [project, relocated]) {
      await writeFile(join(root, "tracked.txt"), "dirty\n");
      await writeFile(join(root, "script.sh"), "#!/bin/sh\nexit 0\n");
      await chmod(join(root, "script.sh"), 0o755);
      await symlink("tracked.txt", join(root, "linked-input.txt"));
    }

    const original = await collectSourceRevision(project);
    expect(original).toMatchObject({ dirty: true, dirtyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(await collectSourceRevision(relocated)).toEqual(original);
  });
});
