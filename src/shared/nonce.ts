/** tee-ai-nonce/v1: attestation nonce derived from the committed run. */

import { bytesToHex, concatBytes, hex32, sha256Bytes, utf8 } from "./canonical.js";

export const NONCE_SCHEME = "tee-ai-nonce/v1";
const DOMAIN = utf8("tee-ai-nonce/v1");

export interface AttestationNonceInputs {
  resultsRoot: string;
  datasetHash: string;
  registryHash: string;
  modelCommitment: string;
  policyHash: string;
  publicKeyFingerprint: string;
}

export async function deriveAttestationNonce(inputs: AttestationNonceInputs): Promise<string> {
  return bytesToHex(
    await sha256Bytes(
      concatBytes(
        DOMAIN,
        hex32(inputs.resultsRoot, "resultsRoot"),
        hex32(inputs.datasetHash, "datasetHash"),
        hex32(inputs.registryHash, "registryHash"),
        hex32(inputs.modelCommitment, "modelCommitment"),
        hex32(inputs.policyHash, "policyHash"),
        hex32(inputs.publicKeyFingerprint, "publicKeyFingerprint")
      )
    )
  );
}
