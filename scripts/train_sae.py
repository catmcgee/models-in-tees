#!/usr/bin/env python3
"""Train a tiny demo sparse autoencoder (SAE) on GPT-2 layer-8 activations.

The SAE is a separate helper network that re-expresses each 768-dim hidden
state as a sparse combination of learned feature directions. It is trained on
a small deterministic public corpus (below), so the dictionary is a teaching
artifact, not a research-grade one. Artifacts land in private/sae/ next to the
private weights; only aggregate feature statistics ever leave the runner.

Run: npm run train:sae   (or: .venv/bin/python scripts/train_sae.py)
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "model"))

from model_runner import SAE_DIR, load_llm  # noqa: E402

LAYER = 8
D_FEATURES = 512
L1_COEFFICIENT = 8e-2
STEPS = 6000
BATCH_SIZE = 128
LEARNING_RATE = 1e-3
SEED = 20260610
FIRING_THRESHOLD = 0.05
LABEL_TOP_TOKENS = 6


def build_corpus() -> list[str]:
    capitals = [
        ("France", "Paris"), ("Germany", "Berlin"), ("Italy", "Rome"), ("Spain", "Madrid"),
        ("Japan", "Tokyo"), ("China", "Beijing"), ("Russia", "Moscow"), ("Canada", "Ottawa"),
        ("Brazil", "Brasilia"), ("Egypt", "Cairo"), ("India", "New Delhi"), ("Australia", "Canberra"),
        ("Greece", "Athens"), ("Norway", "Oslo"), ("Poland", "Warsaw"), ("Portugal", "Lisbon"),
    ]
    sentences: list[str] = []
    for country, capital in capitals:
        sentences.append(f"The capital of {country} is {capital}.")
        sentences.append(f"{capital} is a city in {country}.")

    positive = [
        "I absolutely loved the movie and would watch it again.",
        "The food at this restaurant was wonderful and fresh.",
        "She felt joyful and grateful after the celebration.",
        "This is the best book I have read all year.",
        "The team played brilliantly and won the championship.",
        "What a beautiful morning, the sun is shining.",
        "The concert was amazing and the crowd cheered.",
        "He was thrilled with his excellent exam results.",
    ]
    negative = [
        "I hated the movie and left before the ending.",
        "The food was awful and the service was terrible.",
        "She felt miserable and exhausted after the long delay.",
        "This is the worst book I have ever read.",
        "The team played poorly and lost every match.",
        "What a dreadful storm, the streets are flooded.",
        "The concert was boring and people walked out.",
        "He was devastated by the disappointing news.",
    ]
    sentences.extend(positive)
    sentences.extend(negative)

    code = [
        "def add(a, b): return a + b",
        "for i in range(10): print(i)",
        "import numpy as np",
        "x = [1, 2, 3, 4, 5]",
        "if value is None: raise ValueError('missing')",
        "while True: break",
        "class Model: pass",
        "result = sum(numbers) / len(numbers)",
    ]
    sentences.extend(code)

    numbers = [f"{a} plus {b} equals {a + b}." for a, b in [(2, 2), (3, 4), (5, 5), (7, 3), (9, 6), (8, 8)]]
    sentences.extend(numbers)

    quotes = [
        "To be, or not to be, that is the question.",
        "Four score and seven years ago our fathers brought forth a new nation.",
        "I have a dream that one day this nation will rise up.",
        "Call me Ishmael. Some years ago, never mind how long precisely.",
        "It was the best of times, it was the worst of times.",
        "In the beginning God created the heaven and the earth.",
    ]
    sentences.extend(quotes)

    misc = [
        "The doctor examined the patient and wrote a prescription.",
        "The lawyer argued the case before the supreme court.",
        "The engineer designed a bridge across the river.",
        "Rain is expected tomorrow with strong winds in the north.",
        "The stock market fell sharply after the announcement.",
        "The recipe calls for two cups of flour and one egg.",
        "The spacecraft entered orbit around the red planet.",
        "Electrons orbit the nucleus of an atom.",
        "The orchestra tuned their instruments before the symphony.",
        "She trained for months before running the marathon.",
        "The museum opened a new exhibit on ancient Rome.",
        "Wolves hunt in packs across the northern forests.",
    ]
    sentences.extend(misc)
    return sentences


def main() -> None:
    torch.manual_seed(SEED)
    corpus = build_corpus()
    corpus_hash = hashlib.sha256(json.dumps(corpus, sort_keys=True).encode("utf-8")).hexdigest()
    tokenizer, model = load_llm()

    print(f"Collecting layer-{LAYER} activations from {len(corpus)} sentences...", file=sys.stderr)
    activations = []
    token_strings: list[str] = []
    for sentence in corpus:
        inputs = tokenizer(sentence, return_tensors="pt", truncation=True, max_length=64)
        with torch.no_grad():
            outputs = model(**inputs, output_hidden_states=True, use_cache=False)
        hidden = outputs.hidden_states[LAYER][0]
        activations.append(hidden)
        token_strings.extend(tokenizer.decode([tid]) for tid in inputs["input_ids"][0].tolist())
    data = torch.cat(activations, dim=0)  # [tokens, 768]
    print(f"Collected {data.shape[0]} token activations.", file=sys.stderr)

    act_mean = data.mean(dim=0, keepdim=True)
    act_std = data.std(dim=0, keepdim=True).clamp(min=1e-6)
    normalized = (data - act_mean) / act_std

    d_model = normalized.shape[1]
    w_enc = torch.nn.Parameter(torch.randn(d_model, D_FEATURES) * 0.02)
    b_enc = torch.nn.Parameter(torch.zeros(D_FEATURES))
    w_dec = torch.nn.Parameter(torch.randn(D_FEATURES, d_model) * 0.02)
    b_dec = torch.nn.Parameter(torch.zeros(d_model))
    optimizer = torch.optim.Adam([w_enc, b_enc, w_dec, b_dec], lr=LEARNING_RATE)

    started = time.perf_counter()
    n_tokens = normalized.shape[0]
    for step in range(STEPS):
        indices = torch.randint(0, n_tokens, (BATCH_SIZE,))
        batch = normalized[indices]
        acts = torch.relu((batch - b_dec) @ w_enc + b_enc)
        recon = acts @ w_dec + b_dec
        mse = ((recon - batch) ** 2).mean()
        l1 = acts.abs().mean()
        loss = mse + L1_COEFFICIENT * l1
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        with torch.no_grad():
            w_dec.data = w_dec.data / w_dec.data.norm(dim=1, keepdim=True).clamp(min=1e-8)
        if (step + 1) % 1000 == 0:
            print(f"step {step + 1}/{STEPS} mse={mse.item():.4f} l1={l1.item():.4f}", file=sys.stderr)

    with torch.no_grad():
        all_acts = torch.relu((normalized - b_dec) @ w_enc + b_enc)  # [tokens, features]
        active = all_acts > FIRING_THRESHOLD
        firing_rates = active.float().mean(dim=0)
        dead = int((firing_rates == 0).sum().item())
        mean_l0 = float(active.float().sum(dim=1).mean().item())

        # Auto-label features by their top activating tokens in the corpus.
        features: dict[str, dict] = {}
        labeled = torch.topk(firing_rates, k=min(200, D_FEATURES))
        for feature_id in labeled.indices.tolist():
            if firing_rates[feature_id] <= 0:
                continue
            top_tokens = torch.topk(all_acts[:, feature_id], k=min(LABEL_TOP_TOKENS, n_tokens))
            tokens = []
            seen = set()
            for token_index in top_tokens.indices.tolist():
                text = token_strings[token_index]
                if text.strip() and text not in seen:
                    seen.add(text)
                    tokens.append(text)
            features[str(feature_id)] = {
                "label": "fires on: " + ", ".join(repr(token) for token in tokens[:4]),
                "topTokens": tokens,
            }

    SAE_DIR.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "w_enc": w_enc.detach(),
            "b_enc": b_enc.detach(),
            "w_dec": w_dec.detach(),
            "b_dec": b_dec.detach(),
            "act_mean": act_mean,
            "act_std": act_std,
        },
        SAE_DIR / "sae_gpt2.pt",
    )
    meta = {
        "schema": "tee-ai-sae/v1",
        "layer": LAYER,
        "dModel": d_model,
        "dFeatures": D_FEATURES,
        "l1Coefficient": L1_COEFFICIENT,
        "steps": STEPS,
        "seed": SEED,
        "firingThreshold": FIRING_THRESHOLD,
        "corpusHash": corpus_hash,
        "corpusSentences": len(corpus),
        "corpusTokens": n_tokens,
        "deadFeatures": dead,
        "meanActiveFeaturesPerToken": round(mean_l0, 2),
        "features": features,
    }
    (SAE_DIR / "sae_meta.json").write_text(json.dumps(meta, indent=2))

    print(
        json.dumps(
            {
                "ok": True,
                "trainedSeconds": round(time.perf_counter() - started, 1),
                "tokens": n_tokens,
                "features": D_FEATURES,
                "deadFeatures": dead,
                "meanActiveFeaturesPerToken": round(mean_l0, 2),
                "labeledFeatures": len(features),
                "artifacts": [str(SAE_DIR / "sae_gpt2.pt"), str(SAE_DIR / "sae_meta.json")],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
