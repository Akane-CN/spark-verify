export interface CkbJsonRpcTransaction {
  version: string;
  cell_deps: unknown[];
  header_deps: unknown[];
  inputs: unknown[];
  outputs: unknown[];
  outputs_data: unknown[];
  witnesses: unknown[];
}

export interface ResultEnvelope {
  protocol: 1;
  transaction: CkbJsonRpcTransaction;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data: unknown) {
    super(`${method}: JSON-RPC ${code}: ${message}`);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class RpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcProtocolError";
  }
}

export class ResultProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResultProtocolError";
  }
}

let nextRequestId = 1;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function rpcCall<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  fetchImplementation: FetchLike = fetch,
  timeoutMs = 30_000,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RpcProtocolError(`${method} timeout must be a positive safe integer`);
  }
  const id = nextRequestId++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let body: unknown;
  try {
    const operation = async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new RpcProtocolError(`${method}: transport failed`, error instanceof Error ? { cause: error } : undefined);
      }
      if (!response.ok) throw new RpcProtocolError(`${method}: HTTP ${response.status}`);
      try {
        return await response.json();
      } catch (error) {
        throw new RpcProtocolError(`${method}: response is not JSON`, error instanceof Error ? { cause: error } : undefined);
      }
    };
    body = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RpcProtocolError(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!isObject(body)) throw new RpcProtocolError(`${method}: response must be an object`);
  if (body.id !== id) throw new RpcProtocolError(`${method}: response id does not match request`);
  if (body.error !== undefined) {
    if (!isObject(body.error) || !Number.isInteger(body.error.code) || typeof body.error.message !== "string") {
      throw new RpcProtocolError(`${method}: malformed JSON-RPC error`);
    }
    throw new RpcError(method, body.error.code as number, body.error.message, body.error.data);
  }
  if (!("result" in body)) throw new RpcProtocolError(`${method}: response is missing result`);
  return body.result as T;
}

export type TerminalTransaction =
  | { status: "committed"; reason?: string }
  | { status: "rejected"; reason?: string };

interface WaitOptions {
  call?: (url: string, method: string, params: unknown[]) => Promise<unknown>;
  intervalMs?: number;
  timeoutMs?: number;
}

export async function waitForTransaction(
  url: string,
  txHash: string,
  options: WaitOptions = {},
): Promise<TerminalTransaction> {
  const call = options.call ?? rpcCall;
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new RpcProtocolError("poll interval must be a safe integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RpcProtocolError("poll timeout must be positive");
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () => new RpcProtocolError(`transaction ${txHash} did not reach a terminal state after ${timeoutMs}ms`);

  while (performance.now() < deadline) {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recordValue: unknown;
    try {
      recordValue = await Promise.race([
        call(url, "get_transaction", [txHash]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(timeoutError()), remainingMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (isObject(recordValue) && isObject(recordValue.tx_status)) {
      const status = recordValue.tx_status.status;
      const reason = typeof recordValue.tx_status.reason === "string" ? recordValue.tx_status.reason : undefined;
      if (status === "committed" || status === "rejected") {
        return { status, ...(reason === undefined ? {} : { reason }) };
      }
    }
    const delayMs = Math.min(intervalMs, Math.max(0, Math.ceil(deadline - performance.now())));
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  throw timeoutError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new ResultProtocolError(`${path}.${key} is not supported`);
  }
}

const TRANSACTION_KEYS = [
  "version",
  "cell_deps",
  "header_deps",
  "inputs",
  "outputs",
  "outputs_data",
  "witnesses",
] as const;

export async function loadResultEnvelope(path: string): Promise<ResultEnvelope> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ResultProtocolError(`${path}: result file does not exist`);
  if (file.size > 10 * 1024 * 1024) throw new ResultProtocolError(`${path}: result file exceeds 10 MiB`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    throw new ResultProtocolError(`${path}: result file is not valid JSON`, error instanceof Error ? { cause: error } : undefined);
  }
  if (!isObject(parsed)) throw new ResultProtocolError(`${path}: result envelope must be an object`);
  assertExactKeys(parsed, ["protocol", "transaction"], "result");
  if (parsed.protocol !== 1) throw new ResultProtocolError("result.protocol must equal 1");
  if (!isObject(parsed.transaction)) throw new ResultProtocolError("result.transaction must be an object");
  assertExactKeys(parsed.transaction, TRANSACTION_KEYS, "transaction");

  for (const key of TRANSACTION_KEYS) {
    if (!(key in parsed.transaction)) throw new ResultProtocolError(`transaction.${key} is required`);
  }
  if (typeof parsed.transaction.version !== "string" || !/^0x[0-9a-f]+$/.test(parsed.transaction.version)) {
    throw new ResultProtocolError("transaction.version must be a lowercase 0x-prefixed integer");
  }
  for (const key of TRANSACTION_KEYS.filter((key) => key !== "version")) {
    if (!Array.isArray(parsed.transaction[key])) throw new ResultProtocolError(`transaction.${key} must be an array`);
  }

  return { protocol: 1, transaction: parsed.transaction as unknown as CkbJsonRpcTransaction };
}
