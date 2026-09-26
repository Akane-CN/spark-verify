import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { installPinnedCkbBinary, type InstalledCkbBinary } from "./ckb-binary";
import { rpcCall } from "./rpc";
import { runProcess, type CommandResult, type RunCommandOptions } from "./process";

export const OFFCKB_VERSION = "0.4.13";

export class OffckbProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OffckbProtocolError";
  }
}

export interface OffckbPaths {
  root: string;
  configHome: string;
  dataHome: string;
  cacheHome: string;
  stateHome: string;
  toolchainRoot: string;
  systemScriptsPath: string;
  accountsPath: string;
  contextPath: string;
  transactionsPath: string;
  fullTransactionsPath: string;
  debuggerPath: string;
  offckbBinary: string;
}

export interface DevAccount {
  index: number;
  address: string;
  privkey: string;
  lock: {
    codeHash: string;
    hashType: "type" | "data" | "data1" | "data2";
    args: string;
  };
}

export interface ResolvedSystemScript {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  cellDeps: Array<{
    outPoint: { txHash: string; index: number };
    depType: "code" | "depGroup";
  }>;
}

export type ResolvedSystemScripts = Record<string, ResolvedSystemScript>;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new OffckbProtocolError(`${path} must be an object`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OffckbProtocolError(`${path} must be a string`);
  return value;
}

function hash(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (!/^0x[0-9a-f]{64}$/.test(result)) throw new OffckbProtocolError(`${path} must be a lowercase 32-byte hash`);
  return result;
}

function hex(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(result)) throw new OffckbProtocolError(`${path} must be lowercase hex bytes`);
  return result;
}

function hashType(value: unknown, path: string): ResolvedSystemScript["hashType"] {
  if (value !== "type" && value !== "data" && value !== "data1" && value !== "data2") {
    throw new OffckbProtocolError(`${path} has an unsupported hash type`);
  }
  return value;
}

export function createOffckbPaths(repositoryRoot: string, offckbBinary: string): OffckbPaths {
  const root = resolve(repositoryRoot, ".ckb-verify", "offckb");
  const dataHome = join(root, "data");
  const offckbData = join(dataHome, "offckb-nodejs");
  const devnet = join(offckbData, "devnet");
  return {
    root,
    configHome: join(root, "config"),
    dataHome,
    cacheHome: join(root, "cache"),
    stateHome: join(root, "state"),
    toolchainRoot: join(dataHome, "offckb-nodejs", "bins"),
    systemScriptsPath: join(root, "system-scripts.json"),
    accountsPath: join(root, "accounts.json"),
    contextPath: join(root, "context.json"),
    transactionsPath: join(devnet, "transactions"),
    fullTransactionsPath: join(devnet, "full-transactions"),
    debuggerPath: join(offckbData, "tools", "ckb-debugger"),
    offckbBinary: resolve(offckbBinary),
  };
}

export function parseOffckbResult(stdout: string, expectedCommand: string): JsonObject {
  let matched: JsonObject | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(value) && value.ok === true && value.command === expectedCommand) matched = value;
  }
  if (matched === undefined) {
    throw new OffckbProtocolError(`OffCKB did not emit a successful ${expectedCommand} result`);
  }
  return matched;
}

export function parseAccountsResult(result: unknown, requested: number): DevAccount[] {
  const root = requiredObject(result, "accounts result");
  if (root.ok !== true || root.command !== "accounts" || !Array.isArray(root.accounts)) {
    throw new OffckbProtocolError("accounts result is malformed");
  }
  if (root.accounts.length < requested) {
    throw new OffckbProtocolError(`accounts result has ${root.accounts.length} entries; ${requested} required`);
  }

  return root.accounts.slice(0, requested).map((raw, index) => {
    const account = requiredObject(raw, `accounts[${index}]`);
    if (account.index !== index) throw new OffckbProtocolError(`accounts[${index}].index must equal ${index}`);
    const privkey = requiredString(account.privkey, `accounts[${index}].privkey`);
    if (!/^0x[0-9a-f]{64}$/.test(privkey)) {
      throw new OffckbProtocolError(`accounts[${index}].privkey must be a lowercase 32-byte development key`);
    }
    const lock = requiredObject(account.lockScript, `accounts[${index}].lockScript`);
    return {
      index,
      address: requiredString(account.address, `accounts[${index}].address`),
      privkey,
      lock: {
        codeHash: hash(lock.codeHash, `accounts[${index}].lockScript.codeHash`),
        hashType: hashType(lock.hashType, `accounts[${index}].lockScript.hashType`),
        args: hex(lock.args, `accounts[${index}].lockScript.args`),
      },
    };
  });
}

export function normalizeSystemScripts(value: unknown): ResolvedSystemScripts {
  const root = requiredObject(value, "system scripts");
  const devnet = requiredObject(root.devnet, "system scripts.devnet");
  const normalized: ResolvedSystemScripts = {};

  for (const [name, raw] of Object.entries(devnet)) {
    const entry = requiredObject(raw, `system scripts.devnet.${name}`);
    const script = requiredObject(entry.script, `system scripts.devnet.${name}.script`);
    if (!Array.isArray(script.cellDeps)) {
      throw new OffckbProtocolError(`system scripts.devnet.${name}.script.cellDeps must be an array`);
    }
    normalized[name] = {
      codeHash: hash(script.codeHash, `system scripts.devnet.${name}.script.codeHash`),
      hashType: hashType(script.hashType, `system scripts.devnet.${name}.script.hashType`),
      cellDeps: script.cellDeps.map((rawDep, index) => {
        const wrapper = requiredObject(rawDep, `system scripts.devnet.${name}.script.cellDeps[${index}]`);
        const dep = requiredObject(wrapper.cellDep, `system scripts.devnet.${name}.script.cellDeps[${index}].cellDep`);
        const outPoint = requiredObject(
          dep.outPoint,
          `system scripts.devnet.${name}.script.cellDeps[${index}].cellDep.outPoint`,
        );
        if (!Number.isInteger(outPoint.index) || (outPoint.index as number) < 0) {
          throw new OffckbProtocolError(
            `system scripts.devnet.${name}.script.cellDeps[${index}].cellDep.outPoint.index must be non-negative`,
          );
        }
        if (dep.depType !== "code" && dep.depType !== "depGroup") {
          throw new OffckbProtocolError(
            `system scripts.devnet.${name}.script.cellDeps[${index}].cellDep.depType is unsupported`,
          );
        }
        return {
          outPoint: {
            txHash: hash(
              outPoint.txHash,
              `system scripts.devnet.${name}.script.cellDeps[${index}].cellDep.outPoint.txHash`,
            ),
            index: outPoint.index as number,
          },
          depType: dep.depType,
        };
      }),
    };
  }
  return normalized;
}

export type OffckbCommandRunner = (
  argv: readonly string[],
  options: RunCommandOptions,
) => Promise<CommandResult>;

export type OffckbRpcCaller = (url: string, method: string, params?: unknown[]) => Promise<unknown>;
export type CkbBinaryInstaller = (version: string, root: string) => Promise<InstalledCkbBinary>;

export interface OffckbRunContext {
  network: "devnet";
  offckbVersion: typeof OFFCKB_VERSION;
  ckbRequestedVersion: string;
  ckbVersion: string;
  ckbBinary: Omit<InstalledCkbBinary, "path">;
  genesisHash: string;
  rpcUrl: string;
  proxyUrl: string;
  accountsPath: string;
  systemScriptsPath: string;
  contextPath: string;
  systemScripts: ResolvedSystemScripts;
}

interface OffckbDevnetOptions {
  repositoryRoot: string;
  ckbVersion: string;
  accountCount: number;
  offckbBinary?: string;
  run?: OffckbCommandRunner;
  rpc?: OffckbRpcCaller;
  installCkbBinary?: CkbBinaryInstaller;
  timeoutMs?: number;
}

function localRpcUrl(value: unknown, path: string): string {
  const text = requiredString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new OffckbProtocolError(`${path} must be a URL`, error instanceof Error ? { cause: error } : undefined);
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new OffckbProtocolError(`${path} must use local http://127.0.0.1`);
  }
  return parsed.toString().replace(/\/$/, "");
}

type EndpointProbe = (endpoint: string) => Promise<boolean>;

export interface EndpointShutdownOptions {
  timeoutMs?: number;
  intervalMs?: number;
  probe?: EndpointProbe;
}

async function isEndpointListening(endpoint: string): Promise<boolean> {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new OffckbProtocolError(`cannot probe non-local OffCKB endpoint ${endpoint}`);
  }
  const port = parsed.port === "" ? 80 : Number.parseInt(parsed.port, 10);
  return await new Promise<boolean>((resolveProbe) => {
    const socket = createConnection({ host: parsed.hostname, port });
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(listening);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function waitForLocalEndpointsClosed(
  endpoints: readonly string[],
  options: EndpointShutdownOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new OffckbProtocolError("shutdown timeout must be positive");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new OffckbProtocolError("shutdown polling interval must be positive");
  }
  const probe = options.probe ?? isEndpointListening;
  const deadline = Date.now() + timeoutMs;

  while (endpoints.length > 0) {
    const states = await Promise.all(endpoints.map(async (endpoint) => ({ endpoint, listening: await probe(endpoint) })));
    const open = states.filter(({ listening }) => listening).map(({ endpoint }) => endpoint);
    if (open.length === 0) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new OffckbProtocolError(`OffCKB endpoints did not close within ${timeoutMs}ms: ${open.join(", ")}`);
    }
    await delay(Math.min(intervalMs, remainingMs));
  }
}

export class OffckbDevnet {
  readonly paths: OffckbPaths;
  readonly repositoryRoot: string;
  readonly ckbVersion: string;
  readonly accountCount: number;
  private readonly run: OffckbCommandRunner;
  private readonly rpc: OffckbRpcCaller;
  private readonly installCkbBinary: CkbBinaryInstaller;
  private readonly timeoutMs: number;
  private started = false;
  private activeEndpoints: string[] = [];

  constructor(options: OffckbDevnetOptions) {
    if (!/^\d+\.\d+\.\d+$/.test(options.ckbVersion)) {
      throw new OffckbProtocolError("CKB version must be an exact semantic version");
    }
    if (!Number.isInteger(options.accountCount) || options.accountCount < 1 || options.accountCount > 20) {
      throw new OffckbProtocolError("OffCKB account count must be between 1 and 20");
    }
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.ckbVersion = options.ckbVersion;
    this.accountCount = options.accountCount;
    this.paths = createOffckbPaths(
      this.repositoryRoot,
      options.offckbBinary ?? join(this.repositoryRoot, "node_modules", ".bin", "offckb"),
    );
    this.run = options.run ?? runProcess;
    this.rpc = options.rpc ?? rpcCall;
    this.installCkbBinary = options.installCkbBinary ?? ((version, root) => installPinnedCkbBinary({ version, root }));
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      XDG_CONFIG_HOME: this.paths.configHome,
      XDG_DATA_HOME: this.paths.dataHome,
      XDG_CACHE_HOME: this.paths.cacheHome,
      XDG_STATE_HOME: this.paths.stateHome,
      NO_COLOR: "1",
    };
  }

  private async command(args: readonly string[], options: { sensitive?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
    const argv = [this.paths.offckbBinary, "--json", ...args];
    const result = await this.run(argv, {
      cwd: this.repositoryRoot,
      env: this.environment(),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    if (result.timedOut || result.exitCode !== 0) {
      const operation = `offckb ${args.join(" ")}`;
      if (options.sensitive) {
        throw new OffckbProtocolError(`${operation} failed (sensitive output suppressed)`);
      }
      const detail = result.stderr.trim().slice(-2_000);
      throw new OffckbProtocolError(
        `${operation} ${result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`}${detail === "" ? "" : `: ${detail}`}`,
      );
    }
    return result;
  }

  private async verifyVersion(): Promise<void> {
    const result = await this.run([this.paths.offckbBinary, "--version"], {
      cwd: this.repositoryRoot,
      env: this.environment(),
      timeoutMs: 30_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new OffckbProtocolError(
        `offckb --version ${result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`}`,
      );
    }
    const observed = result.stdout.trim().split(/\r?\n/, 1)[0];
    if (observed !== OFFCKB_VERSION) {
      throw new OffckbProtocolError(`OffCKB version ${observed ?? "<empty>"} does not match required ${OFFCKB_VERSION}`);
    }
  }

  async start(): Promise<OffckbRunContext> {
    if (this.started) throw new OffckbProtocolError("OffCKB devnet is already started by this runner");
    await this.verifyVersion();
    await mkdir(this.paths.root, { recursive: true });
    try {
      const installedCkbBinary = await this.installCkbBinary(this.ckbVersion, this.paths.toolchainRoot);
      const { path: ckbBinaryPath, ...ckbBinary } = installedCkbBinary;
      await this.command(["config", "set", "ckb-version", this.ckbVersion]);
      await this.command(["clean"]);
      const node = await this.command(["node", "--binary-path", ckbBinaryPath, "--daemon"]);
      this.started = true;
      parseOffckbResult(node.stdout, "node");

      const infoOutput = await this.command(["devnet", "info"]);
      const info = parseOffckbResult(infoOutput.stdout, "devnet.info");
      if (info.ready !== true) throw new OffckbProtocolError("OffCKB devnet is not ready");
      const rpcUrl = localRpcUrl(info.rpcUrl, "devnet.info.rpcUrl");
      const proxyUrl = localRpcUrl(info.proxyUrl, "devnet.info.proxyUrl");
      this.activeEndpoints = [rpcUrl, proxyUrl];

      const accountOutput = await this.command(["accounts", "--show-private-keys"], { sensitive: true });
      const accounts = parseAccountsResult(parseOffckbResult(accountOutput.stdout, "accounts"), this.accountCount);
      await writeFile(this.paths.accountsPath, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
      await chmod(this.paths.accountsPath, 0o600);

      await this.command(["system-scripts", "--output", this.paths.systemScriptsPath]);
      let rawScripts: unknown;
      try {
        rawScripts = JSON.parse(await readFile(this.paths.systemScriptsPath, "utf8"));
      } catch (error) {
        throw new OffckbProtocolError(
          "OffCKB system-scripts output is not valid JSON",
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      const systemScripts = normalizeSystemScripts(rawScripts);

      const nodeInfo = requiredObject(await this.rpc(rpcUrl, "local_node_info", []), "local_node_info result");
      const actualCkbVersion = requiredString(nodeInfo.version, "local_node_info.version");
      if (!actualCkbVersion.startsWith(`${this.ckbVersion} `) && actualCkbVersion !== this.ckbVersion) {
        throw new OffckbProtocolError(
          `CKB node version ${actualCkbVersion} does not match requested ${this.ckbVersion}`,
        );
      }
      const genesis = requiredObject(await this.rpc(rpcUrl, "get_block_by_number", ["0x0"]), "genesis block");
      const header = requiredObject(genesis.header, "genesis block.header");
      const genesisHash = hash(header.hash, "genesis block.header.hash");

      const context: OffckbRunContext = {
        network: "devnet",
        offckbVersion: OFFCKB_VERSION,
        ckbRequestedVersion: this.ckbVersion,
        ckbVersion: actualCkbVersion,
        ckbBinary,
        genesisHash,
        rpcUrl,
        proxyUrl,
        accountsPath: this.paths.accountsPath,
        systemScriptsPath: this.paths.systemScriptsPath,
        contextPath: this.paths.contextPath,
        systemScripts,
      };
      await writeFile(
        this.paths.contextPath,
        `${JSON.stringify({ ...context, accountsPath: "[REDACTED]" }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return context;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        const startupMessage = error instanceof Error ? error.message : String(error);
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new AggregateError(
          [error, cleanupError],
          `OffCKB startup failed: ${startupMessage}; cleanup failed: ${cleanupMessage}`,
        );
      }
      throw error;
    }
  }

  async installDebugger(): Promise<void> {
    const result = await this.command(["install", "ckb-debugger"]);
    parseOffckbResult(result.stdout, "install");
  }

  async debuggerVersion(): Promise<string> {
    const result = await this.run([this.paths.debuggerPath, "--version"], {
      cwd: this.repositoryRoot,
      env: this.environment(),
      timeoutMs: 30_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new OffckbProtocolError(
        `ckb-debugger --version ${result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`}`,
      );
    }
    const version = result.stdout.trim().split(/\r?\n/, 1)[0];
    if (version === undefined || version === "") throw new OffckbProtocolError("ckb-debugger --version returned no version");
    return version;
  }

  async debugScript(
    txHash: string,
    source: { cell: "input" | "output"; index: number; role: "lock" | "type" },
  ): Promise<CommandResult> {
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new OffckbProtocolError("debug transaction hash is invalid");
    if (!Number.isInteger(source.index) || source.index < 0) throw new OffckbProtocolError("debug cell index is invalid");
    const script = `${source.cell}[${source.index}].${source.role}`;
    const result = await this.run(
      [
        this.paths.offckbBinary,
        "--json",
        "debug",
        "--tx-hash",
        txHash,
        "--single-script",
        script,
      ],
      {
        cwd: this.repositoryRoot,
        env: this.environment(),
        timeoutMs: 60_000,
      },
    );
    if (result.timedOut) throw new OffckbProtocolError(`offckb debug timed out for ${script}`);
    return result;
  }

  async stop(): Promise<void> {
    const endpoints = this.activeEndpoints;
    try {
      if (this.started) await this.command(["node", "stop"], { timeoutMs: 60_000 });
      await waitForLocalEndpointsClosed(endpoints);
    } finally {
      this.started = false;
      this.activeEndpoints = [];
      await rm(this.paths.accountsPath, { force: true });
    }
  }
}
