"""Gemma Scope 2 JumpReLU sparse autoencoder (encoder side only).

Only w_enc, b_enc and threshold are loaded; the decoder is never needed for
feature statistics. The SAE is public (CC-BY-4.0) but its file hashes are
committed so a receipt names exactly which dictionary produced the report.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Optional

import torch

from . import paths
from .commitment import CommitmentError, resolve_snapshot, sae_commitment, sae_patterns


class SaeError(RuntimeError):
    pass


class JumpReluSae:
    def __init__(self, force_commitment: bool = False) -> None:
        from safetensors import safe_open

        self.repo_id = paths.SAE_REPO_ID
        self.subfolder = paths.SAE_SUBFOLDER
        match = re.search(r"layer_(\d+)", self.subfolder)
        if not match:
            raise SaeError(f"cannot parse layer from SAE subfolder {self.subfolder!r}")
        self.layer = int(match.group(1))
        self.hidden_state_index = self.layer + 1

        try:
            snapshot = resolve_snapshot(self.repo_id, paths.SAE_HUB_DIR, sae_patterns(self.subfolder))
        except CommitmentError as exc:
            raise SaeError(str(exc)) from exc
        folder = snapshot / self.subfolder
        self.config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        if self.config.get("architecture") != "jump_relu":
            raise SaeError(f"unsupported SAE architecture {self.config.get('architecture')!r}")
        expected_hook = f"model.layers.{self.layer}.output"
        if self.config.get("hf_hook_point_in") != expected_hook:
            raise SaeError(f"SAE hook {self.config.get('hf_hook_point_in')!r} != {expected_hook!r}")
        if self.config.get("model_name") and self.config["model_name"] != paths.LLM_MODEL_ID:
            raise SaeError(f"SAE was trained for {self.config['model_name']}, model is {paths.LLM_MODEL_ID}")

        with safe_open(str(folder / "params.safetensors"), framework="pt", device="cpu") as handle:
            self.w_enc = handle.get_tensor("w_enc").float()
            self.b_enc = handle.get_tensor("b_enc").float()
            self.threshold = handle.get_tensor("threshold").float()
        self.d_in = int(self.w_enc.shape[0])
        self.width = int(self.w_enc.shape[1])
        if self.width != int(self.config.get("width", self.width)):
            raise SaeError("SAE width mismatch between config.json and params.safetensors")
        self.commitment_record = sae_commitment(force=force_commitment)
        self.commitment = self.commitment_record["commitment"]

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        pre = x.float() @ self.w_enc + self.b_enc
        return pre * (pre > self.threshold)

    def info(self) -> Dict[str, Any]:
        return {
            "repoId": self.repo_id,
            "subfolder": self.subfolder,
            "commitment": self.commitment,
            "architecture": "jump_relu",
            "layer": self.layer,
            "hiddenStateIndex": self.hidden_state_index,
            "width": self.width,
            "dIn": self.d_in,
            "l0": int(self.config.get("l0", 0)),
            "license": "CC-BY-4.0",
        }

    def matches_params(self, sae_params: Dict[str, Any]) -> Optional[str]:
        checks = {
            "repoId": self.repo_id,
            "subfolder": self.subfolder,
            "layer": self.layer,
            "hiddenStateIndex": self.hidden_state_index,
            "width": self.width,
        }
        for key, expected in checks.items():
            if sae_params.get(key) != expected:
                return f"params.sae.{key} is {sae_params.get(key)!r}, configured SAE has {expected!r}"
        return None
