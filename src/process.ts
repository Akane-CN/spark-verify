import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

/** How long after the forced kill an escaped descendant may keep the pipes before they are released. */
export const PIPE_RELEASE_GRACE_MS = 1_000;

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runProcess(argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
  if (argv.length === 0 || argv[0] === undefined) throw new Error("runProcess requires a non-empty argv");
  const startedAt = performance.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let timedOut = false;
  // A background descendant can keep the pipes (and so "close") open after the
  // shell exits, so termination targets the group until close, not until exit.
  // A descendant that left the group (setsid, a detached spawn) is out of reach of
  // the group signal and can hold the pipes forever; after the forced kill, the
  // runner's own ends of the pipes are destroyed so the call still settles. That
  // descendant keeps running: manifests are trusted code and there is no sandbox.
  let closed = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let releasePipesTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (closed || child.pid === undefined) return;
    if (process.platform === "win32") child.kill("SIGTERM");
    else killProcessGroup(child.pid, "SIGTERM");
    if (forceKillTimer !== undefined) return;
    forceKillTimer = setTimeout(() => {
      if (closed || child.pid === undefined) return;
      if (process.platform === "win32") child.kill("SIGKILL");
      else killProcessGroup(child.pid, "SIGKILL");
      releasePipesTimer = setTimeout(() => {
        if (closed) return;
        child.stdout.destroy();
        child.stderr.destroy();
      }, PIPE_RELEASE_GRACE_MS);
      releasePipesTimer.unref();
    }, 200);
    forceKillTimer.unref();
  };
  const onAbort = (): void => terminate();
  if (options.signal?.aborted === true) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  timeout.unref();

  try {
    const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          closed = true;
          resolve({ exitCode, signal });
        });
      },
    );
    return {
      stdout,
      stderr,
      exitCode,
      signal,
      timedOut,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (releasePipesTimer !== undefined) clearTimeout(releasePipesTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  return runProcess(["bash", "-o", "pipefail", "-c", command], options);
}
