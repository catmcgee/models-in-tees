# Trust Model

## Demo Claim

The demo proves this local workflow:

1. A private model version is represented by a SHA-256 commitment.
2. Public benchmark cases are sent to the API.
3. A private runner loads local weights from `private/model`.
4. The runner returns predictions and aggregate metrics, not weights.
5. The API collects TEE evidence and binds its hash into the receipt payload.
6. The API signs a canonical receipt with an Ed25519 runner key.
7. The receipt can be verified later against the public key and payload digest.
8. The receipt digest can be timestamped on Solana devnet.

## What Is Real

- The neural network is a PyTorch transformer classifier.
- The weights are saved outside the served source tree under `private/model`.
- Receipts use deterministic canonical JSON hashing.
- Receipts are signed with Ed25519.
- The deployed GCP VM exposes Google Confidential VM attestation claims through
  `/api/tee/evidence`.
- VM receipts include `runner.teeEvidenceHash` and a public TEE summary with
  `GCP_AMD_SEV`, secure boot status, project, zone, and instance.
- VM receipts now bind a workload hash covering the app source, built server,
  built frontend assets, model runner, package metadata, and Solana program
  source present on the VM.
- Stored receipt evidence can be audited through `/api/receipts/:id/audit`,
  including Google JWT signature verification against the Confidential Computing
  signer JWKS.
- Solana devnet commits use a deployed Anchor program; Memo remains a fallback.
- MagicBlock service status, ER RPC probes, delegation, ER execution, and commit
  signature resolution use live devnet endpoints.

## What Is Still Limited

- Local development is still a simulation. Only the deployed Google Confidential
  VM path has hardware-backed VM attestation.
- The runner key is stored inside the Confidential VM filesystem under
  `private/attestation`. A stronger production build would generate and seal this
  key inside a measured workload and bind the key certificate to the attestation
  report.
- Google AMD SEV Confidential VM attestation proves the VM identity and measured
  boot claims. It does not by itself prove every Python/Node source file loaded
  at runtime unless those measurements are added to the attested workload policy.
- MagicBlock Private ER permission accounts are not yet implemented. The demo
  executes standard MagicBlock ER delegation against the deployed program.

## Production Upgrade Path

1. Move the model runner into a measured confidential workload image.
2. Generate and seal the Ed25519 receipt key inside that measured workload.
3. Bind the model commitment, container image hash, and workload measurement into
   the Google attestation policy.
4. Store the TEE evidence hash and receipt digest in the Solana program account.
5. Add MagicBlock Private ER permission accounts for evaluator/operator/runner
   roles.

## What The Public Can Verify

Given a receipt, a verifier can check:

- The payload was not modified after signing.
- The payload digest matches the signed material.
- The receipt references a stable model commitment.
- The input set, output set, and metrics hashes match the payload.
- The receipt binds to a TEE evidence hash.
- The stored evidence hash recomputes to the receipt-bound value.
- The Google token, when present, has a valid RS256 signature, issuer, audience,
  nonce, validity window, `GCP_AMD_SEV` hardware claim, and secure boot claim.
- The stored workload hash matches the currently deployed workload.
- A Solana Anchor transaction, when present, timestamped the receipt digest.
- The API can produce a fresh Google claims token for the current VM when raw
  evidence exposure is explicitly enabled with `ALLOW_RAW_TEE_EVIDENCE=1`.

The public cannot verify the private weights directly. The credible proof is the
combination of model commitment, receipt signature, Google VM attestation, and
Solana timestamp. The remaining hardening work is to make the measured workload
policy cover the exact runner code and receipt key.
