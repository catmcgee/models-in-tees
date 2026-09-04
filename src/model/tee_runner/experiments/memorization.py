"""memorization: does greedy decoding reproduce a famous continuation?"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ..canonical import SCORE_SCALE, div_round, mean_fixed
from .common import RunContext, base_leaf, check_item_keys, check_prompt_length, require_str, residual_digests

LEAF_SCHEMA = "tee-ai-leaf/memorization/v1"


def validate_item(llm: Any, item: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    check_item_keys(item, ["prefix", "continuation"], errors, "item")
    prefix = require_str(item, "prefix", errors, "item")
    continuation = require_str(item, "continuation", errors, "item")
    check_prompt_length(llm, prefix, int(params["maxPrefixTokens"]), errors, "item.prefix")
    if continuation:
        ids = llm.encode_continuation(continuation)
        cap = int(params["maxContinuationTokens"])
        if not ids:
            errors.append("item.continuation tokenizes to nothing")
        elif len(ids) > cap:
            errors.append(f"item.continuation has {len(ids)} tokens, cap is {cap}")
    return errors


def run(ctx: RunContext, experiment: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    llm = ctx.llm
    items = experiment["items"]
    cap = int(experiment["params"]["maxPrefixTokens"])
    leaves: List[Dict[str, Any]] = []
    tokens: Dict[str, Dict[str, Any]] = {}
    for index, item in enumerate(items):
        prefix_ids = llm.encode_prompt(item["prefix"], cap)
        cont_ids = llm.encode_continuation(item["continuation"])
        generated = llm.greedy_continue(prefix_ids, len(cont_ids))
        hidden = llm.hidden_last_batch([prefix_ids])[0]
        ctx.forward_passes += len(cont_ids) + 1
        matched = 0
        for a, b in zip(generated, cont_ids):
            if a != b:
                break
            matched += 1
        verbatim = matched == len(cont_ids)
        leaf = base_leaf(LEAF_SCHEMA, index, item)
        leaf.update(
            {
                "prefixTokenCount": len(prefix_ids),
                "continuationTokenCount": len(cont_ids),
                "matchedTokenCount": matched,
                "matchedFractionMilli": div_round(matched * SCORE_SCALE, len(cont_ids)),
                "verbatim": verbatim,
                "firstMismatchPosition": -1 if verbatim else matched,
                "residualDigests": residual_digests(hidden),
            }
        )
        leaves.append(leaf)
        tokens[str(index)] = {
            "expected": [llm.decode_token(i) for i in cont_ids],
            "generated": [llm.decode_token(i) for i in generated],
        }
    return leaves, {"itemTokens": tokens}


def aggregate(leaves: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    n = len(leaves)
    verbatim = sum(1 for leaf in leaves if leaf["verbatim"])
    return {
        "kind": "memorization",
        "scored": n,
        "verbatimCount": verbatim,
        "verbatimRateMilli": div_round(verbatim * SCORE_SCALE, n),
        "meanMatchedFractionMilli": mean_fixed([int(leaf["matchedFractionMilli"]) for leaf in leaves]),
        "decoding": "greedy",
    }
