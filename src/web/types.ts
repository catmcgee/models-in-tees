export type {
  AuditCheck,
  ChainReadback,
  DisclosedLeaf,
  ExperimentDetail,
  ExperimentKind,
  ExperimentSummary,
  PublicExperimentRecord,
  RecordVerification,
  SignedExperimentReceipt,
  SolanaCommitment,
  TeeEvidenceSummary
} from "../shared/receiptTypes.js";

export interface HealthStatus {
  ok: boolean;
  service: string;
  teeMode: string;
  teeProvider: string;
  network: string;
  runner: {
    state: "stopped" | "starting" | "ready" | "restarting" | "failed";
    restarts: number;
    startedAt: string | null;
    loadMs: number | null;
    lastError: string | null;
  };
  model: { commitment: string; modelId: string } | null;
  registry: { ok: boolean; hash: string | null; experimentCount: number };
  busy: { experimentId: string; runId: string; startedAt: string } | null;
}

export interface SolanaStatus {
  network: "devnet";
  rpcUrl: string;
  programId: string;
  payer: string;
  balanceSol: number;
  blockhash: string;
}

export interface RunnerKey {
  publicKeyPem: string;
  publicKeyFingerprint: string;
  trustedFingerprints?: string[];
}

export interface ServerAudit {
  ok: boolean;
  receiptDigest?: string;
  resultsRoot?: string;
  nonce?: string;
  evidenceHash?: string;
  workloadHash?: string;
  checks: Array<{ name: string; status: "pass" | "fail" | "skip"; detail?: string }>;
}
