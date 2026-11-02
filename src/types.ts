export type TransactionExpectation = "committed" | "rejected";
export type ReplayDependency =
  | "external_time"
  | "randomness"
  | "fee_estimation"
  | "dynamic_since"
  | "external_network";

/** `0.1.0` is the frozen v0.1 contract: the draft.5 grammar under its release identifier. */
export type V01Spec = "0.1.0-draft.5" | "0.1.0";
export type ManifestSpec = "0.1.0-draft.3" | "0.1.0-draft.4" | V01Spec;
export interface ManifestMeta<S extends ManifestSpec = ManifestSpec> {
  name: string;
  spec: S;
  description?: string;
}

export interface ManifestToolchain {
  ckb: string;
  offckb: "0.4.13";
  ckbDebugger?: string;
}

export interface CellOutPointReference {
  step: string;
  index: number;
}

export interface CellAssertion {
  kind: "cell";
  outPoint: CellOutPointReference;
  count: number;
}

export type Builtin = "dao" | "spore";
export type BuiltinRef = { kind: "builtin"; name: Builtin };
export type TypeCheck = BuiltinRef & { argsBytes: number };
export interface CellAssertionV4 {
  kind: "cell";
  outPoint: CellOutPointReference;
  count: 0 | 1;
  type?: TypeCheck;
  data?: { minBytes: number };
}
export interface CellDepsAssertionV4 { kind: "cell_deps"; step: string; contains: BuiltinRef }
export type ClaimV4 = CellAssertionV4 | CellDepsAssertionV4;

export interface StepExpectation {
  tx: TransactionExpectation;
  error?: { code?: number };
  /** draft.5 only: comparators on the step's verification cycles. */
  cycles?: CyclesCheck;
}

export interface ManifestStep<A = CellAssertion> {
  name: string;
  run: string;
  timeoutMs: number;
  expect?: StepExpectation;
  assertions: A[];
}

interface VersionedManifest<S extends ManifestSpec, A> {
  meta: ManifestMeta<S>;
  toolchain: ManifestToolchain;
  replay: { dependencies: ReplayDependency[] };
  setup: { accounts: number };
  steps: ManifestStep<A>[];
  assertions: A[];
}
export type ManifestV3 = VersionedManifest<"0.1.0-draft.3", CellAssertion>;
export type ManifestV4 = VersionedManifest<"0.1.0-draft.4", ClaimV4>;
export type ManifestV5 = VersionedManifest<V01Spec, ClaimV5>;
export type Manifest = ManifestV3 | ManifestV4 | ManifestV5;
export function isManifestV4(manifest: Manifest): manifest is ManifestV4 {
  return manifest.meta.spec === "0.1.0-draft.4";
}
/** The draft.5 grammar, written as `0.1.0-draft.5` or as the frozen `0.1.0`. */
export function isManifestV5(manifest: Manifest): manifest is ManifestV5 {
  return manifest.meta.spec === "0.1.0-draft.5" || manifest.meta.spec === "0.1.0";
}

// ---- 0.1.0-draft.5: the RFC §4.2 / §5 vocabulary ----

/** The system scripts OffCKB 0.4.13 exports for its devnet; the only named script references. */
export const SYSTEM_SCRIPT_NAMES = [
  "secp256k1_blake160_sighash_all", "dao", "secp256k1_blake160_multisig_all", "sudt", "xudt", "omnilock",
  "anyone_can_pay", "always_success", "spore", "spore_cluster", "spore_cluster_agent", "spore_cluster_proxy",
  "spore_extension_lua", "ckb_js_vm", "nostr_lock", "secp256k1_keccak256_sighash_all",
  "secp256k1_keccak256_sighash_all_acpl", "secp256k1_blake160_multisig_all_v2", "type_id",
] as const;
export type SystemScriptName = (typeof SYSTEM_SCRIPT_NAMES)[number];
export type ScriptHashType = "data" | "type" | "data1" | "data2";
/** A script reference: explicit, an OffCKB built-in (args `null` = wildcard), or an exported account's lock. */
export type ScriptRef =
  | { kind: "explicit"; codeHash: string; hashType: ScriptHashType; args: string }
  | { kind: "builtin"; name: SystemScriptName; args: string | null }
  | { kind: "account"; index: number };
export interface CountRange { eq?: number; gte?: number; lte?: number }
/** Decimal strings of base units (shannons for CKB, token units for UDT); never floating point. */
export interface QuantityRange { eq?: string; gte?: string; lte?: string }
export interface CyclesCheck { lt?: number; lte?: number; eq?: number; gte?: number }
export interface CellAssertionV5 {
  kind: "cell";
  selector: { outPoint?: CellOutPointReference; lock?: ScriptRef; type?: ScriptRef };
  count: CountRange;
  data?: { eq?: string; len?: number; minBytes?: number };
  capacity?: QuantityRange;
}
export interface CellDepsAssertionV5 { kind: "cell_deps"; step: string; contains: { kind: "builtin"; name: SystemScriptName } }
export type BalanceTarget =
  | { kind: "account"; index: number }
  | { kind: "address"; address: string; lock: { codeHash: string; hashType: ScriptHashType; args: string } }
  | { kind: "lock"; script: ScriptRef };
export interface BalanceAssertionV5 {
  kind: "balance";
  target: BalanceTarget;
  udt?: { type: ScriptRef };
  amount: QuantityRange;
}
export type ClaimV5 = CellAssertionV5 | CellDepsAssertionV5 | BalanceAssertionV5;
