"""expected-token: does the model rank the expected next token first?"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ..canonical import LOGPROB_SCALE, PROBABILITY_SCALE, SCORE_SCALE, div_round, fixed, mean_fixed
from ..llm import argmax_id, logprob_at, prob_at, rank_of
from .common import RunContext, base_leaf, check_item_keys, check_prompt_length, check_single_token, require_str

LEAF_SCHEMA = "tee-ai-leaf/expected-token/v1"


def validate_item(llm: Any, item: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    check_item_keys(item, ["prompt", "expectedToken"], errors, "item")
    prompt = require_str(item, "prompt", errors, "item")
    target = require_str(item, "expectedToken", errors, "item")
    check_prompt_length(llm, prompt, int(params["maxPromptTokens"]), errors, "item.prompt")
    check_single_token(llm, target, errors, "item.expectedToken")
    return errors


def run(ctx: RunContext, experiment: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    llm = ctx.llm
    items = experiment["items"]
    cap = int(experiment["params"]["maxPromptTokens"])
    seqs = [llm.encode_prompt(item["prompt"], cap) for item in items]
    targets = [llm.single_token_id(item["expectedToken"]) for item in items]
    logits = llm.final_logits_batch(seqs)
    ctx.forward_passes += len(seqs)

    leaves: List[Dict[str, Any]] = []
    tokens: Dict[str, Dict[str, str]] = {}
    for index, (item, seq, target, lg) in enumerate(zip(items, seqs, targets, logits)):
        top1 = argmax_id(lg)
        leaf = base_leaf(LEAF_SCHEMA, index, item)
        leaf.update(
            {
                "promptTokenCount": len(seq),
                "targetTokenId": target,
                "targetRank": rank_of(lg, target),
                "targetProbBp": fixed(prob_at(lg, target), PROBABILITY_SCALE),
                "targetLogProbMilli": fixed(logprob_at(lg, target), LOGPROB_SCALE),
                "top1TokenId": top1,
                "top1Hit": top1 == target,
            }
        )
        leaves.append(leaf)
        tokens[str(index)] = {"target": llm.decode_token(target), "top1": llm.decode_token(top1)}
    return leaves, {"itemTokens": tokens}


def aggregate(leaves: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    n = len(leaves)
    ranks = sorted(int(leaf["targetRank"]) for leaf in leaves)
    top1 = sum(1 for leaf in leaves if leaf["top1Hit"])
    top5 = sum(1 for leaf in leaves if int(leaf["targetRank"]) <= 5)
    return {
        "kind": "expected-token",
        "scored": n,
        "top1Hits": top1,
        "top1AccuracyMilli": div_round(top1 * SCORE_SCALE, n),
        "top5Hits": top5,
        "top5AccuracyMilli": div_round(top5 * SCORE_SCALE, n),
        "medianTargetRank": ranks[n // 2],
        "meanTargetProbBp": mean_fixed([int(leaf["targetProbBp"]) for leaf in leaves]),
        "meanTargetLogProbMilli": mean_fixed([int(leaf["targetLogProbMilli"]) for leaf in leaves]),
    }
