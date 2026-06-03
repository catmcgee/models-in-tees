export type BenchmarkLabel = "APPROVE" | "REVIEW" | "BLOCK" | "INSUFFICIENT";

export interface BenchmarkCase {
  id?: string;
  prompt: string;
  expected?: BenchmarkLabel | string | null;
}

export interface ModelInfo {
  architecture: Record<string, unknown>;
  commitment: string;
  labels: BenchmarkLabel[];
  weights_path: string;
  weights_public: boolean;
  meta: Record<string, unknown>;
}

export interface ModelPrediction {
  id: string;
  promptHash: string;
  prediction: BenchmarkLabel;
  expected: BenchmarkLabel | null;
  correct: boolean | null;
  confidence: number;
  scores: Record<BenchmarkLabel, number>;
  latencyMs: number;
  output: string;
}

export interface BenchmarkMetrics {
  caseCount: number;
  labeledCaseCount: number;
  accuracy: number | null;
  avgConfidence: number;
  totalLatencyMs: number;
  byLabel: Record<
    BenchmarkLabel,
    {
      predicted: number;
      expected: number;
      correct: number;
    }
  >;
}

export interface ModelRunResult {
  ok: true;
  model: ModelInfo;
  predictions: ModelPrediction[];
  metrics: BenchmarkMetrics;
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
    magicBlockErRpcUrl: string;
    teeMode: string;
    teeProvider: string;
    node: string;
    platform: string;
    arch: string;
  };
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

export interface ReceiptPayload {
  schema: "private-benchmark-receipt/v1";
  benchmarkId: string;
  issuedAt: string;
  inputSetHash: string;
  outputSetHash: string;
  metricsHash: string;
  model: {
    commitment: string;
    architecture: Record<string, unknown>;
    weightsPublic: false;
  };
  metrics: BenchmarkMetrics;
  runner: {
    teeMode: string;
    teeProvider: string;
    publicKeyPem: string;
    publicKeyFingerprint: string;
    teeEvidenceHash?: string;
    teeEvidence?: TeeEvidenceSummary;
  };
  solana?: SolanaCommitment | null;
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  signature: string;
  digest: string;
  algorithm: "Ed25519";
}

export interface BenchmarkRecord {
  id: string;
  cases: BenchmarkCase[];
  run: ModelRunResult;
  receipt: SignedReceipt;
  teeEvidence?: TeeEvidence | null;
  solanaCommitment?: SolanaCommitment | null;
  magicBlockFlow?: MagicBlockFlow | null;
  createdAt: string;
}

export interface AuditCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export interface ReceiptAudit {
  ok: boolean;
  receiptDigest?: string;
  evidenceHash?: string;
  workloadHash?: string;
  checks: AuditCheck[];
}

export interface SolanaCommitment {
  status: "confirmed" | "dry-run" | "failed";
  network: "devnet";
  rpcUrl: string;
  payer: string;
  kind?: "anchor-program" | "memo";
  programId?: string;
  sessionPda?: string;
  signature?: string;
  explorerUrl?: string;
  memo: string;
  memoHash: string;
  error?: string;
}

export interface MagicBlockFlow {
  ok: boolean;
  network: "devnet";
  erRpcUrl: string;
  programId: string;
  payer: string;
  sessionPda: string;
  createSignature?: string;
  delegateSignature?: string;
  finalizeSignature?: string;
  commitErSignature?: string;
  baseCommitSignature?: string;
  ownerBefore?: string | null;
  ownerAfterDelegate?: string | null;
  delegatedOnBase?: boolean;
  error?: string;
}
