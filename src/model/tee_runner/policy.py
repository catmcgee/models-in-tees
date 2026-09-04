"""Leakage policy v2: capped detail plus Merkle partial reveal.

Detail caps are enforced inside the runner. The policy object ships in every
result and its hash is signed into the receipt, so an auditor can prove which
caps governed a run. Node recomputes policyHash and refuses to sign on
mismatch, which doubles as a live cross-language canonicalisation check.
"""

from __future__ import annotations

from .canonical import canonical_hash

LEAKAGE_POLICY = {
    "schema": "tee-ai-leakage-policy/v2",
    "strategy": "capped-detail+merkle-partial-reveal",
    "fixedPoint": {
        "probabilityScale": 10000,
        "logProbScale": 1000,
        "scoreScale": 1000,
        "activationScale": 100,
    },
    "maxTopK": 3,
    "merkleCommitted": True,
    "merkleScheme": "rfc6962-sha256",
    "disclosureScheme": "tee-ai-disclosure/v1",
    "disclosedItemPercent": 25,
    "minDisclosedItems": 3,
    "maxDisclosedItems": 8,
    "perItemResultsSealed": True,
    "probeWeightsReturned": False,
    "rawActivationsReturned": False,
    "rawAttentionReturned": False,
    "weightsReturned": False,
    "minEvalSuiteItems": 8,
    "maxEvalSuiteItems": 64,
    "minProbeExamples": 24,
    "maxProbeExamples": 200,
    "minProbeExamplesPerClass": 8,
    "minPatchPairs": 3,
    "maxPatchPairs": 12,
    "minFeaturePrompts": 4,
    "maxFeaturePrompts": 16,
    "maxFeaturesReported": 12,
    "maxFeaturesPerItem": 8,
}


def policy_hash() -> str:
    return canonical_hash(LEAKAGE_POLICY)
