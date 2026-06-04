#!/usr/bin/env python3
"""Private GPT runner for the TEE demo.

The public API talks to this file as a subprocess. GPT-2 files are cached under
private/llm and are never returned over stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import torch
except ModuleNotFoundError as exc:
    print(
        json.dumps(
            {
                "ok": False,
                "error": "Missing Python ML dependency. Run: python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt",
                "detail": str(exc),
            }
        ),
        file=sys.stderr,
    )
    raise


ROOT = Path(__file__).resolve().parents[2]
LLM_DIR = Path(os.environ.get("TEE_AI_LLM_DIR", ROOT / "private" / "llm"))
HF_HOME = Path(os.environ.get("HF_HOME", ROOT / "private" / "hf"))
LLM_MODEL_ID = os.environ.get("TEE_AI_LLM_MODEL_ID", "gpt2")
os.environ.setdefault("HF_HOME", str(HF_HOME))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

LLM_ARCHITECTURE = {
    "family": "gpt2-causal-language-model",
    "model_id": LLM_MODEL_ID,
    "runtime": "huggingface-transformers",
    "weights": "local-cache-private",
    "input": "byte-pair encoding tokens",
    "output": "autoregressive text generation",
}

_LLM_CACHE: Optional[Tuple[Any, Any]] = None
_LLM_COMMITMENT: Optional[str] = None


def load_llm() -> Tuple[Any, Any]:
    global _LLM_CACHE
    if _LLM_CACHE is not None:
        return _LLM_CACHE

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Missing GPT-2 dependency. Run: pip install -r requirements.txt"
        ) from exc

    LLM_DIR.mkdir(parents=True, exist_ok=True)
    HF_HOME.mkdir(parents=True, exist_ok=True)
    tokenizer = AutoTokenizer.from_pretrained(LLM_MODEL_ID, cache_dir=str(LLM_DIR))
    model = AutoModelForCausalLM.from_pretrained(
        LLM_MODEL_ID,
        cache_dir=str(LLM_DIR),
        attn_implementation="eager",
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model.eval()
    _LLM_CACHE = (tokenizer, model)
    return _LLM_CACHE


def iter_llm_files() -> List[Path]:
    if not LLM_DIR.exists():
        return []
    skipped = {".lock", ".tmp", ".incomplete"}
    return sorted(
        path
        for path in LLM_DIR.rglob("*")
        if path.is_file() and not any(str(path).endswith(suffix) for suffix in skipped)
    )


def llm_commitment() -> str:
    global _LLM_COMMITMENT
    if _LLM_COMMITMENT is not None:
        return _LLM_COMMITMENT
    load_llm()
    digest = hashlib.sha256()
    digest.update(json.dumps(LLM_ARCHITECTURE, sort_keys=True).encode("utf-8"))
    files = iter_llm_files()
    if not files:
        digest.update(LLM_MODEL_ID.encode("utf-8"))
    for file in files:
        digest.update(str(file.relative_to(LLM_DIR)).encode("utf-8"))
        digest.update(file.read_bytes())
    _LLM_COMMITMENT = digest.hexdigest()
    return _LLM_COMMITMENT


def llm_info() -> Dict[str, Any]:
    tokenizer, model = load_llm()
    config = getattr(model, "config", None)
    return {
        "architecture": {
            **LLM_ARCHITECTURE,
            "n_layer": getattr(config, "n_layer", None),
            "n_head": getattr(config, "n_head", None),
            "n_embd": getattr(config, "n_embd", None),
            "vocab_size": getattr(config, "vocab_size", None),
            "context_window": getattr(config, "n_positions", None),
        },
        "commitment": llm_commitment(),
        "weights_path": str(LLM_DIR.relative_to(ROOT)),
        "weights_public": False,
        "meta": {
            "model_id": LLM_MODEL_ID,
            "tokenizer": tokenizer.__class__.__name__,
            "model": model.__class__.__name__,
            "cache_files": len(iter_llm_files()),
        },
    }


def generate_text(payload: Dict[str, Any]) -> Dict[str, Any]:
    tokenizer, model = load_llm()
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        return {"ok": False, "error": "Prompt is required."}

    max_new_tokens = clamp_int(payload.get("maxNewTokens"), 8, 180, 80)
    temperature = clamp_float(payload.get("temperature"), 0.1, 1.5, 0.75)
    top_p = clamp_float(payload.get("topP"), 0.1, 1.0, 0.92)
    seed = payload.get("seed")
    if seed is not None:
        try:
            torch.manual_seed(int(seed))
        except (TypeError, ValueError):
            pass

    started = time.perf_counter()
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=768)
    with torch.no_grad():
        generated = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=True,
            temperature=temperature,
            top_p=top_p,
            pad_token_id=tokenizer.eos_token_id,
        )
    decoded = tokenizer.decode(generated[0], skip_special_tokens=True)
    output = decoded[len(prompt) :].strip() if decoded.startswith(prompt) else decoded.strip()
    if not output:
        output = decoded.strip()
    latency_ms = (time.perf_counter() - started) * 1000.0
    prompt_tokens = int(inputs["input_ids"].shape[-1])
    generated_tokens = int(generated.shape[-1] - prompt_tokens)

    return {
        "ok": True,
        "model": llm_info(),
        "promptHash": sha256_hex(prompt.encode("utf-8")),
        "output": output,
        "outputHash": sha256_hex(output.encode("utf-8")),
        "latencyMs": round(latency_ms, 3),
        "tokenCount": {
            "prompt": prompt_tokens,
            "generated": max(generated_tokens, 0),
        },
        "params": {
            "maxNewTokens": max_new_tokens,
            "temperature": round(temperature, 3),
            "topP": round(top_p, 3),
        },
    }


def interpret_model(payload: Dict[str, Any]) -> Dict[str, Any]:
    tokenizer, model = load_llm()
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        return {"ok": False, "error": "Prompt is required."}

    corrupted_prompt = str(payload.get("corruptedPrompt", "")).strip()
    target_text = str(payload.get("targetToken", ""))
    if not target_text.strip():
        target_text = ""
    top_k = clamp_int(payload.get("topK"), 1, 5, 5)
    max_length = clamp_int(payload.get("maxPromptTokens"), 16, 192, 128)

    started = time.perf_counter()
    clean_inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=max_length)
    with torch.no_grad():
        clean_outputs = model(
            **clean_inputs,
            output_hidden_states=True,
            output_attentions=True,
            use_cache=False,
        )

    clean_logits = clean_outputs.logits[0, -1, :]
    target_id = resolve_target_token_id(tokenizer, clean_logits, target_text)
    target_token = tokenizer.decode([target_id])

    lens_layers = build_logit_lens(tokenizer, model, clean_outputs.hidden_states, target_id, top_k)
    attention = summarize_attention(tokenizer, clean_inputs["input_ids"][0], clean_outputs.attentions)

    patching = None
    if corrupted_prompt:
        patching = activation_patch_scores(
            tokenizer,
            model,
            corrupted_prompt,
            clean_outputs.hidden_states,
            target_id,
            max_length,
        )

    result = {
        "ok": True,
        "model": llm_info(),
        "promptHash": sha256_hex(prompt.encode("utf-8")),
        "corruptedPromptHash": sha256_hex(corrupted_prompt.encode("utf-8"))
        if corrupted_prompt
        else None,
        "target": {
            "token": target_token,
            "tokenId": target_id,
            "source": "user" if target_text else "clean-final-argmax",
            "cleanLogProb": round(logprob_for_token(clean_logits, target_id), 6),
        },
        "lens": {
            "topK": top_k,
            "position": int(clean_inputs["input_ids"].shape[-1] - 1),
            "layers": lens_layers,
        },
        "attention": attention,
        "patching": patching,
        "params": {
            "topK": top_k,
            "maxPromptTokens": max_length,
            "rawActivationsReturned": False,
            "rawAttentionReturned": False,
            "weightsReturned": False,
        },
        "redaction": {
            "exposes": [
                "top-k logit-lens tokens",
                "target-token ranks and probabilities",
                "per-head aggregate attention summaries",
                "layer-level patching recovery scores",
                "hashes and signed receipt metadata",
            ],
            "withholds": [
                "model weights",
                "raw hidden-state vectors",
                "raw attention tensors",
                "MLP activations",
                "projection matrices",
                "gradients",
            ],
        },
        "latencyMs": 0,
    }
    result["latencyMs"] = round((time.perf_counter() - started) * 1000.0, 3)
    result["resultHash"] = sha256_hex(
        json.dumps(result_without_model(result), sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    )
    return result


def build_logit_lens(
    tokenizer: Any,
    model: Any,
    hidden_states: Tuple[Any, ...],
    target_id: int,
    top_k: int,
) -> List[Dict[str, Any]]:
    layers: List[Dict[str, Any]] = []
    with torch.no_grad():
        for index, hidden in enumerate(hidden_states):
            projected_hidden = hidden if index == len(hidden_states) - 1 else model.transformer.ln_f(hidden)
            logits = model.lm_head(projected_hidden)[0, -1, :]
            probs = torch.softmax(logits, dim=-1)
            top = torch.topk(probs, k=top_k)
            target_logit = logits[target_id]
            target_prob = probs[target_id]
            rank = int((logits > target_logit).sum().item() + 1)
            layers.append(
                {
                    "layer": index,
                    "label": "embedding" if index == 0 else f"block-{index}",
                    "topTokens": [
                        {
                            "rank": rank_index + 1,
                            "token": tokenizer.decode([int(token_id)]),
                            "tokenId": int(token_id),
                            "probability": round(float(prob), 6),
                        }
                        for rank_index, (token_id, prob) in enumerate(
                            zip(top.indices.tolist(), top.values.tolist())
                        )
                    ],
                    "target": {
                        "rank": rank,
                        "probability": round(float(target_prob), 6),
                        "logit": round(float(target_logit), 4),
                    },
                }
            )
    return layers


def summarize_attention(
    tokenizer: Any,
    input_ids: Any,
    attentions: Optional[Tuple[Any, ...]],
) -> Dict[str, Any]:
    if not attentions:
        return {"available": False, "layers": []}

    tokens = [tokenizer.decode([int(token_id)]) for token_id in input_ids.tolist()]
    layers: List[Dict[str, Any]] = []
    for layer_index, layer_attention in enumerate(attentions):
        if layer_attention is None:
            continue
        # Shape: batch, heads, query_position, key_position. Only summarize the
        # final-token query so no full attention tensor leaves the TEE.
        final_attention = layer_attention[0, :, -1, :]
        head_summaries: List[Dict[str, Any]] = []
        entropies: List[float] = []
        for head_index, weights in enumerate(final_attention):
            safe_weights = torch.clamp(weights, min=1e-12)
            entropy = float(-(safe_weights * torch.log(safe_weights)).sum().item())
            max_index = int(torch.argmax(weights).item())
            max_attention = float(weights[max_index].item())
            entropies.append(entropy)
            head_summaries.append(
                {
                    "head": head_index,
                    "focusPosition": max_index,
                    "focusToken": tokens[max_index] if max_index < len(tokens) else "",
                    "maxAttention": round(max_attention, 6),
                    "entropy": round(entropy, 4),
                }
            )
        focused_heads = sorted(
            head_summaries,
            key=lambda item: (item["maxAttention"], -item["entropy"]),
            reverse=True,
        )[:3]
        layers.append(
            {
                "layer": layer_index + 1,
                "meanEntropy": round(sum(entropies) / max(len(entropies), 1), 4),
                "focusedHeads": focused_heads,
            }
        )
    return {
        "available": bool(layers),
        "position": int(len(tokens) - 1),
        "tokenCount": int(len(tokens)),
        "layers": layers,
    }


def activation_patch_scores(
    tokenizer: Any,
    model: Any,
    corrupted_prompt: str,
    clean_hidden_states: Tuple[Any, ...],
    target_id: int,
    max_length: int,
) -> Dict[str, Any]:
    corrupted_inputs = tokenizer(
        corrupted_prompt, return_tensors="pt", truncation=True, max_length=max_length
    )
    with torch.no_grad():
        clean_final_logits = model.lm_head(clean_hidden_states[-1])[0, -1, :]
        corrupted_outputs = model(
            **corrupted_inputs,
            output_hidden_states=True,
            use_cache=False,
        )
        corrupted_logits = corrupted_outputs.logits[0, -1, :]

    clean_logprob = logprob_for_token(clean_final_logits, target_id)
    corrupted_logprob = logprob_for_token(corrupted_logits, target_id)
    denominator = clean_logprob - corrupted_logprob
    layers: List[Dict[str, Any]] = []

    for layer_index in range(len(model.transformer.h)):
        clean_layer_hidden = clean_hidden_states[layer_index + 1].detach()

        def patch_hook(_module: Any, _inputs: Any, output: Any) -> Any:
            hidden = output[0] if isinstance(output, tuple) else output
            patched = hidden.clone()
            patched[:, -1, :] = clean_layer_hidden[:, -1, :]
            if isinstance(output, tuple):
                return (patched, *output[1:])
            return patched

        handle = model.transformer.h[layer_index].register_forward_hook(patch_hook)
        try:
            with torch.no_grad():
                patched_outputs = model(**corrupted_inputs, use_cache=False)
                patched_logits = patched_outputs.logits[0, -1, :]
        finally:
            handle.remove()

        patched_logprob = logprob_for_token(patched_logits, target_id)
        recovery = 0.0 if abs(denominator) < 1e-9 else (patched_logprob - corrupted_logprob) / denominator
        layers.append(
            {
                "layer": layer_index + 1,
                "targetLogProb": round(float(patched_logprob), 6),
                "recovery": round(float(recovery), 6),
                "clippedRecovery": round(float(max(0.0, min(1.0, recovery))), 6),
            }
        )

    return {
        "available": True,
        "cleanLogProb": round(float(clean_logprob), 6),
        "corruptedLogProb": round(float(corrupted_logprob), 6),
        "layers": layers,
    }


def resolve_target_token_id(tokenizer: Any, clean_logits: Any, target_text: str) -> int:
    if target_text:
        token_ids = tokenizer.encode(target_text, add_special_tokens=False)
        if not token_ids and not target_text.startswith(" "):
            token_ids = tokenizer.encode(f" {target_text}", add_special_tokens=False)
        if token_ids:
            return int(token_ids[0])
    return int(torch.argmax(clean_logits).item())


def logprob_for_token(logits: Any, token_id: int) -> float:
    return float(torch.log_softmax(logits, dim=-1)[token_id].item())


def result_without_model(result: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in result.items() if key not in {"model", "latencyMs", "resultHash"}}


def selftest() -> Dict[str, Any]:
    result = generate_text(
        {
            "prompt": "Explain private GPT-2 receipts in one sentence.",
            "maxNewTokens": 16,
            "temperature": 0.7,
            "topP": 0.9,
            "seed": 20260603,
        }
    )
    passed = bool(result.get("ok") and result.get("output"))
    result["selftest"] = {"passed": passed, "minGeneratedTokens": 1}
    return result


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def clamp_int(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def clamp_float(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def read_json_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def emit(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command", choices=["info", "llm-info", "generate", "interpret", "selftest"]
    )
    args = parser.parse_args()

    if args.command in {"info", "llm-info"}:
        emit({"ok": True, "info": llm_info()})
        return

    if args.command == "generate":
        payload = read_json_stdin()
        if not isinstance(payload, dict):
            emit({"ok": False, "error": "Expected a JSON object."})
            sys.exit(2)
        result = generate_text(payload)
        emit(result)
        if not result.get("ok"):
            sys.exit(2)
        return

    if args.command == "interpret":
        payload = read_json_stdin()
        if not isinstance(payload, dict):
            emit({"ok": False, "error": "Expected a JSON object."})
            sys.exit(2)
        result = interpret_model(payload)
        emit(result)
        if not result.get("ok"):
            sys.exit(2)
        return

    if args.command == "selftest":
        result = selftest()
        emit(result)
        if not result.get("selftest", {}).get("passed"):
            sys.exit(1)


if __name__ == "__main__":
    main()
