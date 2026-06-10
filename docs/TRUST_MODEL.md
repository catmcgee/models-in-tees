# Trust Model

## Demo Claim

The demo proves this local workflow:

1. A private model version is represented by a SHA-256 commitment.
2. Public prompts are sent to the API.
3. A private runner loads GPT-2 files from `private/llm`.
4. The runner returns generated text and run hashes, not weights.
5. The API collects TEE evidence and binds its hash into the receipt payload.
6. The API signs a canonical receipt with an Ed25519 runner key.
7. The receipt can be verified later against the public key and payload digest.
8. The receipt digest can be timestamped on Solana devnet.

## What Is Real

- The public demo path uses a GPT-2 causal language model through
  Hugging Face Transformers.
- GPT-2 files are cached outside the served source tree under `private/llm`.
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

## Auditor Suites And The Leakage Policy

The auditor lab adds four experiments that make claims over committed datasets
instead of single prompts:

1. Behavior evals (`/api/audit-suite`): expected-token accuracy, memorization
   checks, and paired-bias gaps, aggregated over the suite.
2. Linear probes (`/api/probe`): per-layer held-out accuracy for a labeled
   concept, trained on hidden states inside the runner.
3. Patch suites (`/api/patch-suite`): mean and spread of activation-patching
   recovery per layer across clean/corrupted pairs.
4. SAE feature reports (`/api/features`): firing rates for sparse-autoencoder
   dictionary features (`npm run train:sae` builds the demo dictionary).

Every suite receipt binds dataset hash, model commitment, aggregate result
hash, leakage policy hash, and TEE evidence hash. The claim it supports is:
"the model with commitment X scored Y on the committed dataset Z under policy
P" - checkable without seeing the weights.

The leakage policy is capped detail, not quotas. Quotas are evaded with new
identities; detail caps bound what any single response reveals about the
private weights:

- Probabilities, log-probs, and scores are coarsened (3 decimals; logits 2).
  Model-extraction attacks feed on output precision.
- Top-k is capped at 3 everywhere.
- Suites return aggregates only; per-item results never leave the runner.
- Probe weight vectors stay inside the runner; they are directions in private
  activation space.
- Minimum suite sizes stop one-item "suites" recovering single-prompt detail
  through the aggregate path.

The policy object ships inside every result and its hash is signed into the
receipt, so an auditor can prove which caps governed a run. The caps are a
declared engineering heuristic: nobody can yet compute the theoretically
correct release budget for model internals, and this design does not claim to.

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
- The demo does not prove that GPT-2 weights are correct by revealing them. It
  proves that a specific committed model runner signed a specific output.

## Production Upgrade Path

1. Move the model runner into a measured confidential workload image.
2. Generate and seal the Ed25519 receipt key inside that measured workload.
3. Bind the model commitment, container image hash, and workload measurement into
   the Google attestation policy.
4. Store the TEE evidence hash and receipt digest in the Solana program account.
5. Add model provenance controls around checkpoint import, review, and rollback.

## What The Public Can Verify

Given a receipt, a verifier can check:

- The payload was not modified after signing.
- The payload digest matches the signed material.
- The receipt references a stable model commitment.
- The prompt, output, and sampling parameter hashes match the payload.
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
