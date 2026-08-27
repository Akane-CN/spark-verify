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
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") child.kill("SIGTERM");
    else killProcessGroup(child.pid, "SIGTERM");
    if (forceKillTimer !== undefined) return;
    forceKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.pid === undefined) return;
      if (process.platform === "win32") child.kill("SIGKILL");
      else killProcessGroup(child.pid, "SIGKILL");
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
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
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
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function runCommand(command: string, options: RunCommandOptions): Promise<CommandResult> {
  return runProcess(["bash", "-o", "pipefail", "-c", command], options);
}
