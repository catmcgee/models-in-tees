"""linear-probe: per-layer logistic-regression probe for a binary concept on
final-token hidden states. Probe weights never leave the runner; the leaf
carries only each example's predicted label per layer."""

from __future__ import annotations

import random
from typing import Any, Dict, List, Tuple

import torch

from ..canonical import SCORE_SCALE, div_round
from .common import RunContext, base_leaf, check_item_keys, check_prompt_length, require_str, residual_digests

LEAF_SCHEMA = "tee-ai-leaf/linear-probe/v1"


def validate_item(llm: Any, item: Dict[str, Any], params: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    check_item_keys(item, ["text", "label"], errors, "item")
    text = require_str(item, "text", errors, "item")
    label = item.get("label")
    if label not in (0, 1) or isinstance(label, bool):
        errors.append("item.label must be 0 or 1")
    check_prompt_length(llm, text, int(params["maxTextTokens"]), errors, "item.text")
    return errors


def _split(labels: List[int], test_percent: int, seed: int) -> List[str]:
    rng = random.Random(seed)
    test = set()
    for class_value in (0, 1):
        class_indices = [i for i, label in enumerate(labels) if label == class_value]
        rng.shuffle(class_indices)
        take = max(1, round(len(class_indices) * test_percent / 100))
        test.update(class_indices[:take])
    return ["test" if i in test else "train" for i in range(len(labels))]


def run(ctx: RunContext, experiment: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    llm = ctx.llm
    items = experiment["items"]
    params = experiment["params"]
    cap = int(params["maxTextTokens"])
    seed = int(params["seed"])
    steps = int(params["steps"])
    lr = int(params["learningRateMicro"]) / 1_000_000
    weight_decay = int(params["weightDecayMicro"]) / 1_000_000

    seqs = [llm.encode_prompt(item["text"], cap) for item in items]
    labels = [int(item["label"]) for item in items]
    features = torch.stack(llm.hidden_last_batch(seqs))  # [n, layers, d]
    ctx.forward_passes += len(seqs)
    split = _split(labels, int(params["testPercent"]), seed)
    train_idx = [i for i, s in enumerate(split) if s == "train"]
    label_tensor = torch.tensor(labels, dtype=torch.float32)
    train_y = label_tensor[train_idx]

    layer_count = int(features.shape[1])
    predictions = torch.zeros(len(items), layer_count, dtype=torch.long)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    for layer in range(layer_count):
        all_x = features[:, layer, :]
        train_x = all_x[train_idx]
        mean = train_x.mean(dim=0, keepdim=True)
        std = train_x.std(dim=0, keepdim=True).clamp(min=1e-6)
        train_x = (train_x - mean) / std
        torch.manual_seed(seed)
        weight = torch.zeros(train_x.shape[1], requires_grad=True)
        bias = torch.zeros(1, requires_grad=True)
        optimizer = torch.optim.Adam([weight, bias], lr=lr, weight_decay=weight_decay)
        with torch.enable_grad():
            for _ in range(steps):
                optimizer.zero_grad()
                loss = loss_fn(train_x @ weight + bias, train_y)
                loss.backward()
                optimizer.step()
        with torch.no_grad():
            logits = ((all_x - mean) / std) @ weight + bias
            predictions[:, layer] = (logits > 0).long()

    leaves: List[Dict[str, Any]] = []
    for index, item in enumerate(items):
        leaf = base_leaf(LEAF_SCHEMA, index, item)
        leaf.update(
            {
                "label": labels[index],
                "split": split[index],
                "predictionsByLayer": [int(v) for v in predictions[index].tolist()],
                "residualDigests": residual_digests(features[index]),
            }
        )
        leaves.append(leaf)
    return leaves, {}


def aggregate(leaves: List[Dict[str, Any]], params: Dict[str, Any]) -> Dict[str, Any]:
    layer_count = len(leaves[0]["predictionsByLayer"])
    test = [leaf for leaf in leaves if leaf["split"] == "test"]
    train = [leaf for leaf in leaves if leaf["split"] == "train"]
    layers = []
    for layer in range(layer_count):
        test_correct = sum(1 for leaf in test if leaf["predictionsByLayer"][layer] == leaf["label"])
        train_correct = sum(1 for leaf in train if leaf["predictionsByLayer"][layer] == leaf["label"])
        layers.append(
            {
                "layer": layer,
                "label": "embedding" if layer == 0 else ("final-norm" if layer == layer_count - 1 else f"block-{layer - 1}"),
                "testCorrect": test_correct,
                "testAccuracyMilli": div_round(test_correct * SCORE_SCALE, len(test)),
                "trainCorrect": train_correct,
                "trainAccuracyMilli": div_round(train_correct * SCORE_SCALE, len(train)),
            }
        )
    best = max(layers, key=lambda l: (l["testAccuracyMilli"], -l["layer"]))
    positives_test = sum(1 for leaf in test if leaf["label"] == 1)
    majority = max(positives_test, len(test) - positives_test)
    return {
        "kind": "linear-probe",
        "hiddenStateCount": layer_count,
        "bestLayer": best["layer"],
        "bestTestAccuracyMilli": best["testAccuracyMilli"],
        "majorityClassBaselineMilli": div_round(majority * SCORE_SCALE, len(test)),
        "counts": {
            "total": len(leaves),
            "train": len(train),
            "test": len(test),
            "positives": sum(1 for leaf in leaves if leaf["label"] == 1),
            "negatives": sum(1 for leaf in leaves if leaf["label"] == 0),
        },
        "layers": layers,
    }
