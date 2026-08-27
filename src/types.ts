export type TransactionExpectation = "committed" | "rejected";

export interface ManifestMeta {
  name: string;
  spec: "0.1.0-draft.3";
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

export interface StepExpectation {
  tx: TransactionExpectation;
  error?: {
    code?: number;
  };
}

export interface ManifestStep {
  name: string;
  run: string;
  timeoutMs: number;
  expect?: StepExpectation;
  assertions: CellAssertion[];
}

export interface Manifest {
  meta: ManifestMeta;
  toolchain: ManifestToolchain;
  replay: { dependencies: [] };
  setup: { accounts: number };
  steps: ManifestStep[];
  assertions: CellAssertion[];
}
