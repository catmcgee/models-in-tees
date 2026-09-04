import { createPublicKey, verify as verifyCrypto } from "node:crypto";
import type { JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import { verifyExperimentRecord } from "../shared/verify.js";
import { readExperimentCommitment } from "./anchorCommit.js";
import { config } from "./config.js";
import { fromBase64url, sha256HexSync } from "./canonical.js";
import { getWorkloadMeasurement } from "./workload.js";
import type {
  AuditCheck,
  ReceiptAudit,
  SignedExperimentReceipt,
  SolanaCommitment,
  TeeEvidence
} from "./types.js";

const googleJwksUrl =
  "https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com";
let jwksCache: { fetchedAt: number; keys: JsonWebKeyWithKid[] } | undefined;

interface JsonWebKeyWithKid {
  [key: string]: unknown;
  kid?: string;
}

export interface AuditOptions {
  /** Registry items so the dataset hash can be recomputed. */
  items?: Array<Record<string, unknown>>;
  /** Existing chain commitment; when confirmed, the PDA is read back. */
  solanaCommitment?: SolanaCommitment | null;
  /** Skip network calls (JWKS, RPC). */
  offline?: boolean;
}

export async function auditReceiptEvidence(
  receipt: SignedExperimentReceipt,
  evidence?: TeeEvidence | null,
  options: AuditOptions = {}
): Promise<ReceiptAudit> {
  const verification = await verifyExperimentRecord(
    { receipt },
    { items: options.items, trustedFingerprints: config.trustedRunnerFingerprints }
  );
  const checks: AuditCheck[] = [...verification.checks];

  if (!evidence) {
    addCheck(checks, "tee-evidence-present", false, "No full TEE evidence was stored.");
    return buildAudit(receipt, evidence, checks);
  }
  addCheck(checks, "tee-evidence-present", true, evidence.evidenceHash);

  addCheck(
    checks,
    "receipt-binds-evidence",
    receipt.payload.attestation.teeEvidenceHash === evidence.evidenceHash,
    `receipt=${receipt.payload.attestation.teeEvidenceHash} evidence=${evidence.evidenceHash}`
  );
  const recomputedEvidenceHash = recomputeEvidenceHash(evidence);
  addCheck(checks, "evidence-hash", recomputedEvidenceHash === evidence.evidenceHash, recomputedEvidenceHash);
  addCheck(
    checks,
    "evidence-nonce-match",
    evidence.nonce === receipt.payload.attestation.nonce,
    evidence.nonce
  );

  if (receipt.payload.attestation.workloadHash && evidence.workload) {
    addCheck(
      checks,
      "receipt-binds-workload",
      receipt.payload.attestation.workloadHash === evidence.workload.workloadHash,
      evidence.workload.workloadHash
    );
  } else {
    addCheck(checks, "receipt-binds-workload", false, "Missing workload hash.");
  }

  if (evidence.workload) {
    const currentWorkload = await getWorkloadMeasurement();
    addCheck(
      checks,
      "current-workload-match",
      currentWorkload.workloadHash === evidence.workload.workloadHash,
      `current=${currentWorkload.workloadHash} evidence=${evidence.workload.workloadHash}`
    );
  } else {
    addCheck(checks, "current-workload-match", false, "No workload measurement.");
  }

  await auditGoogleToken(evidence, receipt.payload.attestation.nonce, checks, options.offline === true);

  if (options.solanaCommitment?.kind === "anchor-program" && options.solanaCommitment.status === "confirmed") {
    if (options.offline) {
      checks.push({ name: "chain-readback", status: "skip", detail: "offline audit" });
    } else {
      try {
        const readback = await readExperimentCommitment(receipt);
        checks.push(...readback.checks);
      } catch (error) {
        checks.push({ name: "chain-readback", status: "skip", detail: `RPC unavailable: ${errorMessage(error)}` });
      }
    }
  } else {
    checks.push({ name: "chain-readback", status: "skip", detail: "no confirmed program commitment" });
  }

  return buildAudit(receipt, evidence, checks);
}

function buildAudit(
  receipt: SignedExperimentReceipt,
  evidence: TeeEvidence | null | undefined,
  checks: AuditCheck[]
): ReceiptAudit {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    receiptDigest: receipt.digest,
    resultsRoot: receipt.payload.results?.resultsRoot,
    nonce: receipt.payload.attestation?.nonce,
    evidenceHash: evidence?.evidenceHash,
    workloadHash: evidence?.workload?.workloadHash,
    checks
  };
}

async function auditGoogleToken(
  evidence: TeeEvidence,
  expectedNonce: string,
  checks: AuditCheck[],
  offline: boolean
): Promise<void> {
  const token = evidence.attestation.token;
  const rawToken = token?.rawToken;
  const expectsGoogleToken =
    evidence.source === "gcp-confidential-vm-sev" ||
    evidence.teeProvider.includes("google") ||
    evidence.teeMode.includes("gcp");

  if (!rawToken) {
    addCheck(
      checks,
      "google-token-present",
      !expectsGoogleToken,
      expectsGoogleToken ? "Google attestation token is missing." : "Not a Google TEE run."
    );
    return;
  }

  addCheck(checks, "google-token-present", true, token.tokenHash);
  addCheck(checks, "google-token-hash", sha256HexSync(rawToken) === token.tokenHash);

  let decoded: ReturnType<typeof decodeJwt>;
  try {
    decoded = decodeJwt(rawToken);
  } catch (error) {
    addCheck(checks, "google-token-decode", false, String(error));
    return;
  }
  addCheck(checks, "google-token-decode", true);

  if (offline) {
    checks.push({ name: "google-token-signature", status: "skip", detail: "offline audit" });
  } else {
    try {
      addCheck(checks, "google-token-signature", await verifyJwtSignature(decoded));
    } catch (error) {
      addCheck(checks, "google-token-signature", false, errorMessage(error));
    }
  }

  addCheck(
    checks,
    "google-token-issuer",
    stringClaim(decoded.claims.iss) === "https://confidentialcomputing.googleapis.com",
    stringClaim(decoded.claims.iss)
  );
  addCheck(
    checks,
    "google-token-audience",
    stringClaim(decoded.claims.aud) === config.teeAttestationAudience,
    stringClaim(decoded.claims.aud)
  );
  addCheck(
    checks,
    "google-token-nonce",
    stringClaim(decoded.claims.eat_nonce) === expectedNonce && expectedNonce === evidence.nonce,
    stringClaim(decoded.claims.eat_nonce)
  );
  addCheck(
    checks,
    "google-token-valid-at-collection",
    tokenValidAtEvidenceTime(decoded.claims, evidence.collectedAt),
    `iat=${decoded.claims.iat} nbf=${decoded.claims.nbf} exp=${decoded.claims.exp}`
  );
  addCheck(
    checks,
    "google-hardware-model",
    stringClaim(decoded.claims.hwmodel) === "GCP_AMD_SEV",
    stringClaim(decoded.claims.hwmodel)
  );
  addCheck(checks, "google-secure-boot", decoded.claims.secboot === true, String(decoded.claims.secboot));
}

function recomputeEvidenceHash(evidence: TeeEvidence): string {
  const { evidenceHash: _evidenceHash, ...material } = evidence;
  return sha256HexSync(material);
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("JWT must have three parts.");
  }
  return {
    header: JSON.parse(fromBase64url(parts[0]).toString("utf-8")) as Record<string, unknown>,
    claims: JSON.parse(fromBase64url(parts[1]).toString("utf-8")) as Record<string, unknown>,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: fromBase64url(parts[2])
  };
}

async function verifyJwtSignature(decoded: ReturnType<typeof decodeJwt>): Promise<boolean> {
  const kid = stringClaim(decoded.header.kid);
  const alg = stringClaim(decoded.header.alg);
  if (!kid || alg !== "RS256") {
    return false;
  }
  const key = (await getGoogleJwks()).find((item) => item.kid === kid);
  if (!key) {
    return false;
  }
  const publicKey = createPublicKey({ key: key as CryptoJsonWebKey, format: "jwk" });
  return verifyCrypto("RSA-SHA256", Buffer.from(decoded.signingInput), publicKey, decoded.signature);
}

async function getGoogleJwks(): Promise<JsonWebKeyWithKid[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < 60 * 60 * 1000) {
    return jwksCache.keys;
  }
  const response = await fetch(googleJwksUrl);
  if (!response.ok) {
    throw new Error(`Google JWKS fetch failed: ${response.status}`);
  }
  const body = (await response.json()) as { keys?: JsonWebKeyWithKid[] };
  jwksCache = { fetchedAt: now, keys: body.keys || [] };
  return jwksCache.keys;
}

function tokenValidAtEvidenceTime(claims: Record<string, unknown>, collectedAt: string): boolean {
  const at = Math.floor(Date.parse(collectedAt) / 1000);
  const nbf = numberClaim(claims.nbf);
  const iat = numberClaim(claims.iat);
  const exp = numberClaim(claims.exp);
  if (!Number.isFinite(at) || !iat || !exp) {
    return false;
  }
  return (nbf === undefined || nbf <= at) && iat <= at && at <= exp;
}

function addCheck(checks: AuditCheck[], name: string, passed: boolean, detail?: string): void {
  checks.push({ name, status: passed ? "pass" : "fail", detail });
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberClaim(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
