import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootDir =
  process.env.TEE_AI_ROOT || path.resolve(__dirname, "..", "..");
export const privateDir = path.join(rootDir, "private");
export const modelDir = path.join(privateDir, "model");
export const attestationDir = path.join(privateDir, "attestation");
export const solanaDir = path.join(privateDir, "solana");

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  apiPort: Number(process.env.PORT || process.env.API_PORT || 8787),
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  magicBlockErRpcUrl:
    process.env.MAGICBLOCK_ER_RPC_URL || "https://devnet.magicblock.app/",
  magicBlockStatusUrl:
    process.env.MAGICBLOCK_STATUS_URL ||
    "https://status.magicblock.app/api/services",
  privateBenchmarkProgramId:
    process.env.PRIVATE_BENCHMARK_PROGRAM_ID ||
    "Bvvhk5LPD9STKEpK2hFEfdTumf5qGTSJfFyn5W97XiuR",
  teeMode: process.env.TEE_MODE || "local-dev-sim",
  teeProvider: process.env.TEE_PROVIDER || "simulated-attestation",
  teeAttestationAudience:
    process.env.TEE_ATTESTATION_AUDIENCE || "tee-ai-private-benchmark",
  gotpmPath: process.env.GOTPM_PATH || "/usr/local/bin/gotpm",
  gotpmUseSudo: process.env.GOTPM_USE_SUDO === "1",
  allowModelBootstrap:
    process.env.ALLOW_MODEL_BOOTSTRAP === "1" || process.env.NODE_ENV !== "production",
  allowRawTeeEvidence:
    process.env.ALLOW_RAW_TEE_EVIDENCE === "1" || process.env.NODE_ENV !== "production",
  allowPublicReceiptListing:
    process.env.ALLOW_PUBLIC_RECEIPT_LISTING === "1" ||
    process.env.NODE_ENV !== "production",
  disableSolanaCommit: process.env.DISABLE_SOLANA_COMMIT === "1"
};
