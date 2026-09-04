import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootDir =
  process.env.TEE_AI_ROOT || path.resolve(__dirname, "..", "..");
export const privateDir = path.join(rootDir, "private");
export const llmDir = path.join(privateDir, "llm");
export const hfDir = path.join(privateDir, "hf");
export const saeDir = path.join(privateDir, "sae");
export const attestationDir = path.join(privateDir, "attestation");
export const solanaDir = path.join(privateDir, "solana");
export const recordsDir = path.join(privateDir, "records");
export const registryDir = path.join(rootDir, "src", "experiments");

function list(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  serviceName: "tee-ai-experiments",
  nodeEnv: process.env.NODE_ENV || "development",
  apiPort: Number(process.env.PORT || process.env.API_PORT || 8787),
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  experimentProgramId:
    process.env.EXPERIMENT_RECEIPTS_PROGRAM_ID ||
    "Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR",
  llmModelId: process.env.TEE_AI_LLM_MODEL_ID || "google/gemma-3-1b-pt",
  saeRepo: process.env.TEE_AI_SAE_REPO || "google/gemma-scope-2-1b-pt",
  saeSubfolder:
    process.env.TEE_AI_SAE_SUBFOLDER || "resid_post/layer_13_width_16k_l0_medium",
  hfToken: process.env.HF_TOKEN || "",
  hfOffline: process.env.HF_HUB_OFFLINE !== "0",
  teeMode: process.env.TEE_MODE || "local-dev-sim",
  teeProvider: process.env.TEE_PROVIDER || "simulated-attestation",
  teeAttestationAudience:
    process.env.TEE_ATTESTATION_AUDIENCE || "tee-ai-experiments",
  gotpmPath: process.env.GOTPM_PATH || "/usr/local/bin/gotpm",
  gotpmUseSudo: process.env.GOTPM_USE_SUDO === "1",
  allowRawTeeEvidence:
    process.env.ALLOW_RAW_TEE_EVIDENCE === "1" || process.env.NODE_ENV !== "production",
  disableSolanaCommit: process.env.DISABLE_SOLANA_COMMIT === "1",
  trustedRunnerFingerprints: list(process.env.TRUSTED_RUNNER_PUBKEY_FINGERPRINT),
  runTimeoutMs: Number(process.env.TEE_AI_RUN_TIMEOUT_MS || 20 * 60 * 1000),
  runnerReadyTimeoutMs: Number(process.env.TEE_AI_RUNNER_READY_TIMEOUT_MS || 30 * 60 * 1000),
  torchThreads: process.env.TEE_AI_TORCH_THREADS || ""
};
