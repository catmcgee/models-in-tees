"""tee-ai-nonce/v1: attestation nonce derived from the committed run.

Node computes this before asking the TEE for a token; the runner only needs
it for test vectors and self-checks.
"""

from __future__ import annotations

from .canonical import sha256_bytes

SCHEME = "tee-ai-nonce/v1"
DOMAIN = b"tee-ai-nonce/v1"


def attestation_nonce(
    results_root: str,
    dataset_hash: str,
    registry_hash: str,
    model_commitment: str,
    policy_hash: str,
    public_key_fingerprint: str,
) -> str:
    material = DOMAIN + b"".join(
        bytes.fromhex(part)
        for part in (
            results_root,
            dataset_hash,
            registry_hash,
            model_commitment,
            policy_hash,
            public_key_fingerprint,
        )
    )
    return sha256_bytes(material).hex()
