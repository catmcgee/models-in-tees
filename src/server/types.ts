export interface ModelInfo {
  architecture: Record<string, unknown>;
  commitment: string;
  weights_path: string;
  weights_public: boolean;
  meta: Record<string, unknown>;
}

export interface GenerationResult {
  ok: true;
  model: ModelInfo;
  promptHash: string;
  output: string;
  outputHash: string;
  latencyMs: number;
  tokenCount: {
    prompt: number;
    generated: number;
  };
  params: {
    maxNewTokens: number;
    temperature: number;
    topP: number;
  };
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
  schema: "private-gpt2-receipt/v1";
  runId: string;
  issuedAt: string;
  promptHash: string;
  outputHash: string;
  paramsHash: string;
  model: {
    commitment: string;
    architecture: Record<string, unknown>;
    weightsPublic: false;
  };
  generation: {
    latencyMs: number;
    tokenCount: {
      prompt: number;
      generated: number;
    };
    params: GenerationResult["params"];
  };
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

export interface GenerationRecord {
  kind: "generation";
  id: string;
  prompt: string;
  generation: GenerationResult;
  receipt: SignedReceipt;
  teeEvidence?: TeeEvidence | null;
  solanaCommitment?: SolanaCommitment | null;
  createdAt: string;
}

export type StoredRecord = GenerationRecord;

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
