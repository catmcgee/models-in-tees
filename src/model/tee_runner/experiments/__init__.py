"""Experiment kinds. Each module exports:

LEAF_SCHEMA            str
validate_item(llm, item, params) -> list[str]   (tokenizer-level checks)
run(ctx, experiment)   -> (leaves, descriptive) where every leaf is
                          canonical (integers/strings/bools only)
aggregate(leaves, params) -> metrics, a pure integer function of the leaves
"""

from __future__ import annotations

from . import (
    activation_patching,
    expected_token,
    linear_probe,
    memorization,
    paired_bias,
    sae_features,
)

KINDS = {
    "expected-token": expected_token,
    "memorization": memorization,
    "paired-bias": paired_bias,
    "linear-probe": linear_probe,
    "activation-patching": activation_patching,
    "sae-features": sae_features,
}
