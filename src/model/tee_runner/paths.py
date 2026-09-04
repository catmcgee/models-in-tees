"""Filesystem and model identity configuration shared by the runner."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PRIVATE_DIR = ROOT / "private"

LLM_DIR = Path(os.environ.get("TEE_AI_LLM_DIR", PRIVATE_DIR / "llm"))
HF_HOME = Path(os.environ.get("HF_HOME", PRIVATE_DIR / "hf"))
SAE_DIR = Path(os.environ.get("TEE_AI_SAE_DIR", PRIVATE_DIR / "sae"))
SAE_HUB_DIR = SAE_DIR / "hub"
REGISTRY_DIR = Path(os.environ.get("TEE_AI_REGISTRY_DIR", ROOT / "src" / "experiments"))
TEST_VECTORS_PATH = ROOT / "src" / "shared" / "test-vectors.json"

LLM_MODEL_ID = os.environ.get("TEE_AI_LLM_MODEL_ID", "google/gemma-3-1b-pt")
SAE_REPO_ID = os.environ.get("TEE_AI_SAE_REPO", "google/gemma-scope-2-1b-pt")
SAE_SUBFOLDER = os.environ.get("TEE_AI_SAE_SUBFOLDER", "resid_post/layer_13_width_16k_l0_medium")

MODEL_COMMITMENT_CACHE = LLM_DIR / "commitment.json"
SAE_COMMITMENT_CACHE = SAE_DIR / "commitment.json"

os.environ.setdefault("HF_HOME", str(HF_HOME))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
