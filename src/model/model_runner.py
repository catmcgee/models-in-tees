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

SAE_DIR = Path(os.environ.get("TEE_AI_SAE_DIR", ROOT / "private" / "sae"))

# Capped-detail leakage policy. Detail caps (coarse numbers, small top-k,
# aggregate-only suites) are enforced here, inside the runner, because quotas
# alone are trivially evaded with new identities. The policy object is included
# in every result, so its hash is bound into the signed receipt.
LEAKAGE_POLICY = {
    "schema": "tee-ai-leakage-policy/v1",
    "strategy": "capped-detail",
    "probabilityDecimals": 3,
    "logProbDecimals": 3,
    "logitDecimals": 2,
    "scoreDecimals": 3,
    "maxTopK": 3,
    "suiteAggregatesOnly": True,
    "perItemResultsReturned": False,
    "probeWeightsReturned": False,
    "minEvalSuiteItems": 8,
    "maxEvalSuiteItems": 64,
    "minProbeExamples": 24,
    "maxProbeExamples": 200,
    "minProbeExamplesPerClass": 8,
    "minPatchPairs": 3,
    "maxPatchPairs": 12,
    "maxFeaturePrompts": 16,
    "maxFeaturesReported": 12,
}


def r_prob(value: float) -> float:
    return round(float(value), LEAKAGE_POLICY["probabilityDecimals"])


def r_logprob(value: float) -> float:
    return round(float(value), LEAKAGE_POLICY["logProbDecimals"])


def r_logit(value: float) -> float:
    return round(float(value), LEAKAGE_POLICY["logitDecimals"])


def r_score(value: float) -> float:
    return round(float(value), LEAKAGE_POLICY["scoreDecimals"])

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
    top_k = clamp_int(payload.get("topK"), 1, LEAKAGE_POLICY["maxTopK"], LEAKAGE_POLICY["maxTopK"])
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
            "cleanLogProb": r_logprob(logprob_for_token(clean_logits, target_id)),
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
        "policy": LEAKAGE_POLICY,
        "redaction": {
            "exposes": [
                "top-k logit-lens tokens (coarsened probabilities)",
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
                "full-precision probabilities and logits",
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
                            "probability": r_prob(prob),
                        }
                        for rank_index, (token_id, prob) in enumerate(
                            zip(top.indices.tolist(), top.values.tolist())
                        )
                    ],
                    "target": {
                        "rank": rank,
                        "probability": r_prob(target_prob),
                        "logit": r_logit(target_logit),
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
                    "maxAttention": r_prob(max_attention),
                    "entropy": round(entropy, 2),
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
                "meanEntropy": round(sum(entropies) / max(len(entropies), 1), 2),
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
                "targetLogProb": r_logprob(patched_logprob),
                "recovery": r_score(recovery),
                "clippedRecovery": r_score(max(0.0, min(1.0, recovery))),
            }
        )

    return {
        "available": True,
        "cleanLogProb": r_logprob(clean_logprob),
        "corruptedLogProb": r_logprob(corrupted_logprob),
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


# --- Auditor suite commands -------------------------------------------------
# Every suite binds a dataset hash to aggregate-only metrics. Per-item results
# never leave the runner (suiteAggregatesOnly), so a suite receipt attests
# "this committed model scored M on the committed dataset D" and nothing more.


def dataset_hash(items: Any) -> str:
    return sha256_hex(
        json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )


def expected_token_id(tokenizer: Any, text: str) -> Optional[int]:
    raw = str(text)
    if not raw.strip():
        return None
    candidates = [raw] if raw.startswith((" ", "\n")) else [f" {raw}", raw]
    for candidate in candidates:
        ids = tokenizer.encode(candidate, add_special_tokens=False)
        if ids:
            return int(ids[0])
    return None


def final_token_logits(tokenizer: Any, model: Any, prompt: str, max_length: int = 128) -> Any:
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=max_length)
    with torch.no_grad():
        outputs = model(**inputs, use_cache=False)
    return outputs.logits[0, -1, :]


def suite_envelope(kind: str, name: str, items: Any, metrics: Dict[str, Any], started: float) -> Dict[str, Any]:
    result = {
        "ok": True,
        "model": llm_info(),
        "suite": {
            "kind": kind,
            "name": name or kind,
            "itemCount": len(items),
            "datasetHash": dataset_hash(items),
        },
        "metrics": metrics,
        "policy": LEAKAGE_POLICY,
        "params": {
            "rawActivationsReturned": False,
            "rawAttentionReturned": False,
            "weightsReturned": False,
            "perItemResultsReturned": False,
        },
        "latencyMs": 0,
    }
    result["latencyMs"] = round((time.perf_counter() - started) * 1000.0, 3)
    result["resultHash"] = sha256_hex(
        json.dumps(result_without_model(result), sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    return result


def run_audit_suite(payload: Dict[str, Any]) -> Dict[str, Any]:
    tokenizer, model = load_llm()
    suite = payload.get("suite") or {}
    kind = str(suite.get("kind", ""))
    name = str(suite.get("name", "")).strip()[:120]
    items = suite.get("items")
    if kind not in {"expected-token", "memorization", "paired-bias"}:
        return {"ok": False, "error": "suite.kind must be expected-token, memorization, or paired-bias."}
    if not isinstance(items, list):
        return {"ok": False, "error": "suite.items must be a list."}
    if len(items) < LEAKAGE_POLICY["minEvalSuiteItems"]:
        return {
            "ok": False,
            "error": f"Leakage policy requires at least {LEAKAGE_POLICY['minEvalSuiteItems']} items so aggregates do not reveal single-prompt detail.",
        }
    if len(items) > LEAKAGE_POLICY["maxEvalSuiteItems"]:
        return {"ok": False, "error": f"Suites are capped at {LEAKAGE_POLICY['maxEvalSuiteItems']} items."}

    started = time.perf_counter()
    if kind == "expected-token":
        metrics = expected_token_metrics(tokenizer, model, items)
    elif kind == "memorization":
        metrics = memorization_metrics(tokenizer, model, items)
    else:
        metrics = paired_bias_metrics(tokenizer, model, items)
    if "error" in metrics:
        return {"ok": False, "error": metrics["error"]}
    return suite_envelope(kind, name, items, metrics, started)


def expected_token_metrics(tokenizer: Any, model: Any, items: List[Any]) -> Dict[str, Any]:
    ranks: List[int] = []
    probs: List[float] = []
    skipped = 0
    for item in items:
        prompt = str((item or {}).get("prompt", "")).strip()
        target = (item or {}).get("expectedToken", "")
        token_id = expected_token_id(tokenizer, str(target))
        if not prompt or token_id is None:
            skipped += 1
            continue
        logits = final_token_logits(tokenizer, model, prompt)
        rank = int((logits > logits[token_id]).sum().item() + 1)
        prob = float(torch.softmax(logits, dim=-1)[token_id].item())
        ranks.append(rank)
        probs.append(prob)
    if not ranks:
        return {"error": "No valid items: each needs prompt and expectedToken."}
    n = len(ranks)
    sorted_ranks = sorted(ranks)
    return {
        "scored": n,
        "skipped": skipped,
        "top1Accuracy": r_score(sum(1 for r in ranks if r == 1) / n),
        "top5Accuracy": r_score(sum(1 for r in ranks if r <= 5) / n),
        "medianTargetRank": sorted_ranks[n // 2],
        "meanTargetProbability": r_prob(sum(probs) / n),
    }


def memorization_metrics(tokenizer: Any, model: Any, items: List[Any]) -> Dict[str, Any]:
    matched_fractions: List[float] = []
    verbatim = 0
    skipped = 0
    for item in items:
        prefix = str((item or {}).get("prefix", "")).strip()
        continuation = str((item or {}).get("continuation", ""))
        if not prefix or not continuation.strip():
            skipped += 1
            continue
        cont_text = continuation if continuation.startswith((" ", "\n")) else f" {continuation}"
        cont_ids = tokenizer.encode(cont_text, add_special_tokens=False)
        if not cont_ids:
            skipped += 1
            continue
        inputs = tokenizer(prefix, return_tensors="pt", truncation=True, max_length=192)
        with torch.no_grad():
            generated = model.generate(
                **inputs,
                max_new_tokens=len(cont_ids),
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        new_ids = generated[0, inputs["input_ids"].shape[-1] :].tolist()
        matches = sum(1 for a, b in zip(new_ids, cont_ids) if int(a) == int(b))
        fraction = matches / len(cont_ids)
        matched_fractions.append(fraction)
        if fraction == 1.0:
            verbatim += 1
    if not matched_fractions:
        return {"error": "No valid items: each needs prefix and continuation."}
    n = len(matched_fractions)
    return {
        "scored": n,
        "skipped": skipped,
        "verbatimRate": r_score(verbatim / n),
        "meanMatchedTokenFraction": r_score(sum(matched_fractions) / n),
        "decoding": "greedy",
    }


def paired_bias_metrics(tokenizer: Any, model: Any, items: List[Any]) -> Dict[str, Any]:
    gaps: List[float] = []
    skipped = 0
    for item in items:
        prompt_a = str((item or {}).get("promptA", "")).strip()
        prompt_b = str((item or {}).get("promptB", "")).strip()
        token_id = expected_token_id(tokenizer, str((item or {}).get("targetToken", "")))
        if not prompt_a or not prompt_b or token_id is None:
            skipped += 1
            continue
        prob_a = float(torch.softmax(final_token_logits(tokenizer, model, prompt_a), dim=-1)[token_id].item())
        prob_b = float(torch.softmax(final_token_logits(tokenizer, model, prompt_b), dim=-1)[token_id].item())
        gaps.append(prob_a - prob_b)
    if not gaps:
        return {"error": "No valid items: each needs promptA, promptB, and targetToken."}
    n = len(gaps)
    return {
        "scored": n,
        "skipped": skipped,
        "meanSignedProbabilityGap": r_prob(sum(gaps) / n),
        "meanAbsoluteProbabilityGap": r_prob(sum(abs(g) for g in gaps) / n),
        "fractionFavoringPromptA": r_score(sum(1 for g in gaps if g > 0) / n),
    }


def run_probe(payload: Dict[str, Any]) -> Dict[str, Any]:
    import random

    tokenizer, model = load_llm()
    items = payload.get("items")
    if not isinstance(items, list):
        return {"ok": False, "error": "items must be a list of {text, label}."}
    cleaned: List[Tuple[str, int]] = []
    for item in items:
        text = str((item or {}).get("text", "")).strip()
        label = (item or {}).get("label")
        if text and label in (0, 1):
            cleaned.append((text, int(label)))
    n = len(cleaned)
    if n < LEAKAGE_POLICY["minProbeExamples"]:
        return {
            "ok": False,
            "error": f"Leakage policy requires at least {LEAKAGE_POLICY['minProbeExamples']} labeled examples (got {n}).",
        }
    if n > LEAKAGE_POLICY["maxProbeExamples"]:
        return {"ok": False, "error": f"Probes are capped at {LEAKAGE_POLICY['maxProbeExamples']} examples."}
    per_class = LEAKAGE_POLICY["minProbeExamplesPerClass"]
    positives = [pair for pair in cleaned if pair[1] == 1]
    negatives = [pair for pair in cleaned if pair[1] == 0]
    if len(positives) < per_class or len(negatives) < per_class:
        return {"ok": False, "error": f"Each class needs at least {per_class} examples."}

    test_fraction = clamp_float(payload.get("testFraction"), 0.15, 0.4, 0.25)
    seed = clamp_int(payload.get("seed"), 0, 2**31 - 1, 20260610)
    started = time.perf_counter()

    # One forward pass per example; keep the final-token hidden state per layer.
    features: List[Any] = []
    labels: List[int] = []
    for text, label in cleaned:
        inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=64)
        with torch.no_grad():
            outputs = model(**inputs, output_hidden_states=True, use_cache=False)
        stacked = torch.stack([hidden[0, -1, :] for hidden in outputs.hidden_states])
        features.append(stacked)
        labels.append(label)
    feature_tensor = torch.stack(features)  # [n, layers, d_model]
    label_tensor = torch.tensor(labels, dtype=torch.float32)

    rng = random.Random(seed)
    test_indices: List[int] = []
    for class_value in (0, 1):
        class_indices = [index for index, label in enumerate(labels) if label == class_value]
        rng.shuffle(class_indices)
        take = max(1, round(len(class_indices) * test_fraction))
        test_indices.extend(class_indices[:take])
    test_set = set(test_indices)
    train_indices = [index for index in range(n) if index not in test_set]

    train_y = label_tensor[train_indices]
    test_y = label_tensor[sorted(test_set)]
    majority = float(max(test_y.mean().item(), 1 - test_y.mean().item()))

    layer_count = feature_tensor.shape[1]
    layers: List[Dict[str, Any]] = []
    for layer_index in range(layer_count):
        train_x = feature_tensor[train_indices, layer_index, :]
        test_x = feature_tensor[sorted(test_set), layer_index, :]
        mean = train_x.mean(dim=0, keepdim=True)
        std = train_x.std(dim=0, keepdim=True).clamp(min=1e-6)
        train_x = (train_x - mean) / std
        test_x = (test_x - mean) / std

        torch.manual_seed(seed)
        weight = torch.zeros(train_x.shape[1], requires_grad=True)
        bias = torch.zeros(1, requires_grad=True)
        optimizer = torch.optim.Adam([weight, bias], lr=0.05, weight_decay=1e-3)
        loss_fn = torch.nn.BCEWithLogitsLoss()
        for _ in range(300):
            optimizer.zero_grad()
            loss = loss_fn(train_x @ weight + bias, train_y)
            loss.backward()
            optimizer.step()
        with torch.no_grad():
            train_acc = float((((train_x @ weight + bias) > 0).float() == train_y).float().mean().item())
            test_acc = float((((test_x @ weight + bias) > 0).float() == test_y).float().mean().item())
        layers.append(
            {
                "layer": layer_index,
                "label": "embedding" if layer_index == 0 else f"block-{layer_index}",
                "testAccuracy": r_score(test_acc),
                "trainAccuracy": r_score(train_acc),
            }
        )

    best = max(layers, key=lambda layer: layer["testAccuracy"])
    items_for_hash = [{"text": text, "label": label} for text, label in cleaned]
    metrics = {
        "kind": "linear-probe",
        "bestLayer": best["layer"],
        "bestTestAccuracy": best["testAccuracy"],
        "majorityClassBaseline": r_score(majority),
        "layers": layers,
        "counts": {
            "total": n,
            "train": len(train_indices),
            "test": len(test_set),
            "positives": len(positives),
            "negatives": len(negatives),
        },
        "probeParams": {"testFraction": round(test_fraction, 3), "seed": seed, "optimizer": "adam-300-steps"},
        "note": "Probe weight vectors stay inside the runner; they are directions in private activation space.",
    }
    return suite_envelope("linear-probe", str(payload.get("name", "")).strip()[:120], items_for_hash, metrics, started)


def run_patch_suite(payload: Dict[str, Any]) -> Dict[str, Any]:
    tokenizer, model = load_llm()
    pairs = payload.get("pairs")
    if not isinstance(pairs, list):
        return {"ok": False, "error": "pairs must be a list of {cleanPrompt, corruptedPrompt, targetToken?}."}
    if len(pairs) < LEAKAGE_POLICY["minPatchPairs"]:
        return {"ok": False, "error": f"Leakage policy requires at least {LEAKAGE_POLICY['minPatchPairs']} pairs."}
    if len(pairs) > LEAKAGE_POLICY["maxPatchPairs"]:
        return {"ok": False, "error": f"Patch suites are capped at {LEAKAGE_POLICY['maxPatchPairs']} pairs."}

    started = time.perf_counter()
    max_length = clamp_int(payload.get("maxPromptTokens"), 16, 192, 128)
    layer_count = len(model.transformer.h)
    per_layer: List[List[float]] = [[] for _ in range(layer_count)]
    clean_logprobs: List[float] = []
    corrupted_logprobs: List[float] = []
    skipped = 0

    for pair in pairs:
        clean_prompt = str((pair or {}).get("cleanPrompt", "")).strip()
        corrupted_prompt = str((pair or {}).get("corruptedPrompt", "")).strip()
        target_text = str((pair or {}).get("targetToken", ""))
        if not clean_prompt or not corrupted_prompt:
            skipped += 1
            continue
        clean_inputs = tokenizer(clean_prompt, return_tensors="pt", truncation=True, max_length=max_length)
        with torch.no_grad():
            clean_outputs = model(**clean_inputs, output_hidden_states=True, use_cache=False)
        clean_logits = clean_outputs.logits[0, -1, :]
        target_id = resolve_target_token_id(tokenizer, clean_logits, target_text)
        patching = activation_patch_scores(
            tokenizer, model, corrupted_prompt, clean_outputs.hidden_states, target_id, max_length
        )
        gap = patching["cleanLogProb"] - patching["corruptedLogProb"]
        if abs(gap) < 1e-4:
            skipped += 1
            continue
        clean_logprobs.append(patching["cleanLogProb"])
        corrupted_logprobs.append(patching["corruptedLogProb"])
        for layer in patching["layers"]:
            per_layer[layer["layer"] - 1].append(layer["clippedRecovery"])

    scored = len(clean_logprobs)
    if scored == 0:
        return {"ok": False, "error": "No scorable pairs: prompts may be empty or clean/corrupted behave identically."}

    layers = []
    for layer_index, recoveries in enumerate(per_layer):
        if not recoveries:
            continue
        mean = sum(recoveries) / len(recoveries)
        variance = sum((value - mean) ** 2 for value in recoveries) / len(recoveries)
        layers.append(
            {
                "layer": layer_index + 1,
                "meanClippedRecovery": r_score(mean),
                "stdClippedRecovery": r_score(variance**0.5),
                "minClippedRecovery": r_score(min(recoveries)),
                "maxClippedRecovery": r_score(max(recoveries)),
            }
        )
    best = max(layers, key=lambda layer: layer["meanClippedRecovery"])
    items_for_hash = [
        {
            "cleanPrompt": str((pair or {}).get("cleanPrompt", "")),
            "corruptedPrompt": str((pair or {}).get("corruptedPrompt", "")),
            "targetToken": str((pair or {}).get("targetToken", "")),
        }
        for pair in pairs
    ]
    metrics = {
        "kind": "activation-patch-suite",
        "scored": scored,
        "skipped": skipped,
        "bestLayer": best["layer"],
        "bestMeanClippedRecovery": best["meanClippedRecovery"],
        "meanCleanLogProb": r_logprob(sum(clean_logprobs) / scored),
        "meanCorruptedLogProb": r_logprob(sum(corrupted_logprobs) / scored),
        "layers": layers,
        "note": "Residual-stream patching at the final token position, averaged across pairs. Per-pair scores stay inside the runner.",
    }
    return suite_envelope(
        "activation-patch-suite", str(payload.get("name", "")).strip()[:120], items_for_hash, metrics, started
    )


def run_sae_features(payload: Dict[str, Any]) -> Dict[str, Any]:
    tokenizer, model = load_llm()
    prompts_raw = payload.get("prompts")
    if not isinstance(prompts_raw, list):
        return {"ok": False, "error": "prompts must be a list of strings."}
    prompts = [str(prompt).strip() for prompt in prompts_raw if str(prompt).strip()]
    if not prompts:
        return {"ok": False, "error": "At least one prompt is required."}
    if len(prompts) > LEAKAGE_POLICY["maxFeaturePrompts"]:
        return {"ok": False, "error": f"Feature reports are capped at {LEAKAGE_POLICY['maxFeaturePrompts']} prompts."}

    weights_path = SAE_DIR / "sae_gpt2.pt"
    meta_path = SAE_DIR / "sae_meta.json"
    if not weights_path.exists() or not meta_path.exists():
        return {
            "ok": True,
            "available": False,
            "hint": "No trained SAE dictionary found. Train one with: npm run train:sae",
            "policy": LEAKAGE_POLICY,
        }

    started = time.perf_counter()
    meta = json.loads(meta_path.read_text())
    state = torch.load(weights_path, map_location="cpu")
    w_enc = state["w_enc"]
    b_enc = state["b_enc"]
    b_dec = state["b_dec"]
    act_mean = state["act_mean"]
    act_std = state["act_std"]
    layer_index = int(meta.get("layer", 8))
    threshold = float(meta.get("firingThreshold", 1e-3))
    feature_count = int(w_enc.shape[1])

    fired = torch.zeros(feature_count)
    activation_sum = torch.zeros(feature_count)
    total_tokens = 0
    l0_sum = 0.0
    for prompt in prompts:
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=96)
        with torch.no_grad():
            outputs = model(**inputs, output_hidden_states=True, use_cache=False)
            hidden = outputs.hidden_states[layer_index][0]  # [tokens, d_model]
            normalized = (hidden - act_mean) / act_std
            acts = torch.relu((normalized - b_dec) @ w_enc + b_enc)  # [tokens, features]
        active = acts > threshold
        fired += active.float().sum(dim=0)
        activation_sum += (acts * active.float()).sum(dim=0)
        total_tokens += int(hidden.shape[0])
        l0_sum += float(active.float().sum().item())

    firing_rates = fired / max(total_tokens, 1)
    top = torch.topk(firing_rates, k=min(LEAKAGE_POLICY["maxFeaturesReported"], feature_count))
    labels = meta.get("features", {})
    features = []
    for feature_id, rate in zip(top.indices.tolist(), top.values.tolist()):
        if rate <= 0:
            continue
        label_info = labels.get(str(feature_id), {})
        mean_activation = float(activation_sum[feature_id].item() / max(float(fired[feature_id].item()), 1.0))
        features.append(
            {
                "feature": int(feature_id),
                "label": label_info.get("label") or "unlabeled",
                "exampleTokens": label_info.get("topTokens", [])[:6],
                "firingRate": r_score(rate),
                "meanActivationWhenActive": round(mean_activation, 2),
            }
        )

    result = {
        "ok": True,
        "available": True,
        "model": llm_info(),
        "suite": {
            "kind": "sae-features",
            "name": str(payload.get("name", "")).strip()[:120] or "sae-features",
            "itemCount": len(prompts),
            "datasetHash": dataset_hash(prompts),
        },
        "metrics": {
            "kind": "sae-features",
            "promptCount": len(prompts),
            "tokenCount": total_tokens,
            "meanActiveFeaturesPerToken": r_score(l0_sum / max(total_tokens, 1)),
            "features": features,
            "sae": {
                "layer": layer_index,
                "dModel": int(meta.get("dModel", 768)),
                "dFeatures": feature_count,
                "trainingSteps": meta.get("steps"),
                "corpusHash": meta.get("corpusHash"),
                "deadFeatures": meta.get("deadFeatures"),
                "note": "Tiny demo dictionary trained on a small public corpus; feature labels are top activating tokens, not human-verified concepts.",
            },
        },
        "policy": LEAKAGE_POLICY,
        "params": {
            "rawActivationsReturned": False,
            "rawAttentionReturned": False,
            "weightsReturned": False,
            "perItemResultsReturned": False,
        },
        "latencyMs": 0,
    }
    result["latencyMs"] = round((time.perf_counter() - started) * 1000.0, 3)
    result["resultHash"] = sha256_hex(
        json.dumps(result_without_model(result), sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    return result


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
        "command",
        choices=[
            "info",
            "llm-info",
            "generate",
            "interpret",
            "audit-suite",
            "probe",
            "patch-suite",
            "sae-features",
            "selftest",
        ],
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

    suite_commands = {
        "audit-suite": run_audit_suite,
        "probe": run_probe,
        "patch-suite": run_patch_suite,
        "sae-features": run_sae_features,
    }
    if args.command in suite_commands:
        payload = read_json_stdin()
        if not isinstance(payload, dict):
            emit({"ok": False, "error": "Expected a JSON object."})
            sys.exit(2)
        result = suite_commands[args.command](payload)
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
