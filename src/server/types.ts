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

export interface LensToken {
  rank: number;
  token: string;
  tokenId: number;
  probability: number;
}

export interface LensLayer {
  layer: number;
  label: string;
  topTokens: LensToken[];
  target: {
    rank: number;
    probability: number;
    logit: number;
  };
}

export interface AttentionHeadSummary {
  head: number;
  focusPosition: number;
  focusToken: string;
  maxAttention: number;
  entropy: number;
}

export interface AttentionLayerSummary {
  layer: number;
  meanEntropy: number;
  focusedHeads: AttentionHeadSummary[];
}

export interface PatchLayerScore {
  layer: number;
  targetLogProb: number;
  recovery: number;
  clippedRecovery: number;
}

export interface InterpretabilityResult {
  ok: true;
  model: ModelInfo;
  promptHash: string;
  corruptedPromptHash?: string | null;
  target: {
    token: string;
    tokenId: number;
    source: "user" | "clean-final-argmax";
    cleanLogProb: number;
  };
  lens: {
    topK: number;
    position: number;
    layers: LensLayer[];
  };
  attention: {
    available: boolean;
    position?: number;
    tokenCount?: number;
    layers: AttentionLayerSummary[];
  };
  patching?: {
    available: boolean;
    cleanLogProb: number;
    corruptedLogProb: number;
    layers: PatchLayerScore[];
  } | null;
  params: {
    topK: number;
    maxPromptTokens: number;
    rawActivationsReturned: false;
    rawAttentionReturned: false;
    weightsReturned: false;
  };
  redaction: {
    exposes: string[];
    withholds: string[];
  };
  latencyMs: number;
  resultHash: string;
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

export interface InterpretabilityReceiptPayload {
  schema: "private-gpt2-interpretability-receipt/v1";
  runId: string;
  issuedAt: string;
  promptHash: string;
  corruptedPromptHash?: string | null;
  targetToken: {
    token: string;
    tokenId: number;
    source: "user" | "clean-final-argmax";
  };
  resultHash: string;
  model: {
    commitment: string;
    architecture: Record<string, unknown>;
    weightsPublic: false;
  };
  experiment: {
    kind: "logit-lens-and-activation-patching";
    params: InterpretabilityResult["params"];
    redaction: InterpretabilityResult["redaction"];
  };
  runner: ReceiptPayload["runner"];
}

export type SuiteExperiment = "audit-suite" | "probe" | "patch-suite" | "sae-features";

export interface SuiteResult {
  ok: true;
  available?: boolean;
  hint?: string;
  model: ModelInfo;
  suite: {
    kind: string;
    name: string;
    itemCount: number;
    datasetHash: string;
  };
  metrics: Record<string, unknown>;
  policy: Record<string, unknown>;
  params: Record<string, unknown>;
  latencyMs: number;
  resultHash: string;
}

export interface SuiteReceiptPayload {
  schema: "private-gpt2-suite-receipt/v1";
  runId: string;
  issuedAt: string;
  experiment: SuiteExperiment;
  suite: SuiteResult["suite"];
  resultHash: string;
  policyHash: string;
  model: {
    commitment: string;
    architecture: Record<string, unknown>;
    weightsPublic: false;
  };
  runner: ReceiptPayload["runner"];
}

export type SignedPayloadPayload =
  | ReceiptPayload
  | InterpretabilityReceiptPayload
  | SuiteReceiptPayload;

export interface SignedPayload<TPayload extends SignedPayloadPayload = SignedPayloadPayload> {
  payload: TPayload;
  signature: string;
  digest: string;
  algorithm: "Ed25519";
}

export type SignedReceipt = SignedPayload<ReceiptPayload>;
export type SignedInterpretabilityReceipt = SignedPayload<InterpretabilityReceiptPayload>;
export type SignedSuiteReceipt = SignedPayload<SuiteReceiptPayload>;

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

export interface InterpretabilityRecord {
  kind: "interpretability";
  id: string;
  prompt: string;
  corruptedPrompt?: string;
  targetToken?: string;
  result: InterpretabilityResult;
  receipt: SignedInterpretabilityReceipt;
  teeEvidence?: TeeEvidence | null;
  solanaCommitment?: SolanaCommitment | null;
  createdAt: string;
}

export interface SuiteRecord {
  kind: "suite";
  id: string;
  experiment: SuiteExperiment;
  result: SuiteResult;
  receipt: SignedSuiteReceipt;
  teeEvidence?: TeeEvidence | null;
  solanaCommitment?: SolanaCommitment | null;
  createdAt: string;
}

export type StoredRecord = GenerationRecord | InterpretabilityRecord | SuiteRecord;

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
