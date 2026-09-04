import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicKeyFingerprint } from "../shared/ed25519.js";
import { NONCE_SCHEME } from "../shared/nonce.js";
import { EXPERIMENT_RECEIPT_SCHEMA } from "../shared/receiptTypes.js";
import { base64url, canonicalJson, sha256HexSync } from "./canonical.js";
import { attestationDir, config } from "./config.js";
import { summarizeTeeEvidence } from "./teeEvidence.js";
import type {
  ExperimentReceiptPayload,
  RunExperimentResult,
  SignedExperimentReceipt,
  TeeEvidence
} from "./types.js";

const privateKeyPath = path.join(attestationDir, "tee-ed25519-private.pem");
const publicKeyPath = path.join(attestationDir, "tee-ed25519-public.pem");

export class CanonicalMismatchError extends Error {}

export async function getRunnerKey(): Promise<{ publicKeyPem: string; publicKeyFingerprint: string }> {
  const keypair = loadOrCreateAttestationKeys();
  return {
    publicKeyPem: keypair.publicKeyPem,
    publicKeyFingerprint: await publicKeyFingerprint(keypair.publicKeyPem)
  };
}

/**
 * Cross-language guard: the runner's hashes must equal what the TypeScript
 * canonical serialiser produces, or the receipt is not issued.
 */
export function assertRunnerHashes(result: RunExperimentResult): void {
  const policyHash = sha256HexSync(canonicalJson(result.policy));
  if (policyHash !== result.policyHash) {
    throw new CanonicalMismatchError(
      `policyHash mismatch: runner=${result.policyHash} node=${policyHash}`
    );
  }
  const metricsHash = sha256HexSync(canonicalJson(result.results.metrics));
  if (metricsHash !== result.results.metricsHash) {
    throw new CanonicalMismatchError(
      `metricsHash mismatch: runner=${result.results.metricsHash} node=${metricsHash}`
    );
  }
}

export async function createSignedExperimentReceipt(input: {
  runId: string;
  result: RunExperimentResult;
  teeEvidence: TeeEvidence;
  nonce: string;
  latencyMs: number;
}): Promise<SignedExperimentReceipt> {
  const { runId, result, teeEvidence, nonce } = input;
  const keypair = loadOrCreateAttestationKeys();
  const fingerprint = await publicKeyFingerprint(keypair.publicKeyPem);
  assertRunnerHashes(result);
  if (teeEvidence.nonce !== nonce) {
    throw new Error("TEE evidence nonce does not match the derived attestation nonce.");
  }

  const payload: ExperimentReceiptPayload = {
    schema: EXPERIMENT_RECEIPT_SCHEMA,
    runId,
    issuedAt: new Date().toISOString(),
    experiment: {
      id: result.experiment.id,
      kind: result.experiment.kind,
      title: result.experiment.title,
      params: result.experiment.params,
      itemCount: result.experiment.itemCount,
      datasetHash: result.experiment.datasetHash,
      experimentHash: result.experiment.experimentHash,
      registryHash: result.experiment.registryHash
    },
    policy: result.policy,
    policyHash: result.policyHash,
    model: {
      commitment: result.model.commitment,
      modelId: result.model.modelId,
      architecture: result.model.architecture,
      weightsPublic: false
    },
    sae: result.sae,
    results: {
      resultsRoot: result.results.resultsRoot,
      leafCount: result.results.leafCount,
      leafSchema: result.results.leafSchema,
      merkleScheme: result.results.merkleScheme,
      metrics: result.results.metrics,
      metricsHash: result.results.metricsHash
    },
    disclosure: {
      scheme: result.disclosure.scheme,
      seed: result.disclosure.seed,
      count: result.disclosure.count,
      indices: result.disclosure.indices,
      leaves: result.disclosure.leaves
    },
    attestation: {
      nonceScheme: NONCE_SCHEME,
      nonce,
      teeEvidenceHash: teeEvidence.evidenceHash,
      workloadHash: teeEvidence.workload?.workloadHash ?? null,
      teeEvidence: summarizeTeeEvidence(teeEvidence)
    },
    runner: {
      teeMode: config.teeMode,
      teeProvider: config.teeProvider,
      publicKeyPem: keypair.publicKeyPem,
      publicKeyFingerprint: fingerprint,
      runtime: result.model.runtime,
      latencyMs: Math.round(input.latencyMs)
    }
  };
  return signReceiptPayload(payload, keypair.privateKeyPem);
}

export function signReceiptPayload(
  payload: ExperimentReceiptPayload,
  privateKeyPem: string
): SignedExperimentReceipt {
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical, "utf-8"), privateKeyPem);
  return {
    payload,
    signature: base64url(signature),
    digest: sha256HexSync(canonical),
    algorithm: "Ed25519"
  };
}

export function loadOrCreateAttestationKeys(): {
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
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }) as string;
  fs.writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o644 });
  createPrivateKey(privateKeyPem);
  createPublicKey(publicKeyPem);
  return { privateKeyPem, publicKeyPem };
}
