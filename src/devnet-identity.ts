// Independent identity of the default OffCKB devnet (spec 0.2.0, environment/5): the genesis hash and the
// sealing configuration a fresh `offckb node` produces for each pinned CKB release. A run whose genesis
// differs is refused before any step; a different sealing configuration is recorded and taints replay.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalSha256, sha256Bytes } from "./canonical";

/** The files that decide how the devnet seals blocks: node config (block assembler), miner config, chain spec. */
export const SEALING_FILES = ["ckb.toml", "ckb-miner.toml", "specs/dev.toml"] as const;
export interface SealingConfiguration { files: Array<{ path: (typeof SEALING_FILES)[number]; sha256: string }>; fingerprint: string }

/** Pinned per CKB binary version, for OffCKB 0.4.13; measured on fresh devnets, never derived from a run being verified. */
export const DEFAULT_DEVNET: Readonly<Record<string, { genesisHash: string; sealingFingerprint: string }>> = {
  "0.209.0": {
    genesisHash: "0xb15fa8a50781f3a8bf84759682e2ce4027b7ae5361df45e8b68855ee413104be",
    sealingFingerprint: "sha256:ef45c0329135f660c47a4a5bab92f8ea26c2ec2ba48b393f6223721381b17f3f",
  },
};

export function sealingFingerprint(files: SealingConfiguration["files"]): string {
  return canonicalSha256({ files });
}

export async function readSealingConfiguration(devnetDirectory: string): Promise<SealingConfiguration> {
  const files: SealingConfiguration["files"] = [];
  for (const path of SEALING_FILES) files.push({ path, sha256: sha256Bytes(await readFile(join(devnetDirectory, path))) });
  return { files, fingerprint: sealingFingerprint(files) };
}

export function defaultDevnet(ckbVersion: string): { genesisHash: string; sealingFingerprint: string } {
  const entry = DEFAULT_DEVNET[ckbVersion];
  if (entry === undefined) throw new Error(`no pinned default devnet identity for CKB ${ckbVersion}`);
  return entry;
}
