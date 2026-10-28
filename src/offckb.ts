import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { installPinnedCkbBinary, type InstalledCkbBinary } from "./ckb-binary";
import { preparePinnedDebuggerBinary, assertVerifiedDebuggerExecutable, resolvePinnedDebuggerAsset,
  type PreparedDebuggerBinary, type DebuggerBinaryEvidence } from "./debugger-binary";
import { rpcCall } from "./rpc";
import { acquireRuntimeOwnership, assertRuntimePortsAvailable, type RuntimeOwnership } from "./runtime-ownership";
import { assertInstalledOffckb, resolveOffckbPackage } from "./supply-chain";
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

export interface PreparedDebugger {
  version: string;
  binary: DebuggerBinaryEvidence;
}

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
  // Trusted constructor seams for offline fixtures, never manifest inputs.
  prepareDebuggerBinary?: typeof preparePinnedDebuggerBinary;
  verifyDebuggerBinary?: typeof assertVerifiedDebuggerExecutable;
  preflight?: () => Promise<void>;
  /** Installation check before any runtime mutation; defaults to the fail-closed patched-bundle check. */
  verifyInstallation?: () => Promise<unknown>;
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
  private readonly prepareDebuggerBinary: typeof preparePinnedDebuggerBinary;
  private readonly verifyDebuggerBinary: typeof assertVerifiedDebuggerExecutable;
  private readonly preflight: () => Promise<void>;
  private readonly verifyInstallation: () => Promise<unknown>;
  private readonly timeoutMs: number;
  private started = false;
  private ownership: RuntimeOwnership | undefined;
  private prepared = false;
  private ready = false;
  private starting: Promise<OffckbRunContext> | undefined;
  private stopping: Promise<void> | undefined;
  private stopRequested = false;
  private signal: AbortSignal | undefined;
  private cancellation = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private debuggerPreparation: { version: string; promise: Promise<PreparedDebugger> } | undefined;
  private debuggerCapability: PreparedDebuggerBinary | undefined;
  private debuggerSettings: JsonObject | undefined;
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
      // Resolve OffCKB from ckb-verify's own dependency tree, so an installed copy never depends on
      // the verified project's node_modules/.bin layout.
      options.offckbBinary ?? join(resolveOffckbPackage(), "build", "index.js"),
    );
    this.run = options.run ?? runProcess;
    this.rpc = options.rpc ?? rpcCall;
    this.installCkbBinary = options.installCkbBinary ?? ((version, root) => installPinnedCkbBinary({ version, root }));
    this.prepareDebuggerBinary = options.prepareDebuggerBinary ?? preparePinnedDebuggerBinary;
    this.verifyDebuggerBinary = options.verifyDebuggerBinary ?? assertVerifiedDebuggerExecutable;
    this.preflight = options.preflight ?? assertRuntimePortsAvailable;
    this.verifyInstallation = options.verifyInstallation ?? (() => assertInstalledOffckb());
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      XDG_CONFIG_HOME: this.paths.configHome,
      XDG_DATA_HOME: this.paths.dataHome,
      XDG_CACHE_HOME: this.paths.cacheHome,
      XDG_STATE_HOME: this.paths.stateHome,
      NO_COLOR: "1",
      OFFCKB_DEBUGGER_GUARD: "1",
    };
  }

  private assertNotStopping(): void {
    if (this.stopRequested || this.signal?.aborted) throw new OffckbProtocolError("OffCKB setup interrupted");
  }

  private assertDebuggerReady(): void {
    if (this.ownership === undefined) throw new OffckbProtocolError("OffCKB runtime is not owned by this runner");
    this.assertNotStopping();
    if (!this.ready || this.starting !== undefined) throw new OffckbProtocolError("OffCKB devnet is not ready");
  }

  async prepareDebugger(version: string): Promise<PreparedDebugger> {
    this.assertDebuggerReady();
    resolvePinnedDebuggerAsset(version, process.platform, process.arch);
    if (this.debuggerPreparation !== undefined) {
      if (this.debuggerPreparation.version !== version) throw new OffckbProtocolError("conflicting debugger version");
      return this.debuggerPreparation.promise;
    }
    const promise = this.runOwnedTask(async () => {
      const capability = await this.prepareDebuggerBinary({ version,
        root: join(this.paths.cacheHome, "verified-debugger"),
        snapshotRoot: join(this.paths.dataHome, "offckb-nodejs", "debugger-runs"),
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
      try {
        this.assertNotStopping();
        const settingsPath = join(this.paths.configHome, "offckb-nodejs", "settings.json");
        const settings = requiredObject(JSON.parse(await readFile(settingsPath, "utf8")), "OffCKB settings");
        // OffCKB catches these validation errors and silently loads defaults.
        // Refuse here instead of executing against that fallback configuration.
        for (const key of ["bins", "tools", "devnet", "testnet", "mainnet"]) {
          if (settings[key] !== undefined) requiredObject(settings[key], `OffCKB settings.${key}`);
        }
        if (settings.proxy !== undefined && settings.proxy !== null) requiredObject(settings.proxy, "OffCKB settings.proxy");
        const tools = settings.tools === undefined ? {} : requiredObject(settings.tools, "OffCKB settings.tools");
        if (tools.rootFolder !== undefined) requiredString(tools.rootFolder, "OffCKB settings.tools.rootFolder");
        if (tools.ckbTui !== undefined) {
          const tui = requiredObject(tools.ckbTui, "OffCKB settings.tools.ckbTui");
          if (tui.version !== undefined) requiredString(tui.version, "OffCKB settings.tools.ckbTui.version");
        }
        settings.tools = { ...tools, rootFolder: capability.directory };
        this.assertNotStopping();
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        this.assertNotStopping();
        await this.verifyDebuggerBinary(capability, this.signal);
        await this.assertDebuggerSettings(settings);
        this.assertNotStopping();
        const result = await this.run([capability.path, "--version"], {
          cwd: this.repositoryRoot, env: this.environment(), timeoutMs: 30_000,
          ...(this.signal === undefined ? {} : { signal: this.signal }),
        });
        this.assertNotStopping();
        if (result.timedOut || result.exitCode !== 0 || result.stdout.trim() !== `ckb-debugger ${version}`) {
          throw new OffckbProtocolError(`ckb-debugger --version does not match required ckb-debugger ${version}`);
        }
        this.debuggerCapability = capability;
        this.debuggerSettings = settings;
        return { version: result.stdout.trim(), binary: capability.evidence };
      } catch (error) {
        try { await capability.cleanup(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "debugger preparation and cleanup failed"); }
        throw error;
      }
    });
    this.debuggerPreparation = { version, promise };
    return promise;
  }

  private async assertDebuggerSettings(expected: JsonObject | undefined): Promise<void> {
    const settings = JSON.parse(await readFile(join(this.paths.configHome, "offckb-nodejs", "settings.json"), "utf8"));
    if (expected === undefined || !isDeepStrictEqual(settings, expected)) throw new OffckbProtocolError("debugger settings changed");
  }

  private async runOwnedTask<T>(task: () => Promise<T>, cleanup = false): Promise<T> {
    if (this.ownership === undefined) throw new OffckbProtocolError("OffCKB runtime is not owned by this runner");
    if (!cleanup) this.assertNotStopping();
    // Register before deferred work. No task may await start()/stop() or queue
    // another owned task; closeout drains whole operations, not just processes.
    const running = Promise.resolve().then(() => {
      if (!cleanup) this.assertNotStopping();
      return task();
    });
    this.commands.add(running);
    try {
      const result = await running;
      if (!cleanup) this.assertNotStopping();
      return result;
    } finally {
      this.commands.delete(running);
    }
  }

  private runOwnedCommand(args: readonly string[], options: { timeoutMs?: number; cleanup?: boolean } = {}): Promise<CommandResult> {
    return this.runOwnedTask(() => this.run([this.paths.offckbBinary, "--json", ...args], {
      cwd: this.repositoryRoot, env: this.environment(), timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ...(!options.cleanup && this.signal !== undefined ? { signal: this.signal } : {}),
    }), options.cleanup);
  }

  private async command(args: readonly string[], options: { sensitive?: boolean; timeoutMs?: number; cleanup?: boolean } = {}): Promise<CommandResult> {
    const result = await this.runOwnedCommand(args, options);
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

  async start(signal?: AbortSignal): Promise<OffckbRunContext> {
    if (this.starting !== undefined || this.stopping !== undefined || this.ownership !== undefined) {
      throw new OffckbProtocolError("OffCKB devnet is already started by this runner");
    }
    this.stopRequested = false;
    this.ready = false;
    this.cancellation = new AbortController();
    this.signal = signal === undefined ? this.cancellation.signal : AbortSignal.any([signal, this.cancellation.signal]);
    const starting = this.startOwned();
    this.starting = starting;
    try {
      const context = await starting;
      try {
        this.assertNotStopping();
        this.ready = true;
        return context;
      } catch (error) {
        // Initialization succeeded, but its context was never handed to the caller.
        // stop() coalesces teardown and awaits only the inner initialization promise,
        // not this public start() promise whose rejection must wait for cleanup.
        try { await this.stop(); }
        catch (cleanupError) {
          const startupMessage = error instanceof Error ? error.message : String(error);
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new AggregateError([error, cleanupError],
            `OffCKB startup failed: ${startupMessage}; cleanup failed: ${cleanupMessage}`);
        }
        throw error;
      }
    } finally {
      this.starting = undefined;
    }
  }

  private async startOwned(): Promise<OffckbRunContext> {
    this.ownership = await acquireRuntimeOwnership();
    try {
      this.assertNotStopping();
      // Installation check first: no preflight, install, config, clean, or launch on an unverified OffCKB.
      try {
        await this.verifyInstallation();
      } catch (error) {
        throw new OffckbProtocolError(error instanceof Error ? error.message : String(error), error instanceof Error ? { cause: error } : undefined);
      }
      this.assertNotStopping();
      await this.preflight();
      this.assertNotStopping();
      await this.verifyVersion();
      this.assertNotStopping();
      this.prepared = true;
      await mkdir(this.paths.root, { recursive: true });
      this.assertNotStopping();
      const installedCkbBinary = await this.installCkbBinary(this.ckbVersion, this.paths.toolchainRoot);
      this.assertNotStopping();
      const { path: ckbBinaryPath, ...ckbBinary } = installedCkbBinary;
      await this.command(["config", "set", "ckb-version", this.ckbVersion]);
      await this.command(["clean"]);
      // A failing/timed-out launch may already have detached a daemon.
      this.started = true;
      this.activeEndpoints = ["http://127.0.0.1:8114", "http://127.0.0.1:28114"];
      const node = await this.command(["node", "--binary-path", ckbBinaryPath, "--daemon"]);
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
      this.assertNotStopping();

      const nodeInfo = requiredObject(await this.rpc(rpcUrl, "local_node_info", []), "local_node_info result");
      this.assertNotStopping();
      const actualCkbVersion = requiredString(nodeInfo.version, "local_node_info.version");
      if (!actualCkbVersion.startsWith(`${this.ckbVersion} `) && actualCkbVersion !== this.ckbVersion) {
        throw new OffckbProtocolError(
          `CKB node version ${actualCkbVersion} does not match requested ${this.ckbVersion}`,
        );
      }
      const genesis = requiredObject(await this.rpc(rpcUrl, "get_block_by_number", ["0x0"]), "genesis block");
      this.assertNotStopping();
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
      this.assertNotStopping();
      return context;
    } catch (error) {
      // Close admission before draining; stop() would await this startup itself.
      this.stopRequested = true;
      this.cancellation.abort(new OffckbProtocolError("OffCKB setup interrupted"));
      await Promise.allSettled(this.commands);
      try {
        await this.cleanupOwned();
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


  async debugScript(
    txHash: string,
    source: { cell: "input" | "output"; index: number; role: "lock" | "type" },
  ): Promise<CommandResult> {
    this.assertDebuggerReady();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new OffckbProtocolError("debug transaction hash is invalid");
    if (!Number.isInteger(source.index) || source.index < 0) throw new OffckbProtocolError("debug cell index is invalid");
    const script = `${source.cell}[${source.index}].${source.role}`;
    const capability = this.debuggerCapability;
    if (capability === undefined) throw new OffckbProtocolError("debugger is not prepared");
    return this.runOwnedTask(async () => {
      await this.assertDebuggerSettings(this.debuggerSettings);
      await this.verifyDebuggerBinary(capability, this.signal);
      await this.assertDebuggerSettings(this.debuggerSettings);
      this.assertNotStopping();
      const result = await this.run([this.paths.offckbBinary, "--json", "debug", "--tx-hash", txHash, "--single-script", script], {
        cwd: this.repositoryRoot, env: this.environment(), timeoutMs: 60_000,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
      this.assertNotStopping();
      if (result.timedOut) throw new OffckbProtocolError(`offckb debug timed out for ${script}`);
      return result;
    });
  }

  stop(): Promise<void> {
    this.stopRequested = true;
    this.ready = false;
    this.cancellation.abort(new OffckbProtocolError("OffCKB setup interrupted"));
    this.stopping ??= this.finishStop().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async finishStop(): Promise<void> {
    if (this.starting !== undefined) await this.starting.catch(() => undefined);
    await Promise.allSettled(this.commands);
    await this.cleanupOwned();
  }

  private async cleanupOwned(): Promise<void> {
    const ownership = this.ownership;
    if (ownership === undefined) return;
    const errors: unknown[] = [];
    const attempt = async (cleanup: () => Promise<unknown>): Promise<void> => {
      try { await cleanup(); } catch (error) { errors.push(error); }
    };
    if (this.started) await attempt(() => this.command(["node", "stop"], { timeoutMs: 60_000, cleanup: true }));
    await attempt(() => waitForLocalEndpointsClosed(this.activeEndpoints));
    this.started = false;
    this.ready = false;
    this.activeEndpoints = [];
    if (this.prepared) await attempt(() => rm(this.paths.accountsPath, { force: true }));
    if (this.debuggerCapability !== undefined) await attempt(() => this.debuggerCapability!.cleanup());
    this.prepared = false;
    this.debuggerCapability = undefined;
    this.debuggerSettings = undefined;
    this.debuggerPreparation = undefined;
    await attempt(async () => { await ownership.release(); this.ownership = undefined; });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "));
  }
}
