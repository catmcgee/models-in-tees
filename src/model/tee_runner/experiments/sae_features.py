"""sae-features: which Gemma Scope dictionary features fire on each prompt.

Per prompt the leaf keeps only the top-k features by firing count with a
coarse max activation. Feature labels (top activating tokens) are
descriptive, unsigned context."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import torch

from ..canonical import ACTIVATION_SCALE, SCORE_SCALE, div_round, fixed
from ..policy import LEAKAGE_POLICY
from .common import RunContext, base_leaf, check_item_keys, check_prompt_length, require_str, residual_digests, tensor_digest

LEAF_SCHEMA = "tee-ai-leaf/sae-features/v1"


def validate_item(llm: Any, item: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    check_item_keys(item, ["prompt"], errors, "item")
    prompt = require_str(item, "prompt", errors, "item")
    check_prompt_length(llm, prompt, int(params["maxPromptTokens"]), errors, "item.prompt")
    if params.get("excludeBos") is not True:
        errors.append("params.excludeBos must be true")
    return errors


def run(ctx: RunContext, experiment: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    llm = ctx.llm
    sae = ctx.sae
    if sae is None:
        raise RuntimeError("SAE is not loaded")
    params = experiment["params"]
    mismatch = sae.matches_params(params["sae"])
    if mismatch:
        raise RuntimeError(mismatch)
    cap = int(params["maxPromptTokens"])
    per_item = int(LEAKAGE_POLICY["maxFeaturesPerItem"])

    leaves: List[Dict[str, Any]] = []
    # feature -> list of (activation, token string) for labelling
    label_pool: Dict[int, List[Tuple[float, str]]] = {}
    for index, item in enumerate(experiment["items"]):
        seq = llm.encode_prompt(item["prompt"], cap)
        all_hidden = llm.hidden_states_single(seq)
        final_token = torch.stack([h[0, -1, :] for h in all_hidden])
        hidden = all_hidden[sae.hidden_state_index][0]
        ctx.forward_passes += 1
        hidden = hidden[1:, :]  # excludeBos
        token_ids = seq[1:]
        with torch.no_grad():
            acts = sae.encode(hidden)  # [T, width]
        active = acts > 0
        fired = active.sum(dim=0)  # [width]
        max_act = acts.max(dim=0).values
        token_count = int(hidden.shape[0])
        active_pairs = int(active.sum().item())

        candidates = torch.nonzero(fired > 0).flatten().tolist()
        candidates.sort(key=lambda f: (-int(fired[f].item()), f))
        top = candidates[:per_item]
        features = [
            {
                "feature": int(f),
                "firedTokenCount": int(fired[f].item()),
                "maxActivationCenti": fixed(float(max_act[f].item()), ACTIVATION_SCALE),
            }
            for f in top
        ]
        for f in top:
            pool = label_pool.setdefault(int(f), [])
            column = acts[:, f]
            for position in torch.nonzero(column > 0).flatten().tolist():
                pool.append((float(column[position].item()), llm.decode_token(token_ids[position])))

        leaf = base_leaf(LEAF_SCHEMA, index, item)
        leaf.update(
            {
                "tokenCount": token_count,
                "activePairs": active_pairs,
                "meanL0Milli": div_round(active_pairs * SCORE_SCALE, token_count),
                "features": features,
                "residualDigests": residual_digests(final_token),
                "saeActivationsDigest": tensor_digest(acts),
            }
        )
        leaves.append(leaf)

    labels: Dict[str, Dict[str, Any]] = {}
    for feature, pool in label_pool.items():
        pool.sort(key=lambda pair: -pair[0])
        seen: List[str] = []
        for _, token in pool:
            if token not in seen:
                seen.append(token)
            if len(seen) >= 6:
                break
        labels[str(feature)] = {
            "label": "fires on: " + ", ".join(repr(t) for t in seen[:4]),
            "topTokens": seen,
        }
    return leaves, {"saeFeatureLabels": labels}


def aggregate(leaves: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    total_tokens = sum(int(leaf["tokenCount"]) for leaf in leaves)
    total_active = sum(int(leaf["activePairs"]) for leaf in leaves)
    fired: Dict[int, int] = {}
    prompts: Dict[int, int] = {}
    max_act: Dict[int, int] = {}
    for leaf in leaves:
        for feature in leaf["features"]:
            f = int(feature["feature"])
            fired[f] = fired.get(f, 0) + int(feature["firedTokenCount"])
            prompts[f] = prompts.get(f, 0) + 1
            max_act[f] = max(max_act.get(f, 0), int(feature["maxActivationCenti"]))
    ordered = sorted(fired.keys(), key=lambda f: (-fired[f], f))[: int(LEAKAGE_POLICY["maxFeaturesReported"])]
    return {
        "kind": "sae-features",
        "promptCount": len(leaves),
        "tokenCount": total_tokens,
        "meanActiveFeaturesPerTokenMilli": div_round(total_active * SCORE_SCALE, total_tokens),
        "features": [
            {
                "feature": f,
                "firedTokenCount": fired[f],
                "firingRateMilli": div_round(fired[f] * SCORE_SCALE, total_tokens),
                "maxActivationCenti": max_act[f],
                "promptCount": prompts[f],
            }
            for f in ordered
        ],
    }
