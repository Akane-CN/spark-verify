// provenance/4 (spec 0.2.0): everything provenance/3 records, plus the RFC §6.1 items it lacked — a
// sanitized repository identity, every common lockfile instead of only bun.lock, runtime and
// package-manager pins from package.json, .tool-versions, mise.toml, .nvmrc and .node-version with the
// versions the step commands actually see, and the devnet sealing-configuration fingerprint, whose
// difference from the pinned default taints replay as `nondefault_devnet`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Bytes } from "./canonical";
import type { InstalledCkbBinary } from "./ckb-binary";
import { assertDebuggerBinaryEvidence, type DebuggerBinaryEvidence } from "./debugger-binary";
import type { SourceRevision, ToolchainDrift } from "./provenance";
import type { ReplayDependency } from "./types";

export const PROVENANCE_V4 = "ckb-verify-provenance/4" as const;
/** Lockfiles recorded when present, in this order; at least one is required for a stable run. */
export const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock"] as const;
/** Runtime metadata files hashed when present; the pin sources among them are parsed. */
export const RUNTIME_METADATA = ["package.json", ".tool-versions", "mise.toml", ".mise.toml", ".nvmrc", ".node-version", "rust-toolchain.toml", "rust-toolchain"] as const;
export const RUNTIME_TOOLS = ["bun", "node", "npm", "pnpm", "yarn"] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];
export type PinSource = "package.json#packageManager" | ".tool-versions" | "mise.toml" | ".mise.toml" | ".nvmrc" | ".node-version";

export type ReasonCodeV4 =
  | ReplayDependency | "dirty_source" | "source_revision_unavailable" | "source_state_unavailable"
  | "runtime_pin_missing" | "runtime_version_drift" | "tool_version_drift" | "lockfile_missing" | "nondefault_devnet";
export interface ReasonV4 { scope: "environment" | "outcome"; code: ReasonCodeV4; detail: string }

export interface RuntimePin { tool: RuntimeTool; requested: string; source: PinSource }
export interface ProvenanceEvidenceV4 {
  schema: typeof PROVENANCE_V4;
  replay: { declaredDependencies: ReplayDependency[]; status: "stable" | "tainted"; reasons: ReasonV4[] };
  source: SourceRevision;
  /** The `origin` remote with credentials, userinfo, query and fragment removed; null when absent or local. */
  repository: { remote: "origin"; url: string } | null;
  manifest: { sha256: string };
  lockfiles: Array<{ path: (typeof LOCKFILES)[number]; sha256: string }>;
  runtime: {
    metadata: Array<{ path: (typeof RUNTIME_METADATA)[number]; sha256: string }>;
    pins: RuntimePin[];
    /** One entry per pinned tool: the version `<tool> --version` reported in the step environment, or null. */
    observed: Array<{ tool: RuntimeTool; version: string | null }>;
  };
  binaries: { ckb: Omit<InstalledCkbBinary, "path">; ckbDebugger: DebuggerBinaryEvidence | null };
  toolchain: ToolchainDrift;
  devnet: { sealingFingerprint: string; defaultSealingFingerprint: string };
}

const EXACT = /^\d+\.\d+\.\d+$/;
const TOOL_ALIASES: Record<string, RuntimeTool> = { bun: "bun", node: "node", nodejs: "node", npm: "npm", pnpm: "pnpm", yarn: "yarn" };

/** Keeps scheme, host, port and path of a network remote; drops userinfo, query and fragment; null for local paths. */
export function sanitizeRepositoryUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || /\s/.test(text)) return null;
  const scp = /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/.exec(text);
  if (scp !== null && !/^[A-Za-z]:[\\/]/.test(text)) return `ssh://${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.hostname === "") return null;
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port === "" ? "" : `:${url.port}`}${url.pathname}`;
}

async function readOptional(path: string): Promise<Uint8Array | null> {
  try { return await readFile(path); } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

/** Runtime pins in a fixed source order; each tool may be pinned by several sources. */
export function parseRuntimePins(files: Partial<Record<(typeof RUNTIME_METADATA)[number], string>>): RuntimePin[] {
  const pins: RuntimePin[] = [];
  const add = (rawTool: string, requested: string, source: PinSource) => {
    const tool = TOOL_ALIASES[rawTool.toLowerCase()];
    if (tool !== undefined && requested !== "") pins.push({ tool, requested, source });
  };
  if (files["package.json"] !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(files["package.json"]); } catch (error) {
      throw new Error("package.json is not valid JSON", error instanceof Error ? { cause: error } : undefined);
    }
    const packageManager = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).packageManager : undefined;
    if (typeof packageManager === "string") {
      const match = /^(bun|npm|pnpm|yarn)@([^+\s]+)(?:\+\S+)?$/.exec(packageManager);
      if (match !== null) add(match[1]!, match[2]!, "package.json#packageManager");
    }
  }
  if (files[".tool-versions"] !== undefined) {
    for (const line of files[".tool-versions"].split(/\r?\n/)) {
      const fields = line.replace(/#.*/, "").trim().split(/\s+/);
      if (fields.length >= 2) add(fields[0]!, fields[1]!, ".tool-versions");
    }
  }
  for (const source of ["mise.toml", ".mise.toml"] as const) {
    const text = files[source];
    if (text === undefined) continue;
    let parsed: unknown;
    try { parsed = Bun.TOML.parse(text); } catch (error) {
      throw new Error(`${source} is not valid TOML`, error instanceof Error ? { cause: error } : undefined);
    }
    const tools = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).tools : undefined;
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) continue;
    for (const [tool, value] of Object.entries(tools as Record<string, unknown>)) {
      const version = typeof value === "string" ? value
        : Array.isArray(value) && typeof value[0] === "string" ? value[0]
        : value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).version === "string" ? (value as Record<string, string>).version : undefined;
      if (version !== undefined) add(tool, version, source);
    }
  }
  for (const source of [".nvmrc", ".node-version"] as const) {
    const text = files[source];
    if (text !== undefined) add("node", (text.split(/\r?\n/)[0] ?? "").trim().replace(/^v(?=\d)/, ""), source);
  }
  return pins;
}

/** The first x.y.z in a `--version` line, e.g. `10.9.2`, `v22.22.0`, `1.2.19`. */
export function parseToolVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

export function replayReasonsV4(p: Omit<ProvenanceEvidenceV4, "replay" | "schema"> & { replay: { declaredDependencies: readonly ReplayDependency[] } }): ReasonV4[] {
  const reasons: ReasonV4[] = p.replay.declaredDependencies.map((dependency) => ({ scope: "outcome", code: dependency, detail: `manifest declares replay dependency ${dependency}` }));
  if (p.source.gitCommit === null) reasons.push({ scope: "environment", code: "source_revision_unavailable", detail: "source git revision is unavailable" });
  if (p.source.dirty === null) reasons.push({ scope: "environment", code: "source_state_unavailable", detail: "source dirty state is unavailable" });
  else if (p.source.dirty) reasons.push({ scope: "environment", code: "dirty_source", detail: "source tree differs from the recorded git commit" });
  const manager = p.runtime.pins.find((pin) => pin.source === "package.json#packageManager");
  if (manager === undefined || !EXACT.test(manager.requested)) {
    reasons.push({ scope: "environment", code: "runtime_pin_missing", detail: "package.json does not contain an exact <bun|npm|pnpm|yarn>@x.y.z packageManager pin" });
  }
  for (const pin of p.runtime.pins) {
    if (pin === manager) continue;
    if (!EXACT.test(pin.requested)) reasons.push({ scope: "environment", code: "runtime_pin_missing", detail: `${pin.source} pins ${pin.tool} to "${pin.requested}", which is not an exact x.y.z version` });
  }
  for (const { tool, version } of p.runtime.observed) {
    for (const pin of p.runtime.pins.filter((candidate) => candidate.tool === tool && EXACT.test(candidate.requested))) {
      if (version !== pin.requested) {
        reasons.push({ scope: "environment", code: "runtime_version_drift", detail: `${pin.source} requests ${tool} ${pin.requested} but the step environment has ${version ?? "no " + tool}` });
      }
    }
  }
  if (p.lockfiles.length === 0) reasons.push({ scope: "environment", code: "lockfile_missing", detail: `no lockfile found (${LOCKFILES.join(", ")})` });
  if (p.toolchain.ckb.requested !== p.toolchain.ckb.observed) {
    reasons.push({ scope: "environment", code: "tool_version_drift", detail: `requested ckb ${p.toolchain.ckb.requested} but observed ${p.toolchain.ckb.observed} (allowed by --allow-version-drift)` });
  }
  if (p.devnet.sealingFingerprint !== p.devnet.defaultSealingFingerprint) {
    reasons.push({ scope: "environment", code: "nondefault_devnet", detail: "the devnet sealing configuration differs from the pinned OffCKB default" });
  }
  return reasons;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, keys: readonly string[], path: string) => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) throw new Error(`${path} must have exactly ${expected.join(", ")}`);
};
const sha = (value: unknown, path: string) => { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${path} must be a sha256 digest`); };

/** Structural and semantic consistency of provenance/4: shapes, orderings, and replay reasons re-derived from the recorded inputs. */
export function assertProvenanceV4Consistency(value: unknown): asserts value is ProvenanceEvidenceV4 {
  if (!isRecord(value) || value.schema !== PROVENANCE_V4) throw new Error("provenance/4 required");
  exactly(value, ["schema", "replay", "source", "repository", "manifest", "lockfiles", "runtime", "binaries", "toolchain", "devnet"], "provenance");
  const p = value as unknown as ProvenanceEvidenceV4;
  if (!isRecord(p.source)) throw new Error("provenance.source must be an object");
  exactly(p.source as unknown as Record<string, unknown>, ["gitCommit", "dirty", "dirtyDigest"], "provenance.source");
  if (p.source.gitCommit !== null && (typeof p.source.gitCommit !== "string" || !/^[0-9a-f]{40}$/.test(p.source.gitCommit))) throw new Error("source git commit must be a lowercase 40-character hash");
  if (p.source.dirty !== null && typeof p.source.dirty !== "boolean") throw new Error("source dirty state must be boolean or null");
  if (p.source.dirty !== true && p.source.dirtyDigest !== null) throw new Error("only a dirty source revision may include a dirty digest");
  if (p.source.dirtyDigest !== null) sha(p.source.dirtyDigest, "source dirty digest");
  if (p.repository !== null) {
    if (!isRecord(p.repository)) throw new Error("provenance.repository must be an object or null");
    exactly(p.repository, ["remote", "url"], "provenance.repository");
    if (p.repository.remote !== "origin" || typeof p.repository.url !== "string" || sanitizeRepositoryUrl(p.repository.url) !== p.repository.url) {
      throw new Error("provenance.repository.url must be a sanitized network remote");
    }
  }
  if (!isRecord(p.manifest)) throw new Error("provenance.manifest must be an object");
  exactly(p.manifest, ["sha256"], "provenance.manifest"); sha(p.manifest.sha256, "provenance.manifest.sha256");
  if (!Array.isArray(p.lockfiles)) throw new Error("provenance.lockfiles must be an array");
  const lockOrder = p.lockfiles.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`provenance.lockfiles[${i}] must be an object`);
    exactly(entry, ["path", "sha256"], `provenance.lockfiles[${i}]`); sha(entry.sha256, `provenance.lockfiles[${i}].sha256`);
    const index = (LOCKFILES as readonly string[]).indexOf(entry.path as string);
    if (index < 0) throw new Error(`provenance.lockfiles[${i}].path is not a recorded lockfile name`);
    return index;
  });
  if (lockOrder.some((index, i) => i > 0 && index <= lockOrder[i - 1]!)) throw new Error("provenance.lockfiles must be unique and in the fixed order");
  if (!isRecord(p.runtime)) throw new Error("provenance.runtime must be an object");
  exactly(p.runtime, ["metadata", "pins", "observed"], "provenance.runtime");
  if (!Array.isArray(p.runtime.metadata) || !Array.isArray(p.runtime.pins) || !Array.isArray(p.runtime.observed)) throw new Error("provenance.runtime members must be arrays");
  const metaOrder = p.runtime.metadata.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`provenance.runtime.metadata[${i}] must be an object`);
    exactly(entry, ["path", "sha256"], `provenance.runtime.metadata[${i}]`); sha(entry.sha256, `provenance.runtime.metadata[${i}].sha256`);
    const index = (RUNTIME_METADATA as readonly string[]).indexOf(entry.path as string);
    if (index < 0) throw new Error(`provenance.runtime.metadata[${i}].path is not a recorded metadata name`);
    return index;
  });
  if (metaOrder.some((index, i) => i > 0 && index <= metaOrder[i - 1]!)) throw new Error("provenance.runtime.metadata must be unique and in the fixed order");
  const metadataPaths = new Set(p.runtime.metadata.map((entry) => entry.path as string));
  p.runtime.pins.forEach((pin, i) => {
    if (!isRecord(pin)) throw new Error(`provenance.runtime.pins[${i}] must be an object`);
    exactly(pin, ["tool", "requested", "source"], `provenance.runtime.pins[${i}]`);
    if (!(RUNTIME_TOOLS as readonly string[]).includes(pin.tool as string) || typeof pin.requested !== "string" || pin.requested === "") throw new Error(`provenance.runtime.pins[${i}] is malformed`);
    const file = (pin.source as string).replace(/#packageManager$/, "");
    if (!metadataPaths.has(file)) throw new Error(`provenance.runtime.pins[${i}].source ${String(pin.source)} has no recorded metadata digest`);
  });
  const pinnedTools = [...new Set(p.runtime.pins.map((pin) => pin.tool))].sort();
  const observedTools = p.runtime.observed.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`provenance.runtime.observed[${i}] must be an object`);
    exactly(entry, ["tool", "version"], `provenance.runtime.observed[${i}]`);
    if (entry.version !== null && (typeof entry.version !== "string" || !EXACT.test(entry.version))) throw new Error(`provenance.runtime.observed[${i}].version must be x.y.z or null`);
    return entry.tool as string;
  });
  if (observedTools.join(",") !== pinnedTools.join(",")) throw new Error("provenance.runtime.observed must list each pinned tool once, sorted");
  if (!isRecord(p.binaries)) throw new Error("provenance.binaries must be an object");
  exactly(p.binaries, ["ckb", "ckbDebugger"], "provenance.binaries");
  const ckb = p.binaries.ckb as unknown;
  if (!isRecord(ckb) || !["version", "platform", "architecture", "asset", "sourceUrl", "expectedArchiveSha256", "archiveSha256", "binarySha256"].every((key) => typeof ckb[key] === "string")) {
    throw new Error("provenance.binaries.ckb is malformed");
  }
  if (ckb.expectedArchiveSha256 !== ckb.archiveSha256) throw new Error("CKB archive provenance mismatch");
  if (p.binaries.ckbDebugger !== null) assertDebuggerBinaryEvidence(p.binaries.ckbDebugger);
  const drift = p.toolchain as unknown;
  if (!isRecord(drift) || !isRecord(drift.ckb) || typeof drift.ckb.requested !== "string" || typeof drift.ckb.observed !== "string" || typeof drift.ckb.driftAllowed !== "boolean") {
    throw new Error("provenance.toolchain is malformed");
  }
  exactly(drift, ["ckb"], "provenance.toolchain"); exactly(drift.ckb, ["requested", "observed", "driftAllowed"], "provenance.toolchain.ckb");
  if (drift.ckb.requested !== drift.ckb.observed && drift.ckb.driftAllowed !== true) throw new Error("tool-version drift was recorded without being allowed");
  if (!isRecord(p.devnet)) throw new Error("provenance.devnet must be an object");
  exactly(p.devnet, ["sealingFingerprint", "defaultSealingFingerprint"], "provenance.devnet");
  sha(p.devnet.sealingFingerprint, "provenance.devnet.sealingFingerprint"); sha(p.devnet.defaultSealingFingerprint, "provenance.devnet.defaultSealingFingerprint");
  if (!isRecord(p.replay)) throw new Error("provenance.replay must be an object");
  exactly(p.replay, ["declaredDependencies", "status", "reasons"], "provenance.replay");
  const dependencies = ["external_time", "randomness", "fee_estimation", "dynamic_since", "external_network"];
  if (!Array.isArray(p.replay.declaredDependencies) || !p.replay.declaredDependencies.every((d) => dependencies.includes(d))) throw new Error("provenance.replay.declaredDependencies is malformed");
  const expected = replayReasonsV4(p);
  if (JSON.stringify(p.replay.reasons) !== JSON.stringify(expected)) throw new Error("provenance replay reasons do not match the recorded inputs");
  if (p.replay.status !== (expected.length === 0 ? "stable" : "tainted")) throw new Error(`provenance replay status must be ${expected.length === 0 ? "stable" : "tainted"}`);
}

export interface CollectProvenanceV4Options {
  projectRoot: string;
  manifestBytes: Uint8Array;
  replayDependencies: readonly ReplayDependency[];
  sourceRevision: SourceRevision;
  repositoryUrl: string | null;
  ckbBinary: Omit<InstalledCkbBinary, "path">;
  ckbDebuggerBinary: DebuggerBinaryEvidence | null;
  toolchain: ToolchainDrift;
  sealingFingerprint: string;
  defaultSealingFingerprint: string;
  /** Runs `<tool> --version` in the step environment; null when the tool is missing or fails. */
  observeTool(tool: RuntimeTool): Promise<string | null>;
}

export async function collectProvenanceV4(options: CollectProvenanceV4Options): Promise<ProvenanceEvidenceV4> {
  const lockfiles: ProvenanceEvidenceV4["lockfiles"] = [];
  for (const path of LOCKFILES) {
    const bytes = await readOptional(join(options.projectRoot, path));
    if (bytes !== null) lockfiles.push({ path, sha256: sha256Bytes(bytes) });
  }
  const metadata: ProvenanceEvidenceV4["runtime"]["metadata"] = [];
  const texts: Partial<Record<(typeof RUNTIME_METADATA)[number], string>> = {};
  for (const path of RUNTIME_METADATA) {
    const bytes = await readOptional(join(options.projectRoot, path));
    if (bytes === null) continue;
    metadata.push({ path, sha256: sha256Bytes(bytes) });
    texts[path] = new TextDecoder().decode(bytes);
  }
  const pins = parseRuntimePins(texts);
  const observed: ProvenanceEvidenceV4["runtime"]["observed"] = [];
  for (const tool of [...new Set(pins.map((pin) => pin.tool))].sort()) observed.push({ tool, version: await options.observeTool(tool) });
  const body = {
    source: { ...options.sourceRevision },
    repository: options.repositoryUrl === null ? null : { remote: "origin" as const, url: options.repositoryUrl },
    manifest: { sha256: sha256Bytes(options.manifestBytes) },
    lockfiles,
    runtime: { metadata, pins, observed },
    binaries: { ckb: { ...options.ckbBinary }, ckbDebugger: options.ckbDebuggerBinary },
    toolchain: { ckb: { ...options.toolchain.ckb } },
    devnet: { sealingFingerprint: options.sealingFingerprint, defaultSealingFingerprint: options.defaultSealingFingerprint },
  };
  const reasons = replayReasonsV4({ ...body, replay: { declaredDependencies: options.replayDependencies } });
  const provenance: ProvenanceEvidenceV4 = {
    schema: PROVENANCE_V4,
    replay: { declaredDependencies: [...options.replayDependencies], status: reasons.length === 0 ? "stable" : "tainted", reasons },
    ...body,
  };
  assertProvenanceV4Consistency(provenance);
  return provenance;
}
