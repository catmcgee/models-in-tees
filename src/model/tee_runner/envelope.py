"""run-experiment orchestration: leaves -> Merkle root -> aggregates ->
seeded disclosure with inclusion proofs -> result envelope."""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

from . import paths
from .canonical import assert_no_floats, canonical_hash
from .disclosure import SCHEME as DISCLOSURE_SCHEME
from .disclosure import disclosure_count, disclosure_seed, sample_indices
from .experiments import KINDS
from .experiments.common import RunContext
from .merkle import SCHEME as MERKLE_SCHEME
from .merkle import inclusion_proof, leaf_hash, merkle_root, verify_inclusion
from .policy import LEAKAGE_POLICY, policy_hash
from .registry import get_experiment, require_registry

RESULT_SCHEMA = "tee-ai-experiment-result/v1"


class RunError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def run_experiment(llm: Any, sae: Optional[Any], experiment_id: str) -> Dict[str, Any]:
    registry = require_registry()
    experiment = get_experiment(experiment_id)
    if experiment is None:
        raise RunError("unknown-experiment", f"experiment {experiment_id!r} is not in the registry")
    kind = experiment["kind"]
    module = KINDS[kind]
    if kind == "sae-features" and sae is None:
        raise RunError("sae-unavailable", "the SAE dictionary is not loaded")

    started = time.perf_counter()
    ctx = RunContext(llm, sae)
    leaves, descriptive = module.run(ctx, experiment)
    if len(leaves) != experiment["itemCount"]:
        raise RunError("internal", "leaf count does not match item count")
    assert_no_floats(leaves)

    leaf_hashes = [leaf_hash(leaf) for leaf in leaves]
    results_root = merkle_root(leaf_hashes)
    metrics = module.aggregate(leaves, experiment["params"])
    assert_no_floats(metrics)
    metrics_hash = canonical_hash(metrics)

    seed = disclosure_seed(results_root, experiment["datasetHash"], llm.commitment)
    count = disclosure_count(
        len(leaves),
        int(LEAKAGE_POLICY["disclosedItemPercent"]),
        int(LEAKAGE_POLICY["minDisclosedItems"]),
        int(LEAKAGE_POLICY["maxDisclosedItems"]),
    )
    indices = sample_indices(seed, len(leaves), count)
    disclosed = []
    for index in indices:
        proof = inclusion_proof(leaf_hashes, index)
        if not verify_inclusion(leaf_hashes[index], proof, results_root):
            raise RunError("internal", f"inclusion proof for leaf {index} failed self-verification")
        disclosed.append({"index": index, "leaf": leaves[index], "leafHash": leaf_hashes[index], "proof": proof})

    total_ms = int((time.perf_counter() - started) * 1000)
    return {
        "schema": RESULT_SCHEMA,
        "experiment": {
            "id": experiment["id"],
            "kind": kind,
            "title": experiment["title"],
            "params": experiment["params"],
            "itemCount": experiment["itemCount"],
            "datasetHash": experiment["datasetHash"],
            "experimentHash": experiment["experimentHash"],
            "registryHash": registry["registryHash"],
        },
        "model": {
            "commitment": llm.commitment,
            "modelId": paths.LLM_MODEL_ID,
            "architecture": llm.architecture(),
            "runtime": llm.runtime(),
        },
        "sae": sae.info() if (sae is not None and kind == "sae-features") else None,
        "policy": LEAKAGE_POLICY,
        "policyHash": policy_hash(),
        "results": {
            "resultsRoot": results_root,
            "leafCount": len(leaves),
            "leafSchema": module.LEAF_SCHEMA,
            "merkleScheme": MERKLE_SCHEME,
            "metrics": metrics,
            "metricsHash": metrics_hash,
        },
        "disclosure": {
            "scheme": DISCLOSURE_SCHEME,
            "seed": seed,
            "count": count,
            "indices": indices,
            "leaves": disclosed,
        },
        "sealed": {"leaves": leaves, "leafHashes": leaf_hashes},
        "descriptive": descriptive,
        "timing": {"totalMs": total_ms, "forwardPasses": ctx.forward_passes},
    }
