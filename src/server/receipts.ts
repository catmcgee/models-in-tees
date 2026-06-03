import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { attestationDir, config } from "./config.js";
import { base64url, canonicalJson, fromBase64url, sha256Hex } from "./canonical.js";
import { summarizeTeeEvidence } from "./teeEvidence.js";
import type {
  GenerationResult,
  ReceiptPayload,
  SignedReceipt,
  TeeEvidence
} from "./types.js";

const privateKeyPath = path.join(attestationDir, "tee-ed25519-private.pem");
const publicKeyPath = path.join(attestationDir, "tee-ed25519-public.pem");

export function createSignedGenerationReceipt(
  runId: string,
  generation: GenerationResult,
  teeEvidence?: TeeEvidence
): SignedReceipt {
  const keypair = loadOrCreateAttestationKeys();
  const publicKeyFingerprint = sha256Hex(keypair.publicKeyPem).slice(0, 32);
  const payload: ReceiptPayload = {
    schema: "private-gpt2-receipt/v1",
    runId,
    issuedAt: new Date().toISOString(),
    promptHash: generation.promptHash,
    outputHash: generation.outputHash,
    paramsHash: sha256Hex(generation.params),
    model: {
      commitment: generation.model.commitment,
      architecture: generation.model.architecture,
      weightsPublic: false
    },
    generation: {
      latencyMs: generation.latencyMs,
      tokenCount: generation.tokenCount,
      params: generation.params
    },
    runner: {
      teeMode: config.teeMode,
      teeProvider: config.teeProvider,
      publicKeyPem: keypair.publicKeyPem,
      publicKeyFingerprint,
      ...(teeEvidence
        ? {
            teeEvidenceHash: teeEvidence.evidenceHash,
            teeEvidence: summarizeTeeEvidence(teeEvidence)
          }
        : {})
    },
    solana: null
  };
  return signReceiptPayload(payload, keypair.privateKeyPem);
}

export function signReceiptPayload(
  payload: ReceiptPayload,
  privateKeyPem?: string
): SignedReceipt {
  const keypair = privateKeyPem
    ? { privateKeyPem, publicKeyPem: payload.runner.publicKeyPem }
    : loadOrCreateAttestationKeys();
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical), keypair.privateKeyPem);
  return {
    payload,
    signature: base64url(signature),
    digest: sha256Hex(canonical),
    algorithm: "Ed25519"
  };
}

export function verifySignedReceipt(receipt: SignedReceipt): {
  ok: boolean;
  digest: string;
  reason?: string;
} {
  try {
    const canonical = canonicalJson(receipt.payload);
    const digest = sha256Hex(canonical);
    if (digest !== receipt.digest) {
      return { ok: false, digest, reason: "Receipt digest does not match payload." };
    }
    const verified = verify(
      null,
      Buffer.from(canonical),
      receipt.payload.runner.publicKeyPem,
      fromBase64url(receipt.signature)
    );
    return verified
      ? { ok: true, digest }
      : { ok: false, digest, reason: "Signature verification failed." };
  } catch (error) {
    return { ok: false, digest: "", reason: String(error) };
  }
}

function loadOrCreateAttestationKeys(): {
  privateKeyPem: string;
  publicKeyPem: string;
} {
  fs.mkdirSync(attestationDir, { recursive: true });
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    return {
      privateKeyPem: fs.readFileSync(privateKeyPath, "utf-8"),
      publicKeyPem: fs.readFileSync(publicKeyPath, "utf-8")
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({
    format: "pem",
    type: "pkcs8"
  }) as string;
  const publicKeyPem = publicKey.export({
    format: "pem",
    type: "spki"
  }) as string;
  fs.writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o644 });

  // Validate the persisted material before returning it.
  createPrivateKey(privateKeyPem);
  createPublicKey(publicKeyPem);
  return { privateKeyPem, publicKeyPem };
}
