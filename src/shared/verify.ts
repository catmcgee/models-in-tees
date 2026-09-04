/**
 * Third-party verification of an experiment record. Runs identically in the
 * API server and in the browser; needs only the record (plus, optionally, the
 * registry items and a pinned runner key).
 */

import { canonicalHash, canonicalJson, sha256Hex, utf8 } from "./canonical.js";
import { deriveDisclosureIndices, deriveDisclosureSeed } from "./disclosure.js";
import { decodeSignature, publicKeyFingerprint, verifyEd25519 } from "./ed25519.js";
import { hashLeaf, verifyMerkleProof } from "./merkle.js";
import { deriveAttestationNonce } from "./nonce.js";
import type {
  AuditCheck,
  PublicExperimentRecord,
  RecordVerification,
  SignedExperimentReceipt
} from "./receiptTypes.js";
import { EXPERIMENT_RECEIPT_SCHEMA } from "./receiptTypes.js";

export interface VerifyOptions {
  /** Registry items for this experiment; enables the dataset-hash check. */
  items?: Array<Record<string, unknown>>;
  /** Known runner key fingerprints; enables the pinned-key check. */
  trustedFingerprints?: string[];
}

function add(checks: AuditCheck[], name: string, passed: boolean, detail?: string): boolean {
  checks.push({ name, status: passed ? "pass" : "fail", detail });
  return passed;
}

function skip(checks: AuditCheck[], name: string, detail: string): void {
  checks.push({ name, status: "skip", detail });
}

export async function verifySignedReceipt(
  receipt: SignedExperimentReceipt
): Promise<{ ok: boolean; digest: string; reason?: string }> {
  try {
    const canonical = canonicalJson(receipt.payload);
    const digest = await sha256Hex(utf8(canonical));
    if (digest !== receipt.digest) {
      return { ok: false, digest, reason: "Receipt digest does not match payload." };
    }
    const verified = await verifyEd25519(
      receipt.payload.runner.publicKeyPem,
      utf8(canonical),
      decodeSignature(receipt.signature)
    );
    return verified ? { ok: true, digest } : { ok: false, digest, reason: "Signature verification failed." };
  } catch (error) {
    return { ok: false, digest: "", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyExperimentRecord(
  record: Pick<PublicExperimentRecord, "receipt">,
  options: VerifyOptions = {}
): Promise<RecordVerification> {
  const checks: AuditCheck[] = [];
  const receipt = record.receipt;
  const payload = receipt?.payload;
  if (!payload || typeof payload !== "object") {
    add(checks, "receipt-present", false, "record has no receipt payload");
    return { ok: false, digest: "", checks };
  }

  add(
    checks,
    "receipt-schema",
    payload.schema === EXPERIMENT_RECEIPT_SCHEMA && receipt.algorithm === "Ed25519",
    `${payload.schema} / ${receipt.algorithm}`
  );

  let digest = "";
  try {
    const canonical = canonicalJson(payload);
    digest = await sha256Hex(utf8(canonical));
    add(checks, "receipt-digest", digest === receipt.digest, digest);
    const signed = await verifyEd25519(
      payload.runner.publicKeyPem,
      utf8(canonical),
      decodeSignature(receipt.signature)
    );
    add(checks, "receipt-signature", signed, signed ? "Ed25519 signature verifies" : "signature does not verify");
  } catch (error) {
    add(checks, "receipt-digest", false, error instanceof Error ? error.message : String(error));
    add(checks, "receipt-signature", false, "could not canonicalise payload");
  }

  try {
    const fingerprint = await publicKeyFingerprint(payload.runner.publicKeyPem);
    add(
      checks,
      "runner-key-fingerprint",
      fingerprint === payload.runner.publicKeyFingerprint,
      fingerprint
    );
    if (options.trustedFingerprints && options.trustedFingerprints.length > 0) {
      add(
        checks,
        "runner-key-pinned",
        options.trustedFingerprints.includes(fingerprint),
        options.trustedFingerprints.includes(fingerprint)
          ? "signed by a known runner key"
          : "signed by an unknown key"
      );
    } else {
      skip(checks, "runner-key-pinned", "no trusted runner key supplied");
    }
  } catch (error) {
    add(checks, "runner-key-fingerprint", false, error instanceof Error ? error.message : String(error));
  }

  const policyHash = await safeHash(payload.policy);
  add(checks, "policy-hash", policyHash === payload.policyHash, policyHash ?? "unhashable");
  const metricsHash = await safeHash(payload.results?.metrics);
  add(checks, "metrics-hash", metricsHash === payload.results?.metricsHash, metricsHash ?? "unhashable");
  add(
    checks,
    "metrics-present",
    !!payload.results?.metrics && Object.keys(payload.results.metrics).length > 0
  );

  if (options.items) {
    const datasetHash = await safeHash(options.items);
    add(checks, "dataset-hash", datasetHash === payload.experiment.datasetHash, datasetHash ?? "unhashable");
  } else {
    skip(checks, "dataset-hash", "registry items not supplied");
  }

  add(
    checks,
    "leaf-count-matches-items",
    payload.results?.leafCount === payload.experiment?.itemCount,
    `${payload.results?.leafCount} leaves / ${payload.experiment?.itemCount} items`
  );

  // Attestation nonce binds the exact results into the TEE token.
  try {
    const nonce = await deriveAttestationNonce({
      resultsRoot: payload.results.resultsRoot,
      datasetHash: payload.experiment.datasetHash,
      registryHash: payload.experiment.registryHash,
      modelCommitment: payload.model.commitment,
      policyHash: payload.policyHash,
      publicKeyFingerprint: payload.runner.publicKeyFingerprint
    });
    add(checks, "attestation-nonce", nonce === payload.attestation.nonce, nonce);
    add(
      checks,
      "evidence-summary-nonce",
      payload.attestation.teeEvidence?.nonce === payload.attestation.nonce,
      payload.attestation.teeEvidence?.nonce
    );
    add(
      checks,
      "evidence-summary-hash",
      payload.attestation.teeEvidence?.evidenceHash === payload.attestation.teeEvidenceHash,
      payload.attestation.teeEvidenceHash
    );
  } catch (error) {
    add(checks, "attestation-nonce", false, error instanceof Error ? error.message : String(error));
  }

  // Disclosure: seed and indices are forced by committed material.
  try {
    const seed = await deriveDisclosureSeed(
      payload.results.resultsRoot,
      payload.experiment.datasetHash,
      payload.model.commitment
    );
    add(checks, "disclosure-seed", seed === payload.disclosure.seed, seed);
    const indices = await deriveDisclosureIndices(
      seed,
      payload.results.leafCount,
      payload.disclosure.count
    );
    const sameIndices =
      indices.length === payload.disclosure.indices.length &&
      indices.every((value, i) => value === payload.disclosure.indices[i]);
    add(checks, "disclosure-indices", sameIndices, indices.join(","));
    const leafIndices = payload.disclosure.leaves.map((leaf) => leaf.index);
    const sameSet =
      leafIndices.length === payload.disclosure.indices.length &&
      leafIndices.every((value, i) => value === payload.disclosure.indices[i]);
    add(checks, "disclosed-set-matches-indices", sameSet, leafIndices.join(","));
  } catch (error) {
    add(checks, "disclosure-seed", false, error instanceof Error ? error.message : String(error));
  }

  for (const disclosed of payload.disclosure?.leaves ?? []) {
    try {
      const leafHash = await hashLeaf(disclosed.leaf);
      add(checks, `disclosed-leaf-hash[${disclosed.index}]`, leafHash === disclosed.leafHash, leafHash);
      const proof = await verifyMerkleProof({
        leafHash: disclosed.leafHash,
        proof: disclosed.proof,
        root: payload.results.resultsRoot
      });
      add(checks, `disclosed-proof[${disclosed.index}]`, proof.ok, proof.computedRoot);
    } catch (error) {
      add(checks, `disclosed-proof[${disclosed.index}]`, false, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    digest,
    resultsRoot: payload.results?.resultsRoot,
    nonce: payload.attestation?.nonce,
    checks
  };
}

async function safeHash(value: unknown): Promise<string | undefined> {
  try {
    return await canonicalHash(value);
  } catch {
    return undefined;
  }
}
