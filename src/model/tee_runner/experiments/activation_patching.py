"""activation-patching: residual-stream patching at the final position.

For each pair, the clean prompt's per-layer final-position residual is
patched into the corrupted prompt's forward pass, one layer at a time. All
layers are patched in a single batched forward: row i of the batch carries
the patch for layer i.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import torch

from ..canonical import LOGPROB_SCALE, SCORE_SCALE, div_round, fixed, isqrt, mean_fixed
from ..llm import logprob_at
from .common import RunContext, base_leaf, check_item_keys, check_prompt_length, check_single_token, require_str

LEAF_SCHEMA = "tee-ai-leaf/activation-patching/v1"
SCORABLE_EPSILON = 1e-4


def validate_item(llm: Any, item: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    check_item_keys(item, ["cleanPrompt", "corruptedPrompt", "targetToken"], errors, "item")
    clean = require_str(item, "cleanPrompt", errors, "item")
    corrupted = require_str(item, "corruptedPrompt", errors, "item")
    target = require_str(item, "targetToken", errors, "item")
    cap = int(params["maxPromptTokens"])
    check_prompt_length(llm, clean, cap, errors, "item.cleanPrompt")
    check_prompt_length(llm, corrupted, cap, errors, "item.corruptedPrompt")
    check_single_token(llm, target, errors, "item.targetToken")
    if params.get("position") != "final":
        errors.append("params.position must be 'final'")
    return errors


def _hidden_of(output: Any) -> torch.Tensor:
    return output[0] if isinstance(output, tuple) else output


def _with_hidden(output: Any, hidden: torch.Tensor) -> Any:
    return (hidden, *output[1:]) if isinstance(output, tuple) else hidden


def _patch_pair(llm: Any, clean_ids: List[int], corrupted_ids: List[int], target: int) -> Dict[str, Any]:
    layers = list(llm.layers())
    layer_count = len(layers)
    clean_final: List[torch.Tensor] = [torch.empty(0)] * layer_count

    def recorder(layer_index: int):
        def hook(_module: Any, _inputs: Any, output: Any) -> None:
            clean_final[layer_index] = _hidden_of(output)[0, -1, :].detach().clone()

        return hook

    handles = [layer.register_forward_hook(recorder(i)) for i, layer in enumerate(layers)]
    try:
        with torch.no_grad():
            clean_logits = llm.model(
                input_ids=torch.tensor([clean_ids]), use_cache=False, logits_to_keep=1
            ).logits[0, -1, :].float()
    finally:
        for handle in handles:
            handle.remove()

    with torch.no_grad():
        corrupted_logits = llm.model(
            input_ids=torch.tensor([corrupted_ids]), use_cache=False, logits_to_keep=1
        ).logits[0, -1, :].float()

    def patcher(layer_index: int):
        def hook(_module: Any, _inputs: Any, output: Any) -> Any:
            hidden = _hidden_of(output).clone()
            hidden[layer_index, -1, :] = clean_final[layer_index].to(hidden.dtype)
            return _with_hidden(output, hidden)

        return hook

    handles = [layer.register_forward_hook(patcher(i)) for i, layer in enumerate(layers)]
    try:
        with torch.no_grad():
            batch = torch.tensor([corrupted_ids] * layer_count)
            patched_logits = llm.model(input_ids=batch, use_cache=False, logits_to_keep=1).logits[:, -1, :].float()
    finally:
        for handle in handles:
            handle.remove()

    clean_lp = logprob_at(clean_logits, target)
    corrupted_lp = logprob_at(corrupted_logits, target)
    denominator = clean_lp - corrupted_lp
    scorable = abs(denominator) >= SCORABLE_EPSILON
    patched: List[int] = []
    recovery: List[int] = []
    clipped: List[int] = []
    for layer_index in range(layer_count):
        lp = logprob_at(patched_logits[layer_index], target)
        rec = (lp - corrupted_lp) / denominator if scorable else 0.0
        patched.append(fixed(lp, LOGPROB_SCALE))
        recovery.append(fixed(rec, SCORE_SCALE))
        clipped.append(max(0, min(SCORE_SCALE, fixed(rec, SCORE_SCALE))))
    return {
        "cleanLogProbMilli": fixed(clean_lp, LOGPROB_SCALE),
        "corruptedLogProbMilli": fixed(corrupted_lp, LOGPROB_SCALE),
        "scorable": bool(scorable),
        "patchedLogProbMilliByLayer": patched,
        "recoveryMilliByLayer": recovery,
        "clippedRecoveryMilliByLayer": clipped,
    }


def run(ctx: RunContext, experiment: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    llm = ctx.llm
    cap = int(experiment["params"]["maxPromptTokens"])
    leaves: List[Dict[str, Any]] = []
    tokens: Dict[str, Dict[str, str]] = {}
    for index, item in enumerate(experiment["items"]):
        clean_ids = llm.encode_prompt(item["cleanPrompt"], cap)
        corrupted_ids = llm.encode_prompt(item["corruptedPrompt"], cap)
        target = llm.single_token_id(item["targetToken"])
        scores = _patch_pair(llm, clean_ids, corrupted_ids, target)
        ctx.forward_passes += 3
        leaf = base_leaf(LEAF_SCHEMA, index, item)
        leaf["targetTokenId"] = target
        leaf.update(scores)
        leaves.append(leaf)
        tokens[str(index)] = {"target": llm.decode_token(target)}
    return leaves, {"itemTokens": tokens}


def aggregate(leaves: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    scorable = [leaf for leaf in leaves if leaf["scorable"]]
    layer_count = len(leaves[0]["clippedRecoveryMilliByLayer"])
    layers = []
    for layer in range(layer_count):
        values = [int(leaf["clippedRecoveryMilliByLayer"][layer]) for leaf in scorable]
        if values:
            mean = mean_fixed(values)
            variance = div_round(sum((v - mean) ** 2 for v in values), len(values))
            layers.append(
                {
                    "layer": layer,
                    "meanClippedRecoveryMilli": mean,
                    "stdClippedRecoveryMilli": isqrt(variance),
                    "minClippedRecoveryMilli": min(values),
                    "maxClippedRecoveryMilli": max(values),
                }
            )
        else:
            layers.append(
                {
                    "layer": layer,
                    "meanClippedRecoveryMilli": 0,
                    "stdClippedRecoveryMilli": 0,
                    "minClippedRecoveryMilli": 0,
                    "maxClippedRecoveryMilli": 0,
                }
            )
    best = max(layers, key=lambda l: (l["meanClippedRecoveryMilli"], -l["layer"]))
    return {
        "kind": "activation-patching",
        "scored": len(scorable),
        "unscorable": len(leaves) - len(scorable),
        "bestLayer": best["layer"],
        "bestMeanClippedRecoveryMilli": best["meanClippedRecoveryMilli"],
        "meanCleanLogProbMilli": mean_fixed([int(leaf["cleanLogProbMilli"]) for leaf in scorable]),
        "meanCorruptedLogProbMilli": mean_fixed([int(leaf["corruptedLogProbMilli"]) for leaf in scorable]),
        "layers": layers,
    }
