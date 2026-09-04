# Trust Model

## The Claim

A run of a registered experiment produces a signed receipt that says:

> The model with commitment **M**, run inside the attested environment **E**,
> produced per-item results whose Merkle root is **R** on the committed dataset
> **D** (from registry **G**) under leakage policy **P**. These aggregates and
> these opened items are exactly what that run computed.

Every letter in that sentence is a hash that a third party can recompute from
public material, in the browser, without trusting the API.

## How A Run Is Bound Together

1. The registry (`src/experiments/*.json`) is committed by `registryHash`; every
   experiment's items are committed by `datasetHash`. Both files and the runner
   code are inside the measured workload.
2. The runner computes one canonical leaf per item and builds an RFC 6962
   Merkle tree over them. Aggregate metrics are pure integer functions of the
   leaves, so anyone holding the opened leaves can recheck the arithmetic and
   anyone holding all leaves can recompute the metrics exactly.
3. A seed derived from `resultsRoot || datasetHash || modelCommitment` picks
   which leaves are opened (25%, min 3, max 8). The operator cannot steer it,
   and re-running an unchanged experiment opens the same items again, so
   repeated runs leak nothing new.
4. The attestation nonce is
   `sha256("tee-ai-nonce/v1" || resultsRoot || datasetHash || registryHash || modelCommitment || policyHash || signerFingerprint)`.
   It is handed to `gotpm token --custom-nonce`, so the Google Confidential VM
   token's `eat_nonce` claim commits to the exact results, not just to "a run".
5. The receipt payload contains the aggregates, the opened leaves with their
   inclusion proofs, the policy, the nonce, and the TEE evidence hash, and is
   signed with the runner's Ed25519 key over canonical JSON.
6. Optionally the receipt digest, model commitment, experiment id hash, dataset
   hash, results root, policy hash and TEE evidence hash are written to the
   `experiment_receipts` Solana program (one immutable PDA per receipt) and
   read back field by field during audit.

## Canonical Hashing

Everything is hashed over `tee-ai-canonical-json/v1`: keys sorted by UTF-16
code units, no whitespace, JSON.stringify escaping, and **integers only**.
Probabilities are basis points (`Bp`, x10 000), log-probs and scores are
`Milli` (x1 000), SAE activations are `Centi` (x100). Python and TypeScript
share known-answer vectors in `src/shared/test-vectors.json`; the API refuses
to sign a run whose `policyHash` or `metricsHash` it cannot reproduce.

## What Is Real

- The sealed model is `google/gemma-3-1b-pt`, committed by the SHA-256 of its
  weight, config and tokenizer files. The weights are never served.
- The SAE experiment uses Google's Gemma Scope 2 dictionary (CC-BY-4.0),
  committed the same way.
- Receipts are Ed25519 signatures over canonical JSON. Verification runs in
  the browser with WebCrypto (`src/shared/verify.ts`).
- On the Confidential VM, the Google claims token is fetched with the derived
  nonce, verified against Google's JWKS, and checked for issuer, audience,
  nonce, validity window, `GCP_AMD_SEV` and secure boot.
- The workload hash covers the source tree, registry, built server, built
  frontend, runner and program source. It is re-measured at audit time.
- Solana commitments use the upgraded Anchor program and are read back.

## Leakage Policy

Detail caps, not quotas. Numbers are fixed-point at declared scales, per-item
results are sealed except for the seeded sample, probe weights and raw
activations never leave the runner, and suite sizes are bounded. The policy
object is inside the signed receipt. The caps are an engineering heuristic;
nobody can yet compute the theoretically correct release budget for model
internals, and this design does not claim to.

## What Is Still Limited

- AMD SEV attestation measures the VM boot, not the Python and Node code. The
  workload hash is measured and reported by the Node process itself; it is
  honest self-report bound into the attested nonce, not a hardware measurement.
- The Ed25519 signing key is a file on the VM. A stronger build would generate
  it inside a measured workload and bind it to the attestation report.
- fp32 results are bit-stable on the VM, but other CPUs or BLAS builds can
  differ in the last bits. The receipt attests what the attested VM computed;
  it does not promise bit-exact re-execution elsewhere.
- Local development (`TEE_MODE=local-dev-sim`) has no hardware token; every
  other check still runs.
- Opening leaves beyond the seeded sample is not exposed; the sealed leaves are
  stored on the VM so a gated "open item N" path could be added later.

## What The Public Can Verify

Given a public record (receipt + descriptive context) and the registry file:

- Receipt digest and Ed25519 signature; signer fingerprint (optionally pinned).
- `policyHash`, `metricsHash`, `datasetHash` recomputed from public JSON.
- `leafCount == itemCount`.
- Disclosure seed and indices recomputed from committed material.
- Every opened leaf's hash and its inclusion proof against `resultsRoot`.
- The attestation nonce recomputed from receipt fields, equal to the evidence
  nonce and, on the VM, to the Google token's `eat_nonce`.
- The stored evidence hash, the workload hash, and the Google token claims.
- The on-chain commitment account, decoded and compared field by field.
