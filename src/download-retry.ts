// Bounded retries for the two pinned release downloads (the CKB archive and ckb-debugger). Only failures
// that a second request can plausibly fix are retried: a network error before or while reading the body, and
// HTTP 408, 429, and 5xx. A timeout, a caller's cancellation, any other status, and every size or checksum
// mismatch are final on the first attempt. Retrying never weakens verification: each attempt's bytes go
// through the same pinned-length and checksum checks.

/** Waits before the second, third, and fourth attempt. */
export const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

const transient = new WeakSet<object>();

/** Marks an error as worth retrying without changing its identity or message. */
export function markTransient<T>(error: T): T {
  if (typeof error === "object" && error !== null) transient.add(error);
  return error;
}

export function isTransient(error: unknown): boolean {
  return typeof error === "object" && error !== null && transient.has(error);
}

export function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export type RetrySleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/** A cancellable wait: it rejects with the signal's reason as soon as the caller aborts. */
export const abortableSleep: RetrySleep = (milliseconds, signal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
});

export interface RetryOptions {
  /** One wait per retry; an empty list means a single attempt. */
  delaysMs: readonly number[];
  signal?: AbortSignal;
  sleep?: RetrySleep;
}

/** Runs `attempt` again after each transient failure, up to `delaysMs.length` more times. A failure that is
 * still transient after the last attempt is rethrown with the attempt count; anything else is rethrown as is. */
export async function retryTransient<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? abortableSleep;
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransient(error) || options.signal?.aborted) throw error;
      if (index >= options.delaysMs.length) {
        if (index === 0) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (after ${index + 1} attempts)`, { cause: error });
      }
      await sleep(options.delaysMs[index]!, options.signal);
    }
  }
}
