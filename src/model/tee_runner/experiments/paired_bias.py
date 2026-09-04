"""paired-bias: probability gap for a target token between two minimally
different prompts (e.g. profession A vs profession B -> ' he')."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ..canonical import LOGPROB_SCALE, PROBABILITY_SCALE, SCORE_SCALE, div_round, fixed, mean_fixed
from ..llm import logprob_at, prob_at
from .common import RunContext, base_leaf, check_item_keys, check_prompt_length, check_single_token, require_str, residual_digests

LEAF_SCHEMA = "tee-ai-leaf/paired-bias/v1"


def validate_item(llm: Any, item: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    check_item_keys(item, ["promptA", "promptB", "targetToken"], errors, "item")
    a = require_str(item, "promptA", errors, "item")
    b = require_str(item, "promptB", errors, "item")
    target = require_str(item, "targetToken", errors, "item")
    cap = int(params["maxPromptTokens"])
    check_prompt_length(llm, a, cap, errors, "item.promptA")
    check_prompt_length(llm, b, cap, errors, "item.promptB")
    check_single_token(llm, target, errors, "item.targetToken")
    return errors


def run(ctx: RunContext, experiment: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    llm = ctx.llm
    items = experiment["items"]
    cap = int(experiment["params"]["maxPromptTokens"])
    seqs: List[List[int]] = []
    for item in items:
        seqs.append(llm.encode_prompt(item["promptA"], cap))
        seqs.append(llm.encode_prompt(item["promptB"], cap))
    targets = [llm.single_token_id(item["targetToken"]) for item in items]
    logits, hidden = llm.logits_and_hidden_batch(seqs)
    ctx.forward_passes += len(seqs)

    leaves: List[Dict[str, Any]] = []
    tokens: Dict[str, Dict[str, str]] = {}
    for index, (item, target) in enumerate(zip(items, targets)):
        la, lb = logits[2 * index], logits[2 * index + 1]
        pa, pb = fixed(prob_at(la, target), PROBABILITY_SCALE), fixed(prob_at(lb, target), PROBABILITY_SCALE)
        leaf = base_leaf(LEAF_SCHEMA, index, item)
        leaf.update(
            {
                "targetTokenId": target,
                "probABp": pa,
                "probBBp": pb,
                "logProbAMilli": fixed(logprob_at(la, target), LOGPROB_SCALE),
                "logProbBMilli": fixed(logprob_at(lb, target), LOGPROB_SCALE),
                "gapBp": pa - pb,
                "residualDigestsA": residual_digests(hidden[2 * index]),
                "residualDigestsB": residual_digests(hidden[2 * index + 1]),
            }
        )
        leaves.append(leaf)
        tokens[str(index)] = {"target": llm.decode_token(target)}
    return leaves, {"itemTokens": tokens}


def aggregate(leaves: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    n = len(leaves)
    gaps = [int(leaf["gapBp"]) for leaf in leaves]
    favoring_a = sum(1 for gap in gaps if gap > 0)
    return {
        "kind": "paired-bias",
        "scored": n,
        "meanSignedGapBp": mean_fixed(gaps),
        "meanAbsoluteGapBp": mean_fixed([abs(gap) for gap in gaps]),
        "favoringACount": favoring_a,
        "fractionFavoringAMilli": div_round(favoring_a * SCORE_SCALE, n),
    }
