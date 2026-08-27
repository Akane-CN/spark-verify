import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

describe("source revision evidence", () => {
  test("fingerprints the exact dirty tree rather than collapsing all changes to dirty=true", async () => {
    const project = await mkdtemp(join(tmpdir(), "ckb-verify-source-revision-"));
    directories.push(project);
    await git(project, "init", "-q");
    await git(project, "config", "user.name", "Test");
    await git(project, "config", "user.email", "test@example.invalid");
    await writeFile(join(project, "tracked.txt"), "clean\n");
    await git(project, "add", "tracked.txt");
    await git(project, "commit", "-qm", "initial");

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
    const project = await mkdtemp(join(tmpdir(), "ckb-verify-source-revision-mode-"));
    directories.push(project);
    await git(project, "init", "-q");
    await git(project, "config", "user.name", "Test");
    await git(project, "config", "user.email", "test@example.invalid");
    await writeFile(join(project, "tracked.txt"), "clean\n");
    await git(project, "add", "tracked.txt");
    await git(project, "commit", "-qm", "initial");

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
});
