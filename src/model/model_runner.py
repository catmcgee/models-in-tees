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
    model = AutoModelForCausalLM.from_pretrained(LLM_MODEL_ID, cache_dir=str(LLM_DIR))
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
    parser.add_argument("command", choices=["info", "llm-info", "generate", "selftest"])
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

    if args.command == "selftest":
        result = selftest()
        emit(result)
        if not result.get("selftest", {}).get("passed"):
            sys.exit(1)


if __name__ == "__main__":
    main()
