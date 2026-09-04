"""Committed experiment registry: src/experiments/<id>.json.

The registry is part of the measured workload. The runner refuses to run
anything that is not in it, and every hash here is recomputable from the
public JSON files with the canonical JSON rules.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import paths
from .canonical import CanonicalError, canonical_hash
from .policy import LEAKAGE_POLICY

EXPERIMENT_SCHEMA = "tee-ai-experiment/v1"
REGISTRY_SCHEMA = "tee-ai-experiment-registry/v1"
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")

KINDS = (
    "expected-token",
    "memorization",
    "paired-bias",
    "linear-probe",
    "activation-patching",
    "sae-features",
)

# Exact parameter sets per kind. Unknown keys are rejected so a registry file
# cannot smuggle behaviour the runner does not understand.
PARAM_SPECS: Dict[str, Dict[str, type]] = {
    "expected-token": {"maxPromptTokens": int},
    "memorization": {"maxPrefixTokens": int, "maxContinuationTokens": int},
    "paired-bias": {"maxPromptTokens": int},
    "linear-probe": {
        "maxTextTokens": int,
        "testPercent": int,
        "seed": int,
        "steps": int,
        "learningRateMicro": int,
        "weightDecayMicro": int,
    },
    "activation-patching": {"maxPromptTokens": int, "position": str},
    "sae-features": {"maxPromptTokens": int, "excludeBos": bool, "sae": dict},
}
SAE_PARAM_SPEC: Dict[str, type] = {
    "repoId": str,
    "subfolder": str,
    "layer": int,
    "hiddenStateIndex": int,
    "width": int,
}

ITEM_BOUNDS = {
    "expected-token": ("minEvalSuiteItems", "maxEvalSuiteItems"),
    "memorization": ("minEvalSuiteItems", "maxEvalSuiteItems"),
    "paired-bias": ("minEvalSuiteItems", "maxEvalSuiteItems"),
    "linear-probe": ("minProbeExamples", "maxProbeExamples"),
    "activation-patching": ("minPatchPairs", "maxPatchPairs"),
    "sae-features": ("minFeaturePrompts", "maxFeaturePrompts"),
}


class RegistryError(ValueError):
    pass


_CACHE: Optional[Dict[str, Any]] = None


def item_hash(item: Any) -> str:
    return canonical_hash(item)


def dataset_hash(items: List[Any]) -> str:
    return canonical_hash(items)


def experiment_hash(document: Dict[str, Any]) -> str:
    return canonical_hash(document)


def registry_hash(experiments: List[Dict[str, Any]]) -> str:
    return canonical_hash(
        {
            "schema": REGISTRY_SCHEMA,
            "experiments": [
                {"id": exp["id"], "experimentHash": exp["experimentHash"]}
                for exp in sorted(experiments, key=lambda e: e["id"])
            ],
        }
    )


def _check_type(value: Any, expected: type) -> bool:
    if expected is int:
        return isinstance(value, int) and not isinstance(value, bool)
    if expected is bool:
        return isinstance(value, bool)
    return isinstance(value, expected)


def _structural_errors(document: Any, file: Path) -> List[str]:
    errors: List[str] = []
    if not isinstance(document, dict):
        return [f"{file.name}: not a JSON object"]
    if document.get("schema") != EXPERIMENT_SCHEMA:
        errors.append(f"{file.name}: schema must be {EXPERIMENT_SCHEMA}")
    exp_id = document.get("id")
    if not isinstance(exp_id, str) or not ID_PATTERN.match(exp_id):
        errors.append(f"{file.name}: id must match {ID_PATTERN.pattern}")
    elif exp_id != file.stem:
        errors.append(f"{file.name}: id '{exp_id}' must equal the file stem")
    kind = document.get("kind")
    if kind not in KINDS:
        errors.append(f"{file.name}: kind must be one of {', '.join(KINDS)}")
        return errors
    for field in ("title", "description"):
        value = document.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > 400:
            errors.append(f"{file.name}: {field} must be a non-empty string (<= 400 chars)")
    allowed_keys = {"schema", "id", "kind", "title", "description", "params", "items"}
    extra = set(document.keys()) - allowed_keys
    if extra:
        errors.append(f"{file.name}: unexpected top-level keys {sorted(extra)}")

    params = document.get("params")
    spec = PARAM_SPECS[kind]
    if not isinstance(params, dict):
        errors.append(f"{file.name}: params must be an object")
    else:
        if set(params.keys()) != set(spec.keys()):
            errors.append(
                f"{file.name}: params keys must be exactly {sorted(spec.keys())}, got {sorted(params.keys())}"
            )
        for key, expected in spec.items():
            if key in params and not _check_type(params[key], expected):
                errors.append(f"{file.name}: params.{key} must be {expected.__name__}")
        if kind == "sae-features" and isinstance(params.get("sae"), dict):
            sae = params["sae"]
            if set(sae.keys()) != set(SAE_PARAM_SPEC.keys()):
                errors.append(f"{file.name}: params.sae keys must be exactly {sorted(SAE_PARAM_SPEC.keys())}")
            for key, expected in SAE_PARAM_SPEC.items():
                if key in sae and not _check_type(sae[key], expected):
                    errors.append(f"{file.name}: params.sae.{key} must be {expected.__name__}")

    items = document.get("items")
    if not isinstance(items, list):
        errors.append(f"{file.name}: items must be a list")
    else:
        lo_key, hi_key = ITEM_BOUNDS[kind]
        lo, hi = LEAKAGE_POLICY[lo_key], LEAKAGE_POLICY[hi_key]
        if not lo <= len(items) <= hi:
            errors.append(f"{file.name}: {kind} needs between {lo} and {hi} items (got {len(items)})")
        hashes = set()
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                errors.append(f"{file.name}[{index}]: item must be an object")
                continue
            try:
                h = item_hash(item)
            except CanonicalError as exc:
                errors.append(f"{file.name}[{index}]: {exc}")
                continue
            if h in hashes:
                errors.append(f"{file.name}[{index}]: duplicate item")
            hashes.add(h)
    try:
        canonical_hash(document)
    except CanonicalError as exc:
        errors.append(f"{file.name}: {exc}")
    return errors


def load_registry(force: bool = False) -> Dict[str, Any]:
    """Load, structurally validate, and hash every experiment file."""
    global _CACHE
    if _CACHE is not None and not force:
        return _CACHE
    files = sorted(paths.REGISTRY_DIR.glob("*.json"))
    experiments: List[Dict[str, Any]] = []
    errors: List[str] = []
    seen_ids = set()
    for file in files:
        try:
            document = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            errors.append(f"{file.name}: cannot parse JSON ({exc})")
            continue
        file_errors = _structural_errors(document, file)
        errors.extend(file_errors)
        if file_errors:
            continue
        if document["id"] in seen_ids:
            errors.append(f"{file.name}: duplicate id")
            continue
        seen_ids.add(document["id"])
        experiments.append(
            {
                "id": document["id"],
                "kind": document["kind"],
                "title": document["title"],
                "description": document["description"],
                "params": document["params"],
                "items": document["items"],
                "itemCount": len(document["items"]),
                "datasetHash": dataset_hash(document["items"]),
                "experimentHash": experiment_hash(document),
            }
        )
    experiments.sort(key=lambda e: e["id"])
    registry = {
        "schema": REGISTRY_SCHEMA,
        "registryHash": registry_hash(experiments) if not errors else None,
        "experiments": experiments,
        "errors": errors,
    }
    _CACHE = registry
    return registry


def require_registry() -> Dict[str, Any]:
    registry = load_registry()
    if registry["errors"]:
        raise RegistryError("; ".join(registry["errors"]))
    return registry


def get_experiment(experiment_id: str) -> Optional[Dict[str, Any]]:
    for experiment in require_registry()["experiments"]:
        if experiment["id"] == experiment_id:
            return experiment
    return None


def public_registry(include_items: bool = True) -> Dict[str, Any]:
    registry = require_registry()
    return {
        "schema": registry["schema"],
        "registryHash": registry["registryHash"],
        "experiments": [
            {
                key: value
                for key, value in experiment.items()
                if include_items or key != "items"
            }
            for experiment in registry["experiments"]
        ],
    }
