"""Tokenizer-level registry validation (the structural half lives in registry.py)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .experiments import KINDS
from .policy import LEAKAGE_POLICY
from .registry import load_registry


def validate_registry(llm: Any, sae: Optional[Any]) -> Dict[str, Any]:
    registry = load_registry(force=True)
    errors: List[str] = list(registry["errors"])
    reports = []
    for experiment in registry["experiments"]:
        module = KINDS[experiment["kind"]]
        checks: List[Dict[str, Any]] = []
        exp_errors: List[str] = []
        for index, item in enumerate(experiment["items"]):
            for error in module.validate_item(llm, item, experiment["params"]):
                exp_errors.append(f"{experiment['id']}[{index}]: {error}")
        if experiment["kind"] == "linear-probe":
            positives = sum(1 for item in experiment["items"] if item.get("label") == 1)
            negatives = experiment["itemCount"] - positives
            per_class = int(LEAKAGE_POLICY["minProbeExamplesPerClass"])
            if positives < per_class or negatives < per_class:
                exp_errors.append(f"{experiment['id']}: each class needs at least {per_class} examples")
        if experiment["kind"] == "sae-features":
            if sae is None:
                exp_errors.append(f"{experiment['id']}: SAE is not available")
            else:
                mismatch = sae.matches_params(experiment["params"]["sae"])
                if mismatch:
                    exp_errors.append(f"{experiment['id']}: {mismatch}")
        checks.append({"name": "items", "status": "fail" if exp_errors else "pass", "detail": f"{experiment['itemCount']} items"})
        errors.extend(exp_errors)
        reports.append(
            {
                "id": experiment["id"],
                "kind": experiment["kind"],
                "itemCount": experiment["itemCount"],
                "datasetHash": experiment["datasetHash"],
                "experimentHash": experiment["experimentHash"],
                "checks": checks,
                "errors": exp_errors,
            }
        )
    return {
        "ok": not errors,
        "registryHash": registry["registryHash"],
        "experiments": reports,
        "errors": errors,
    }
