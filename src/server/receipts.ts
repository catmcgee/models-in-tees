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
  BenchmarkCase,
  ModelRunResult,
  ReceiptPayload,
  SignedReceipt,
  TeeEvidence
} from "./types.js";

const privateKeyPath = path.join(attestationDir, "tee-ed25519-private.pem");
const publicKeyPath = path.join(attestationDir, "tee-ed25519-public.pem");

export function createSignedReceipt(
  benchmarkId: string,
  cases: BenchmarkCase[],
  run: ModelRunResult,
  teeEvidence?: TeeEvidence
): SignedReceipt {
  const keypair = loadOrCreateAttestationKeys();
  const publicKeyFingerprint = sha256Hex(keypair.publicKeyPem).slice(0, 32);
  const inputSetHash = sha256Hex(
    cases.map((item) => ({
      id: item.id || null,
      promptHash: sha256Hex(item.prompt),
      expected: item.expected || null
    }))
  );
  const outputSetHash = sha256Hex(
    run.predictions.map((item) => ({
      id: item.id,
      promptHash: item.promptHash,
      prediction: item.prediction,
      expected: item.expected,
      correct: item.correct,
      confidence: item.confidence,
      outputHash: sha256Hex(item.output)
    }))
  );
  const metricsHash = sha256Hex(run.metrics);
  const payload: ReceiptPayload = {
    schema: "private-benchmark-receipt/v1",
    benchmarkId,
    issuedAt: new Date().toISOString(),
    inputSetHash,
    outputSetHash,
    metricsHash,
    model: {
      commitment: run.model.commitment,
      architecture: run.model.architecture,
      weightsPublic: false
    },
    metrics: run.metrics,
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
