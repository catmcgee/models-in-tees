"""Sealed model wrapper: loads Gemma once and exposes the few primitives the
experiments need. No raw activations, attentions, or weights leave this
module except through the experiment leaf schemas.
"""

from __future__ import annotations

import os
import platform
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import torch

from . import paths
from .commitment import model_commitment, public_manifest


class TokenizationError(ValueError):
    pass


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "") in ("1", "true", "yes")


class LLM:
    def __init__(self, force_commitment: bool = False) -> None:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        started = time.perf_counter()
        threads = int(os.environ.get("TEE_AI_TORCH_THREADS") or (os.cpu_count() or 1))
        torch.set_num_threads(max(1, threads))
        torch.manual_seed(0)
        try:
            torch.use_deterministic_algorithms(True, warn_only=True)
        except Exception:  # pragma: no cover - older torch
            pass

        offline = _bool_env("HF_HUB_OFFLINE")
        paths.LLM_DIR.mkdir(parents=True, exist_ok=True)
        self.tokenizer = AutoTokenizer.from_pretrained(
            paths.LLM_MODEL_ID, cache_dir=str(paths.LLM_DIR), local_files_only=offline
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            paths.LLM_MODEL_ID,
            cache_dir=str(paths.LLM_DIR),
            local_files_only=offline,
            torch_dtype=torch.float32,
            attn_implementation="sdpa",
        )
        self.model.eval()
        self.model.requires_grad_(False)
        self.config = self.model.config
        self.bos_token_id = int(self.tokenizer.bos_token_id)
        self.commitment_record = model_commitment(force=force_commitment)
        self.commitment = self.commitment_record["commitment"]
        self.load_ms = int((time.perf_counter() - started) * 1000)
        self.threads = threads

    # --- identity ------------------------------------------------------

    def architecture(self) -> Dict[str, Any]:
        cfg = self.config
        return {
            "family": "gemma3",
            "modelType": str(getattr(cfg, "model_type", "")),
            "modelClass": type(self.model).__name__,
            "numHiddenLayers": int(cfg.num_hidden_layers),
            "hiddenSize": int(cfg.hidden_size),
            "numAttentionHeads": int(cfg.num_attention_heads),
            "numKeyValueHeads": int(getattr(cfg, "num_key_value_heads", cfg.num_attention_heads)),
            "headDim": int(getattr(cfg, "head_dim", cfg.hidden_size // cfg.num_attention_heads)),
            "vocabSize": int(cfg.vocab_size),
            "slidingWindow": int(getattr(cfg, "sliding_window", 0) or 0),
            "maxPositionEmbeddings": int(cfg.max_position_embeddings),
            "bosTokenId": self.bos_token_id,
            "tiedEmbeddings": bool(getattr(cfg, "tie_word_embeddings", True)),
            "hiddenStateCount": int(cfg.num_hidden_layers) + 1,
        }

    def runtime(self) -> Dict[str, Any]:
        import safetensors
        import transformers

        return {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "safetensors": safetensors.__version__,
            "dtype": "float32",
            "device": "cpu",
            "attnImplementation": "sdpa",
            "threads": self.threads,
            "bosAdded": True,
        }

    def info(self) -> Dict[str, Any]:
        manifest = public_manifest(self.commitment_record)
        return {
            "modelId": paths.LLM_MODEL_ID,
            "commitment": self.commitment,
            "weightsPublic": False,
            "architecture": self.architecture(),
            "runtime": self.runtime(),
            "files": manifest["files"],
        }

    # --- tokenization --------------------------------------------------

    def encode_prompt(self, text: str, max_tokens: int) -> List[int]:
        ids = self.tokenizer.encode(text, add_special_tokens=False)
        ids = [self.bos_token_id] + [int(i) for i in ids]
        if len(ids) > max_tokens:
            raise TokenizationError(f"prompt has {len(ids)} tokens, cap is {max_tokens}")
        if len(ids) < 2:
            raise TokenizationError("prompt is empty")
        return ids

    def encode_continuation(self, text: str) -> List[int]:
        return [int(i) for i in self.tokenizer.encode(text, add_special_tokens=False)]

    def single_token_id(self, text: str) -> int:
        ids = self.encode_continuation(text)
        if len(ids) != 1:
            pieces = [self.tokenizer.decode([i]) for i in ids]
            raise TokenizationError(
                f"target {text!r} tokenizes to {len(ids)} tokens {pieces}; targets must be exactly one token"
            )
        return ids[0]

    def decode_token(self, token_id: int) -> str:
        return self.tokenizer.convert_ids_to_tokens([int(token_id)])[0]

    # --- forward passes ----------------------------------------------------

    def layers(self) -> Sequence[torch.nn.Module]:
        return self.model.model.layers[: self.config.num_hidden_layers]

    @staticmethod
    def _group_by_length(seqs: List[List[int]]) -> Dict[int, List[int]]:
        groups: Dict[int, List[int]] = {}
        for index, seq in enumerate(seqs):
            groups.setdefault(len(seq), []).append(index)
        return groups

    def final_logits_batch(self, seqs: List[List[int]]) -> List[torch.Tensor]:
        """Final-position logits for each sequence; batched by equal length."""
        out: List[Optional[torch.Tensor]] = [None] * len(seqs)
        with torch.no_grad():
            for _, indices in self._group_by_length(seqs).items():
                input_ids = torch.tensor([seqs[i] for i in indices], dtype=torch.long)
                result = self.model(input_ids=input_ids, use_cache=False, logits_to_keep=1)
                logits = result.logits[:, -1, :].float()
                for row, index in enumerate(indices):
                    out[index] = logits[row].clone()
        return [t for t in out if t is not None]

    def hidden_last_batch(self, seqs: List[List[int]]) -> List[torch.Tensor]:
        """[hiddenStateCount, d_model] final-position hidden states per sequence."""
        out: List[Optional[torch.Tensor]] = [None] * len(seqs)
        with torch.no_grad():
            for _, indices in self._group_by_length(seqs).items():
                input_ids = torch.tensor([seqs[i] for i in indices], dtype=torch.long)
                result = self.model(
                    input_ids=input_ids,
                    use_cache=False,
                    output_hidden_states=True,
                    logits_to_keep=1,
                )
                stacked = torch.stack([h[:, -1, :] for h in result.hidden_states], dim=1).float()
                for row, index in enumerate(indices):
                    out[index] = stacked[row].clone()
        return [t for t in out if t is not None]

    def hidden_states_single(self, seq: List[int]) -> Tuple[torch.Tensor, ...]:
        """All-position hidden states for one sequence (tuple of [1, T, d])."""
        with torch.no_grad():
            result = self.model(
                input_ids=torch.tensor([seq], dtype=torch.long),
                use_cache=False,
                output_hidden_states=True,
                logits_to_keep=1,
            )
        return tuple(h.float() for h in result.hidden_states)

    def greedy_continue(self, seq: List[int], steps: int) -> List[int]:
        """Greedy decoding without a KV cache (deterministic, no generate())."""
        current = list(seq)
        generated: List[int] = []
        with torch.no_grad():
            for _ in range(steps):
                result = self.model(
                    input_ids=torch.tensor([current], dtype=torch.long),
                    use_cache=False,
                    logits_to_keep=1,
                )
                next_id = int(torch.argmax(result.logits[0, -1, :]).item())
                generated.append(next_id)
                current.append(next_id)
        return generated


# --- logit helpers ------------------------------------------------------------


def log_softmax(logits: torch.Tensor) -> torch.Tensor:
    return torch.log_softmax(logits.float(), dim=-1)


def logprob_at(logits: torch.Tensor, token_id: int) -> float:
    return float(log_softmax(logits)[token_id].item())


def prob_at(logits: torch.Tensor, token_id: int) -> float:
    return float(torch.softmax(logits.float(), dim=-1)[token_id].item())


def rank_of(logits: torch.Tensor, token_id: int) -> int:
    return int((logits > logits[token_id]).sum().item()) + 1


def argmax_id(logits: torch.Tensor) -> int:
    return int(torch.argmax(logits).item())


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)
