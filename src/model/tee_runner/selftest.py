"""Self-test: known-answer vectors, registry validity, commitments, and one
real experiment end to end (proofs verify, no floats, metrics recomputable)."""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

from . import paths
from .canonical import assert_no_floats, canonical_hash, canonical_json
from .disclosure import disclosure_seed, sample_indices
from .envelope import run_experiment
from .experiments import KINDS
from .merkle import inclusion_proof, leaf_hash, merkle_root, verify_inclusion
from .nonce import attestation_nonce
from .registry import require_registry
from .validation import validate_registry


def _check(checks: List[Dict[str, Any]], name: str, passed: bool, detail: str = "") -> bool:
    checks.append({"name": name, "status": "pass" if passed else "fail", "detail": detail})
    return passed


def known_answer_checks(checks: List[Dict[str, Any]]) -> None:
    vectors = json.loads(paths.TEST_VECTORS_PATH.read_text(encoding="utf-8"))
    ok = True
    for case in vectors["canonical"]:
        ok = ok and canonical_json(case["value"]) == case["canonical"] and canonical_hash(case["value"]) == case["sha256"]
    _check(checks, "canonical-kat", ok, f"{len(vectors['canonical'])} vectors")

    m = vectors["merkle"]
    hashes = [leaf_hash(leaf) for leaf in m["leaves"]]
    ok = hashes == m["leafHashes"]
    for entry in m["roots"]:
        ok = ok and merkle_root(hashes[: entry["n"]]) == entry["root"]
    for entry in m["proofs"]:
        proof = inclusion_proof(hashes[: entry["n"]], entry["index"])
        ok = ok and proof == entry["proof"] and verify_inclusion(hashes[entry["index"]], proof, entry["root"])
    _check(checks, "merkle-kat", ok)

    ok = True
    for entry in vectors["disclosure"]:
        seed = disclosure_seed(entry["resultsRoot"], entry["datasetHash"], entry["modelCommitment"])
        ok = ok and seed == entry["seed"] and sample_indices(seed, entry["leafCount"], entry["count"]) == entry["indices"]
    _check(checks, "disclosure-kat", ok)

    ok = True
    for entry in vectors["nonce"]:
        inputs = entry["inputs"]
        ok = ok and attestation_nonce(
            inputs["resultsRoot"],
            inputs["datasetHash"],
            inputs["registryHash"],
            inputs["modelCommitment"],
            inputs["policyHash"],
            inputs["publicKeyFingerprint"],
        ) == entry["nonce"]
    _check(checks, "nonce-kat", ok)


def run_selftest(runner: Any) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    started = time.perf_counter()
    try:
        known_answer_checks(checks)
    except Exception as exc:  # noqa: BLE001
        _check(checks, "known-answer-vectors", False, str(exc))

    report = validate_registry(runner.llm, runner.sae)
    _check(checks, "registry-valid", report["ok"], "; ".join(report["errors"][:5]) or report["registryHash"])
    _check(checks, "model-commitment", bool(runner.llm.commitment), runner.llm.commitment)
    _check(checks, "sae-commitment", runner.sae is not None, runner.sae.commitment if runner.sae else runner.sae_error or "")

    experiment: Optional[Dict[str, Any]] = None
    if report["ok"]:
        candidates = [e for e in require_registry()["experiments"] if e["kind"] == "expected-token"]
        if candidates:
            experiment = min(candidates, key=lambda e: e["itemCount"])
    if experiment is None:
        _check(checks, "run-experiment", False, "no valid expected-token experiment to run")
    else:
        try:
            result = run_experiment(runner.llm, runner.sae, experiment["id"])
            _check(checks, "run-experiment", True, f"{experiment['id']} in {result['timing']['totalMs']} ms")
            root = result["results"]["resultsRoot"]
            proofs_ok = all(
                verify_inclusion(d["leafHash"], d["proof"], root) and leaf_hash(d["leaf"]) == d["leafHash"]
                for d in result["disclosure"]["leaves"]
            )
            _check(checks, "disclosed-proofs-verify", proofs_ok, f"{len(result['disclosure']['leaves'])} leaves")
            try:
                assert_no_floats(result["results"])
                assert_no_floats(result["disclosure"])
                assert_no_floats(result["experiment"])
                assert_no_floats(result["policy"])
                _check(checks, "no-floats-in-committed-material", True)
            except Exception as exc:  # noqa: BLE001
                _check(checks, "no-floats-in-committed-material", False, str(exc))
            module = KINDS[experiment["kind"]]
            recomputed = module.aggregate(result["sealed"]["leaves"], experiment["params"])
            _check(
                checks,
                "metrics-recomputable-from-leaves",
                canonical_hash(recomputed) == result["results"]["metricsHash"],
            )
            _check(
                checks,
                "results-root-recomputable",
                merkle_root([leaf_hash(leaf) for leaf in result["sealed"]["leaves"]]) == root,
            )
        except Exception as exc:  # noqa: BLE001
            _check(checks, "run-experiment", False, f"{type(exc).__name__}: {exc}")

    passed = all(check["status"] == "pass" for check in checks)
    return {
        "ok": passed,
        "selftest": {
            "passed": passed,
            "checks": checks,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
        },
    }
