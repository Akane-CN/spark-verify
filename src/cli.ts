#!/usr/bin/env bun

import { runManifest as executeManifest, type RunManifestResult } from "./runner";
import { VERSION } from "./version";

const HELP = `ckb-verify ${VERSION}

Usage:
  ckb-verify run [manifest]
  ckb-verify --help
  ckb-verify --version

Commands:
  run [manifest]  Execute declared CKB acceptance claims (default: verify.toml)
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
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
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
