#!/usr/bin/env python3
"""Download the sealed model and the Gemma Scope SAE into private/.

This is the only place in the project that talks to the Hugging Face Hub.
The runner itself always runs with HF_HUB_OFFLINE=1 and reads from the
snapshot this script produces. Weights never leave private/.

Usage:
  .venv/bin/python scripts/fetch_artifacts.py            # model + SAE
  .venv/bin/python scripts/fetch_artifacts.py --sae-only
  .venv/bin/python scripts/fetch_artifacts.py --model-only

Environment:
  HF_TOKEN                   token with access to the gated Gemma repo
  TEE_AI_LLM_MODEL_ID        default google/gemma-3-1b-pt
  TEE_AI_SAE_REPO            default google/gemma-scope-2-1b-pt
  TEE_AI_SAE_SUBFOLDER       default resid_post/layer_13_width_16k_l0_medium
  TEE_AI_LLM_DIR / TEE_AI_SAE_DIR / HF_HOME  override private/ locations
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "model"))

os.environ.setdefault("HF_HOME", str(ROOT / "private" / "hf"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.pop("HF_HUB_OFFLINE", None)

from tee_runner import paths  # noqa: E402
from tee_runner.commitment import model_commitment, sae_commitment  # noqa: E402

MODEL_ALLOW_PATTERNS = [
    "config.json",
    "generation_config.json",
    "*.safetensors",
    "model.safetensors.index.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
]


def fetch_model() -> None:
    from huggingface_hub import snapshot_download

    token = os.environ.get("HF_TOKEN") or None
    print(f"[fetch] model {paths.LLM_MODEL_ID} -> {paths.LLM_DIR}", file=sys.stderr)
    snapshot_download(
        paths.LLM_MODEL_ID,
        cache_dir=str(paths.LLM_DIR),
        allow_patterns=MODEL_ALLOW_PATTERNS,
        token=token,
    )
    info = model_commitment(force=True)
    print(f"[fetch] model commitment {info['commitment']}", file=sys.stderr)


def fetch_sae() -> None:
    from huggingface_hub import hf_hub_download

    token = os.environ.get("HF_TOKEN") or None
    print(
        f"[fetch] sae {paths.SAE_REPO_ID}/{paths.SAE_SUBFOLDER} -> {paths.SAE_HUB_DIR}",
        file=sys.stderr,
    )
    for filename in ("config.json", "params.safetensors"):
        hf_hub_download(
            paths.SAE_REPO_ID,
            f"{paths.SAE_SUBFOLDER}/{filename}",
            cache_dir=str(paths.SAE_HUB_DIR),
            token=token,
        )
    info = sae_commitment(force=True)
    print(f"[fetch] sae commitment {info['commitment']}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-only", action="store_true")
    parser.add_argument("--sae-only", action="store_true")
    args = parser.parse_args()
    if not args.sae_only:
        fetch_model()
    if not args.model_only:
        fetch_sae()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
