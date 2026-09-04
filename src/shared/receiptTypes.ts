/** Public wire types shared by the API server and the browser. */

export type ExperimentKind =
  | "expected-token"
  | "memorization"
  | "paired-bias"
  | "linear-probe"
  | "activation-patching"
  | "sae-features";

export const EXPERIMENT_RECEIPT_SCHEMA = "tee-ai-experiment-receipt/v1";

export interface ExperimentSummary {
  id: string;
  kind: ExperimentKind;
  title: string;
  description: string;
  itemCount: number;
  datasetHash: string;
  experimentHash: string;
  registryHash: string;
  params: Record<string, unknown>;
}

export interface ExperimentDetail extends ExperimentSummary {
  items: Array<Record<string, unknown>>;
}

export interface MerkleProofStep {
  hash: string;
  side: "left" | "right";
}

export interface DisclosedLeaf {
  index: number;
  leaf: Record<string, unknown>;
  leafHash: string;
  proof: MerkleProofStep[];
}

export interface ModelDescriptor {
  commitment: string;
  modelId: string;
  architecture: Record<string, unknown>;
  weightsPublic: false;
}

export interface SaeDescriptor {
  repoId: string;
  subfolder: string;
  commitment: string;
  architecture: string;
  layer: number;
  hiddenStateIndex: number;
  width: number;
  dIn: number;
  l0: number;
  license: string;
}

export interface TeeEvidenceSummary {
  schema: "tee-evidence/v1";
  evidenceHash: string;
  workloadHash?: string;
  source: string;
  collectedAt: string;
  nonce: string;
  attestationStatus: string;
  tokenHash?: string;
  reportHash?: string;
  subject?: string;
  issuer?: string;
  hardwareModel?: string;
  secureBoot?: boolean;
  projectId?: string;
  zone?: string;
  instanceName?: string;
  instanceId?: string;
  errors?: string[];
}

export interface ExperimentReceiptPayload {
  schema: typeof EXPERIMENT_RECEIPT_SCHEMA;
  runId: string;
  issuedAt: string;
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
  policy: Record<string, unknown>;
  policyHash: string;
  model: ModelDescriptor;
  sae: SaeDescriptor | null;
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
    leaves: DisclosedLeaf[];
  };
  attestation: {
    nonceScheme: string;
    nonce: string;
    teeEvidenceHash: string;
    workloadHash: string | null;
    teeEvidence: TeeEvidenceSummary;
  };
  runner: {
    teeMode: string;
    teeProvider: string;
    publicKeyPem: string;
    publicKeyFingerprint: string;
    runtime: Record<string, unknown>;
    latencyMs: number;
  };
}

export interface SignedExperimentReceipt {
  payload: ExperimentReceiptPayload;
  signature: string;
  digest: string;
  algorithm: "Ed25519";
}

export interface SolanaCommitment {
  status: "confirmed" | "dry-run" | "failed";
  network: "devnet";
  rpcUrl: string;
  payer: string;
  kind?: "anchor-program" | "memo";
  programId?: string;
  commitmentPda?: string;
  signature?: string;
  explorerUrl?: string;
  memo: string;
  memoHash: string;
  error?: string;
  anchorError?: string;
}

export interface PublicExperimentRecord {
  kind: "experiment";
  id: string;
  experimentId: string;
  createdAt: string;
  receipt: SignedExperimentReceipt;
  descriptive: Record<string, unknown>;
  timing: { totalMs: number; forwardPasses: number };
  solanaCommitment: SolanaCommitment | null;
}

export interface AuditCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export interface RecordVerification {
  ok: boolean;
  digest: string;
  resultsRoot?: string;
  nonce?: string;
  checks: AuditCheck[];
}

export interface ChainReadback {
  programId: string;
  pda: string;
  exists: boolean;
  explorerUrl?: string;
  account?: {
    authority: string;
    receiptDigest: string;
    modelCommitment: string;
    experimentIdHash: string;
    datasetHash: string;
    resultsRoot: string;
    policyHash: string;
    teeEvidenceHash: string;
    leafCount: number;
    committedAt: number;
    bump: number;
  };
  checks: AuditCheck[];
}
