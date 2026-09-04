#!/usr/bin/env python3
"""Regenerate src/shared/test-vectors.json from the Python reference
implementation. The TypeScript side asserts these vectors at startup, so the
two canonical-JSON / Merkle / disclosure / nonce implementations cannot drift
silently.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "model"))

from tee_runner.canonical import canonical_hash, canonical_json, div_round, fixed  # noqa: E402
from tee_runner.disclosure import disclosure_count, disclosure_seed, sample_indices  # noqa: E402
from tee_runner.merkle import inclusion_proof, leaf_hash, merkle_root  # noqa: E402
from tee_runner.nonce import attestation_nonce  # noqa: E402


def h(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> None:
    canonical_cases = [
        {"name": "nested-unicode", "value": {"b": 1, "a": [True, None, "é\n\"x\""], "Z": {"y": -2, "x": "日本"}, "_": 0}},
        {"name": "integer-like-keys", "value": {"10": "ten", "2": "two", "1": "one", "a": "letter", "": "empty"}},
        {
            "name": "empty-containers",
            "value": {"arr": [], "obj": {}, "s": "", "n": 0, "neg": -1, "big": 9007199254740991, "nbig": -9007199254740991},
        },
        {"name": "control-and-slash", "value": {"k": "tab\tnl\ncr\rq\"bs\\slash/"}},
        {"name": "case-order", "value": {"b": 1, "B": 2, "a": 3, "A": 4, "_": 5, "~": 6, "é": 7, "z": 8}},
        {"name": "array-of-objects", "value": [{"z": 1, "a": 2}, {"a": [1, 2, {"c": None}]}]},
        {"name": "astral-and-fullwidth-order", "value": {"\U0001f600": 1, "﹏": 2, "ｚ": 3, "z": 4, " ": 5}},
        {"name": "bool-vs-int", "value": {"t": True, "f": False, "one": 1, "zero": 0, "null": None}},
    ]
    for case in canonical_cases:
        case["canonical"] = canonical_json(case["value"])
        case["sha256"] = canonical_hash(case["value"])

    leaves = [{"schema": "tee-ai-test-leaf/v1", "index": i, "value": i * i} for i in range(5)]
    hashes = [leaf_hash(leaf) for leaf in leaves]
    merkle = {
        "leaves": leaves,
        "leafHashes": hashes,
        "roots": [{"n": n, "root": merkle_root(hashes[:n])} for n in range(1, 6)],
        "proofs": [{"n": 5, "index": i, "root": merkle_root(hashes), "proof": inclusion_proof(hashes, i)} for i in range(5)]
        + [{"n": 3, "index": 2, "root": merkle_root(hashes[:3]), "proof": inclusion_proof(hashes[:3], 2)}],
    }

    zero = "00" * 32
    a, b, c = h("root"), h("dataset"), h("model")
    disclosure = []
    for root, dataset, model, n, pct, lo, hi in [
        (zero, zero, zero, 12, 25, 3, 8),
        (a, b, c, 48, 25, 3, 8),
        (a, b, c, 8, 25, 3, 8),
        (a, b, c, 6, 25, 3, 8),
        (a, b, c, 3, 25, 3, 8),
        (a, b, c, 200, 25, 3, 8),
    ]:
        seed = disclosure_seed(root, dataset, model)
        count = disclosure_count(n, pct, lo, hi)
        disclosure.append(
            {
                "resultsRoot": root,
                "datasetHash": dataset,
                "modelCommitment": model,
                "leafCount": n,
                "percent": pct,
                "min": lo,
                "max": hi,
                "count": count,
                "seed": seed,
                "indices": sample_indices(seed, n, count),
            }
        )

    nonce = []
    for inputs in [
        dict(resultsRoot=zero, datasetHash=zero, registryHash=zero, modelCommitment=zero, policyHash=zero, publicKeyFingerprint=zero),
        dict(resultsRoot=a, datasetHash=b, registryHash=h("registry"), modelCommitment=c, policyHash=h("policy"), publicKeyFingerprint=h("key")),
    ]:
        nonce.append(
            {
                "inputs": inputs,
                "nonce": attestation_nonce(
                    inputs["resultsRoot"],
                    inputs["datasetHash"],
                    inputs["registryHash"],
                    inputs["modelCommitment"],
                    inputs["policyHash"],
                    inputs["publicKeyFingerprint"],
                ),
            }
        )

    fixed_point = {
        "divRound": [
            {"a": x, "b": y, "result": div_round(x, y)}
            for x, y in [(7, 2), (-7, 2), (5, 3), (-5, 3), (0, 4), (1, 3), (2, 3), (999, 1000), (1000, 3)]
        ],
        "fixed": [
            {"value": v, "scale": s, "result": fixed(v, s)}
            for v, s in [(0.12345, 10000), (-0.00005, 10000), (2.5, 1), (-2.5, 1), (0.0005, 1000), (1e-9, 1000)]
        ],
    }

    out = {
        "schema": "tee-ai-test-vectors/v1",
        "canonical": canonical_cases,
        "merkle": merkle,
        "disclosure": disclosure,
        "nonce": nonce,
        "fixedPoint": fixed_point,
    }
    target = ROOT / "src" / "shared" / "test-vectors.json"
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {target} ({len(canonical_cases)} canonical, {len(disclosure)} disclosure)")


if __name__ == "__main__":
    main()
