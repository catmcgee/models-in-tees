export type {
  AuditCheck,
  ChainReadback,
  DisclosedLeaf,
  ExperimentDetail,
  ExperimentKind,
  ExperimentReceiptPayload,
  ExperimentSummary,
  MerkleProofStep,
  ModelDescriptor,
  PublicExperimentRecord,
  RecordVerification,
  SaeDescriptor,
  SignedExperimentReceipt,
  SolanaCommitment,
  TeeEvidenceSummary
} from "../shared/receiptTypes.js";
import type {
  AuditCheck,
  ExperimentKind,
  PublicExperimentRecord,
  SaeDescriptor
} from "../shared/receiptTypes.js";

export interface ModelInfo {
  modelId: string;
  commitment: string;
  weightsPublic: false;
  architecture: Record<string, unknown>;
  runtime: Record<string, unknown>;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  sae: SaeDescriptor | null;
  saeError?: string;
}

export interface RegistryExperiment {
  id: string;
  kind: ExperimentKind;
  title: string;
  description: string;
  params: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  itemCount: number;
  datasetHash: string;
  experimentHash: string;
}

export interface Registry {
  schema: string;
  registryHash: string;
  experiments: RegistryExperiment[];
}

/** What the Python worker returns for run-experiment. */
export interface RunExperimentResult {
  schema: "tee-ai-experiment-result/v1";
  experiment: {
    id: string;
    kind: ExperimentKind;
    title: string;
    params: Record<string, unknown>;
    itemCount: number;
    datasetHash: string;
    experimentHash: string;
    registryHash: string;
  };
  model: {
    commitment: string;
    modelId: string;
    architecture: Record<string, unknown>;
    runtime: Record<string, unknown>;
  };
  sae: SaeDescriptor | null;
  policy: Record<string, unknown>;
  policyHash: string;
  results: {
    resultsRoot: string;
    leafCount: number;
    leafSchema: string;
    merkleScheme: string;
    metrics: Record<string, unknown>;
    metricsHash: string;
  };
  disclosure: {
    scheme: string;
    seed: string;
    count: number;
    indices: number[];
    leaves: Array<{
      index: number;
      leaf: Record<string, unknown>;
      leafHash: string;
      proof: Array<{ hash: string; side: "left" | "right" }>;
    }>;
  };
  sealed: { leaves: Array<Record<string, unknown>>; leafHashes: string[] };
  descriptive: Record<string, unknown>;
  timing: { totalMs: number; forwardPasses: number };
}

export interface WorkloadMeasurement {
  schema: "tee-ai-workload/v1";
  workloadHash: string;
  generatedAt: string;
  files: Array<{
    path: string;
    sizeBytes: number;
    sha256: string;
  }>;
  config: {
    programId: string;
    solanaRpcUrl: string;
    llmModelId: string;
    saeRepo: string;
    saeSubfolder: string;
    teeMode: string;
    teeProvider: string;
    node: string;
    platform: string;
    arch: string;
  };
}

export interface TeeEvidence {
  schema: "tee-evidence/v1";
  collectedAt: string;
  teeMode: string;
  teeProvider: string;
  source: string;
  nonce: string;
  gcpMetadata?: Record<string, string>;
  runtime: {
    platform: string;
    arch: string;
    node: string;
    kernel?: string;
    cpuFlags?: string[];
  };
  workload?: WorkloadMeasurement;
  attestation: {
    status: "google-claims-token" | "local-tpm-report" | "unavailable" | "failed";
    token?: {
      audience?: string;
      issuer?: string;
      subject?: string;
      issuedAt?: number;
      expiresAt?: number;
      tokenHash: string;
      rawToken?: string;
      claims: Record<string, unknown>;
      header: Record<string, unknown>;
    };
    report?: {
      nonce: string;
      format: "textproto";
      sizeBytes: number;
      reportHash: string;
      textproto?: string;
    };
    errors: string[];
  };
  evidenceHash: string;
}

/** Stored server-side; never returned as-is. */
export interface ExperimentRecord extends PublicExperimentRecord {
  teeEvidence: TeeEvidence;
  metricsHash: string;
}

export type StoredRecord = ExperimentRecord;

export interface SealedRecord {
  runId: string;
  experimentId: string;
  resultsRoot: string;
  leafCount: number;
  leafSchema: string;
  leaves: Array<Record<string, unknown>>;
  leafHashes: string[];
}

export interface ReceiptAudit {
  ok: boolean;
  receiptDigest?: string;
  resultsRoot?: string;
  nonce?: string;
  evidenceHash?: string;
  workloadHash?: string;
  checks: AuditCheck[];
}
