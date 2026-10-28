export type TransactionExpectation = "committed" | "rejected";
export type ReplayDependency =
  | "external_time"
  | "randomness"
  | "fee_estimation"
  | "dynamic_since"
  | "external_network";

export type ManifestSpec = "0.1.0-draft.3" | "0.1.0-draft.4";
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
export type Manifest = ManifestV3 | ManifestV4;
export function isManifestV4(manifest: Manifest): manifest is ManifestV4 {
  return manifest.meta.spec === "0.1.0-draft.4";
}
