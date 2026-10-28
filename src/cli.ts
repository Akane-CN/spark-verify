#!/usr/bin/env bun

import { runManifest as executeManifest, type RunManifestResult } from "./runner";
import {
  DIGEST_PATTERN, OfflineInputError, inspectReportFile, validateManifestFile,
  type ExpectedDigests, type ManifestValidation, type ReportInspection,
} from "./offline";
import { VERSION } from "./version";

const HELP = `ckb-verify ${VERSION}

Usage:
  ckb-verify run [manifest]
  ckb-verify validate [manifest] [--json]
  ckb-verify digest <report.json> [--json] [--allow-legacy]
  ckb-verify check-digest <report.json> [--outcome sha256:...] [--environment sha256:...] [--json] [--allow-legacy]
  ckb-verify --help
  ckb-verify --version

Commands:
  run [manifest]         Execute declared CKB acceptance claims (default: verify.toml)
  validate [manifest]    Parse a manifest with the strict grammar; runs nothing (default: verify.toml)
  digest <report>        Re-derive a report's outcome and environment digests offline
  check-digest <report>  Verify a report offline and compare it with expected digests

Offline commands never start OffCKB, execute manifest commands, install tools,
or use the network. Exit 0 means the input is valid (and every expected digest
matched); exit 1 means invalid evidence or a mismatch; exit 2 means a usage or
I/O error. A valid report may still record verdict FAIL: validity means the
artifact is internally consistent, not that its declared claims passed.
`;

export interface CliDependencies {
  runManifest: (options: { manifestPath: string; projectRoot: string; signal: AbortSignal }) => Promise<RunManifestResult>;
  subscribeSignals?: (handler: (signal: "SIGINT" | "SIGTERM") => void) => () => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function subscribeProcessSignals(handler: (signal: "SIGINT" | "SIGTERM") => void): () => void {
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  // Keep handlers installed through cleanup: a repeated signal must not bypass it.
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  runManifest: executeManifest,
  subscribeSignals: subscribeProcessSignals,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

class UsageError extends Error {}

interface ParsedArgs { positional: string[]; flags: Map<string, string | true> }

function parseArgs(args: readonly string[], booleans: readonly string[], strings: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (booleans.includes(name)) {
      if (equals !== -1) throw new UsageError(`--${name} does not take a value`);
      flags.set(name, true);
    } else if (strings.includes(name)) {
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "") throw new UsageError(`--${name} requires a value`);
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return { positional, flags };
}

function expectedDigest(flags: ParsedArgs["flags"], name: "outcome" | "environment"): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new UsageError(`--${name} must be sha256: followed by 64 lowercase hex digits`);
  }
  return value;
}

function renderValidation(validation: ManifestValidation): string {
  if (!validation.ok) {
    return `INVALID: manifest rejected by the strict grammar\nmanifest: ${validation.path}\n` +
      validation.problems.map((problem) => `problem: ${problem}\n`).join("") +
      "executed: nothing (no commands, listeners, installs, or network)\n";
  }
  const manifest = validation.manifest;
  const steps = manifest.steps.map((step) => {
    const expectation = step.expect === null ? "no transaction expectation"
      : `${step.expect.tx}${step.expect.errorCode === undefined ? "" : ` error ${step.expect.errorCode}`}`;
    return `step: ${step.name} (${expectation}; ${step.claims} claim${step.claims === 1 ? "" : "s"}; timeout ${step.timeoutMs}ms)\n`;
  }).join("");
  return `VALID: manifest parsed under the strict ${manifest.spec} grammar\n` +
    `manifest: ${manifest.path}\nname: ${manifest.name}\nsha256: ${manifest.sha256}\n` +
    `toolchain: ckb ${manifest.toolchain.ckb}, offckb ${manifest.toolchain.offckb}` +
    `${manifest.toolchain.ckbDebugger === null ? ", no debugger" : `, ckb-debugger ${manifest.toolchain.ckbDebugger}`}\n` +
    `accounts: ${manifest.accounts}\nreplay dependencies: ${manifest.replayDependencies.length === 0 ? "none" : manifest.replayDependencies.join(", ")}\n` +
    steps + `final claims: ${manifest.finalClaims}\nclaims: ${manifest.claimCount}\n` +
    "executed: nothing (no commands, listeners, installs, or network)\n";
}

function renderInspection(inspection: ReportInspection): string {
  const lines: string[] = [];
  lines.push(inspection.valid
    ? `VALID: report is internally consistent${inspection.ok ? "" : " but an expected digest did not match"}`
    : "INVALID: report is not internally consistent and must not be trusted as evidence");
  if (inspection.path !== null) lines.push(`report: ${inspection.path}`);
  if (inspection.sha256 !== null) lines.push(`file sha256: ${inspection.sha256}`);
  if (inspection.schema !== null) lines.push(`schema: ${inspection.schema}${inspection.spec === null ? "" : ` (spec ${inspection.spec})`}`);
  if (inspection.name !== null) lines.push(`name: ${inspection.name}`);
  if (inspection.verdict !== null) {
    lines.push(`verdict: ${inspection.verdict} (recorded claim result${inspection.valid ? "" : ", unverified"}; validity is not claim success)`);
  }
  const digests = inspection.valid ? inspection.digests.recomputed : null;
  if (digests !== null) {
    lines.push(`outcome: ${digests.outcome}`);
    lines.push(`environment: ${digests.environment}`);
  } else if (inspection.digests.stored !== null) {
    lines.push(`stored outcome (unverified): ${inspection.digests.stored.outcome}`);
    lines.push(`stored environment (unverified): ${inspection.digests.stored.environment}`);
  }
  if (inspection.replay !== null) {
    lines.push(`replay: ${inspection.replay.status}${inspection.replay.reasons.length === 0 ? "" : ` (${inspection.replay.reasons.map((reason) => reason.code).join(", ")})`}`);
  }
  if (inspection.source !== null) {
    lines.push(`source: ${inspection.source.gitCommit ?? "unknown"}${inspection.source.dirty === null ? "" : inspection.source.dirty ? " (dirty)" : " (clean)"}`);
  }
  if (inspection.runner !== null) lines.push(`runner: ${inspection.runner.name} ${inspection.runner.version}`);
  if (inspection.expected !== null) {
    for (const key of ["outcome", "environment"] as const) {
      const matches = inspection.expected[`${key}Matches`];
      if (matches !== null) lines.push(`expected ${key}: ${matches ? "match" : "MISMATCH"}`);
    }
  }
  for (const problem of inspection.problems) lines.push(`problem: ${problem}`);
  return `${lines.join("\n")}\n`;
}

async function offlineCommand(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const command = args[0];
  let output: ManifestValidation | ReportInspection;
  let json = false;
  try {
    if (command === "validate") {
      const parsed = parseArgs(args.slice(1), ["json"], []);
      if (parsed.positional.length > 1) throw new UsageError("validate accepts at most one manifest path");
      json = parsed.flags.has("json");
      output = await validateManifestFile(parsed.positional[0] ?? "verify.toml");
    } else {
      const parsed = parseArgs(args.slice(1), ["json", "allow-legacy"], command === "check-digest" ? ["outcome", "environment"] : []);
      if (parsed.positional.length !== 1) throw new UsageError(`${command} requires exactly one report path`);
      json = parsed.flags.has("json");
      let expected: ExpectedDigests | undefined;
      if (command === "check-digest") {
        expected = {};
        const outcome = expectedDigest(parsed.flags, "outcome");
        const environment = expectedDigest(parsed.flags, "environment");
        if (outcome !== undefined) expected.outcome = outcome;
        if (environment !== undefined) expected.environment = environment;
        if (outcome === undefined && environment === undefined) {
          throw new UsageError("check-digest requires --outcome and/or --environment");
        }
      }
      output = await inspectReportFile(parsed.positional[0]!, {
        command: command as "digest" | "check-digest",
        allowLegacy: parsed.flags.has("allow-legacy"),
        ...(expected === undefined ? {} : { expected }),
      });
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof OfflineInputError) {
      dependencies.stderr(`ckb-verify ${command}: ${error.message}\n`);
      return 2;
    }
    dependencies.stderr(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  dependencies.stdout(json ? `${JSON.stringify(output, null, 2)}\n` : output.command === "validate" ? renderValidation(output) : renderInspection(output));
  return output.ok ? 0 : 1;
}

export async function main(
  args = process.argv.slice(2),
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    dependencies.stdout(`${VERSION}\n`);
    return 0;
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    dependencies.stdout(HELP);
    return 0;
  }

  if (args[0] === "validate" || args[0] === "digest" || args[0] === "check-digest") {
    return offlineCommand(args, dependencies);
  }

  if (args[0] === "run" && args.length <= 2) {
    const controller = new AbortController();
    let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
    const unsubscribe = dependencies.subscribeSignals?.((signal) => {
      if (receivedSignal !== undefined) return;
      receivedSignal = signal;
      controller.abort(signal);
    });
    try {
      const result = await dependencies.runManifest({
        manifestPath: args[1] ?? "verify.toml",
        projectRoot: process.cwd(),
        signal: controller.signal,
      });
      if (receivedSignal !== undefined) return receivedSignal === "SIGINT" ? 130 : 143;
      dependencies.stdout(
        `${result.verdict}: ${
          result.verdict === "PASS"
            ? "All declared claims passed in the recorded environment."
            : "One or more declared claims failed."
        }\n` +
          `report: ${result.reportPath}\n` +
          `outcome: ${result.report.digests.outcome}\n` +
          `environment: ${result.report.digests.environment}\n`,
      );
      return result.verdict === "PASS" ? 0 : 1;
    } catch (error) {
      if (receivedSignal !== undefined) return receivedSignal === "SIGINT" ? 130 : 143;
      dependencies.stderr(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    } finally {
      unsubscribe?.();
    }
  }

  dependencies.stderr(`ckb-verify: unsupported command: ${args.join(" ")}\n`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main();
}
