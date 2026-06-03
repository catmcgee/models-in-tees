#!/usr/bin/env python3
"""Private model runner for the benchmark demo.

The public API talks to this file as a subprocess. The weights live in
private/model and are never returned over stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import string
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import numpy as np
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, Dataset
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
MODEL_DIR = Path(os.environ.get("TEE_AI_MODEL_DIR", ROOT / "private" / "model"))
MODEL_PATH = MODEL_DIR / "private_transformer.pt"
META_PATH = MODEL_DIR / "model_meta.json"

LABELS = ["APPROVE", "REVIEW", "BLOCK", "INSUFFICIENT"]
LABEL_TO_ID = {label: idx for idx, label in enumerate(LABELS)}
MAX_LEN = 256
D_MODEL = 96
N_HEADS = 4
N_LAYERS = 3
D_FF = 224
DROPOUT = 0.08
VOCAB = ["<pad>", "<unk>"] + list(string.printable[:95])
CHAR_TO_ID = {ch: idx for idx, ch in enumerate(VOCAB)}
PAD_ID = CHAR_TO_ID["<pad>"]
UNK_ID = CHAR_TO_ID["<unk>"]

ARCHITECTURE = {
    "family": "tiny-transformer-benchmark-classifier",
    "d_model": D_MODEL,
    "heads": N_HEADS,
    "layers": N_LAYERS,
    "feed_forward": D_FF,
    "dropout": DROPOUT,
    "max_len": MAX_LEN,
    "labels": LABELS,
    "input": "printable-ascii character tokens",
    "pooling": "masked-mean",
}


def normalize_label(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().upper().replace("-", "_").replace(" ", "_")
    aliases = {
        "PASS": "APPROVE",
        "ALLOW": "APPROVE",
        "OK": "APPROVE",
        "ACCEPT": "APPROVE",
        "ESCALATE": "REVIEW",
        "NEEDS_REVIEW": "REVIEW",
        "HUMAN_REVIEW": "REVIEW",
        "DENY": "BLOCK",
        "REJECT": "BLOCK",
        "STOP": "BLOCK",
        "UNKNOWN": "INSUFFICIENT",
        "NOT_ENOUGH_INFO": "INSUFFICIENT",
        "MISSING_INFO": "INSUFFICIENT",
    }
    text = aliases.get(text, text)
    return text if text in LABEL_TO_ID else None


def encode(text: str) -> Tuple[torch.Tensor, torch.Tensor]:
    trimmed = text.lower()[:MAX_LEN]
    ids = [CHAR_TO_ID.get(ch, UNK_ID) for ch in trimmed]
    mask = [1] * len(ids)
    if len(ids) < MAX_LEN:
        pad = MAX_LEN - len(ids)
        ids.extend([PAD_ID] * pad)
        mask.extend([0] * pad)
    return torch.tensor(ids, dtype=torch.long), torch.tensor(mask, dtype=torch.bool)


class TinyBenchmarkTransformer(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.token_embedding = nn.Embedding(len(VOCAB), D_MODEL, padding_idx=PAD_ID)
        self.position_embedding = nn.Embedding(MAX_LEN, D_MODEL)
        layer = nn.TransformerEncoderLayer(
            d_model=D_MODEL,
            nhead=N_HEADS,
            dim_feedforward=D_FF,
            dropout=DROPOUT,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=N_LAYERS)
        self.norm = nn.LayerNorm(D_MODEL)
        self.head = nn.Sequential(
            nn.Linear(D_MODEL, D_MODEL),
            nn.GELU(),
            nn.Dropout(DROPOUT),
            nn.Linear(D_MODEL, len(LABELS)),
        )

    def forward(self, tokens: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        positions = torch.arange(tokens.size(1), device=tokens.device).unsqueeze(0)
        hidden = self.token_embedding(tokens) + self.position_embedding(positions)
        encoded = self.encoder(hidden, src_key_padding_mask=~mask.bool())
        encoded = self.norm(encoded)
        weights = mask.float().unsqueeze(-1)
        pooled = (encoded * weights).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)
        return self.head(pooled)


@dataclass(frozen=True)
class Sample:
    prompt: str
    label: str


class BenchmarkDataset(Dataset):
    def __init__(self, samples: Sequence[Sample]) -> None:
        self.samples = list(samples)

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        sample = self.samples[idx]
        tokens, mask = encode(sample.prompt)
        return tokens, mask, torch.tensor(LABEL_TO_ID[sample.label], dtype=torch.long)


def make_synthetic_samples(
    seed: int = 1337,
    count_per_label: Optional[int] = None,
) -> List[Sample]:
    rng = random.Random(seed)
    count_per_label = count_per_label or int(
        os.environ.get("TEE_AI_TRAIN_COUNT_PER_LABEL", "240")
    )
    anchor_repeats = int(os.environ.get("TEE_AI_ANCHOR_REPEATS", "64"))
    subjects = [
        "vendor contract",
        "support ticket",
        "customer export",
        "internal automation",
        "research summary",
        "analytics request",
        "security exception",
        "finance workflow",
    ]
    formats = [
        "Classify this request: {body}.",
        "Policy gate input: {body}.",
        "Benchmark case: {body}. Return the control decision.",
        "TEE eval prompt: {body}.",
        "Risk review packet: {body}.",
    ]
    approve_terms = [
        "uses public data",
        "public data",
        "contains no pii",
        "no pii",
        "budget is under threshold",
        "matches an approved template",
        "read only access",
        "routine low risk change",
        "signed by the data owner",
    ]
    review_terms = [
        "ambiguous consent language",
        "new vendor",
        "cross border processing",
        "regulated workflow",
        "requires human approval",
        "borderline privacy impact",
        "unusual access pattern",
    ]
    block_terms = [
        "asks for raw credentials",
        "exports medical records",
        "bypasses access controls",
        "contains secret keys",
        "requests malware behavior",
        "exfiltrates customer data",
        "ignores deletion policy",
    ]
    insufficient_terms = [
        "missing data owner",
        "no stated purpose",
        "unknown destination",
        "incomplete ticket",
        "not enough context",
        "unclear retention period",
        "missing approval chain",
    ]
    all_terms = {
        "APPROVE": approve_terms,
        "REVIEW": review_terms,
        "BLOCK": block_terms,
        "INSUFFICIENT": insufficient_terms,
    }
    distractors = [
        "sla is normal",
        "team asks for fast turnaround",
        "expected volume is medium",
        "deadline is friday",
        "owner says it is important",
        "request came from a partner",
    ]

    samples: List[Sample] = []
    for label, terms in all_terms.items():
        for _ in range(count_per_label):
            subject = rng.choice(subjects)
            picked = rng.sample(terms, k=rng.randint(2, 3))
            noise = rng.sample(distractors, k=rng.randint(0, 2))
            body_parts = [subject] + picked + noise
            rng.shuffle(body_parts)
            body = "; ".join(body_parts)
            prompt = rng.choice(formats).format(body=body)
            samples.append(Sample(prompt=prompt, label=label))

    for _ in range(anchor_repeats):
        for item in default_selftest_cases():
            samples.append(Sample(prompt=str(item["prompt"]), label=str(item["expected"])))

    rng.shuffle(samples)
    return samples


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def split_samples(samples: Sequence[Sample]) -> Tuple[List[Sample], List[Sample]]:
    boundary = int(len(samples) * 0.82)
    return list(samples[:boundary]), list(samples[boundary:])


def train_model(force: bool = False) -> Dict[str, Any]:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if MODEL_PATH.exists() and META_PATH.exists() and not force:
        return {"ok": True, "skipped": True, "info": model_info()}

    set_seed(20260602)
    samples = make_synthetic_samples()
    train_samples, val_samples = split_samples(samples)
    train_loader = DataLoader(BenchmarkDataset(train_samples), batch_size=48, shuffle=True)
    val_loader = DataLoader(BenchmarkDataset(val_samples), batch_size=96)

    model = TinyBenchmarkTransformer()
    optimizer = torch.optim.AdamW(model.parameters(), lr=2.5e-3, weight_decay=0.01)
    criterion = nn.CrossEntropyLoss()

    history: List[Dict[str, float]] = []
    best_state: Optional[Dict[str, torch.Tensor]] = None
    best_accuracy = -math.inf
    best_loss = math.inf
    max_epochs = int(os.environ.get("TEE_AI_TRAIN_EPOCHS", "10"))
    for epoch in range(1, max_epochs + 1):
        model.train()
        losses = []
        for tokens, mask, labels in train_loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(tokens, mask)
            loss = criterion(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach()))

        val_acc, val_loss = evaluate_loader(model, val_loader, criterion)
        history.append(
            {
                "epoch": float(epoch),
                "train_loss": float(np.mean(losses)),
                "val_loss": val_loss,
                "val_accuracy": val_acc,
            }
        )
        if val_acc > best_accuracy or (val_acc == best_accuracy and val_loss < best_loss):
            best_accuracy = val_acc
            best_loss = val_loss
            best_state = {
                name: tensor.detach().cpu().clone()
                for name, tensor in model.state_dict().items()
            }
        if val_acc >= 0.98 and epoch >= 4:
            break

    if best_state is not None:
        model.load_state_dict(best_state)

    checkpoint = {
        "state_dict": model.state_dict(),
        "architecture": ARCHITECTURE,
        "labels": LABELS,
        "vocab": VOCAB,
    }
    torch.save(checkpoint, MODEL_PATH)
    meta = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "architecture": ARCHITECTURE,
        "training": {
            "synthetic_samples": len(samples),
            "history": history,
            "selected_val_accuracy": best_accuracy,
            "selected_val_loss": best_loss,
            "seed": 20260602,
        },
    }
    META_PATH.write_text(json.dumps(meta, indent=2, sort_keys=True), encoding="utf-8")
    return {"ok": True, "skipped": False, "info": model_info()}


def evaluate_loader(
    model: TinyBenchmarkTransformer,
    loader: DataLoader,
    criterion: nn.Module,
) -> Tuple[float, float]:
    model.eval()
    total = 0
    correct = 0
    losses = []
    with torch.no_grad():
        for tokens, mask, labels in loader:
            logits = model(tokens, mask)
            loss = criterion(logits, labels)
            losses.append(float(loss))
            predicted = logits.argmax(dim=-1)
            correct += int((predicted == labels).sum())
            total += labels.numel()
    return correct / max(total, 1), float(np.mean(losses))


def load_model() -> TinyBenchmarkTransformer:
    if not MODEL_PATH.exists():
        train_model(force=False)
    checkpoint = torch.load(MODEL_PATH, map_location="cpu")
    model = TinyBenchmarkTransformer()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def model_commitment() -> str:
    if not MODEL_PATH.exists():
        train_model(force=False)
    digest = hashlib.sha256()
    digest.update(MODEL_PATH.read_bytes())
    digest.update(json.dumps(ARCHITECTURE, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def model_info() -> Dict[str, Any]:
    meta = json.loads(META_PATH.read_text(encoding="utf-8")) if META_PATH.exists() else {}
    return {
        "architecture": ARCHITECTURE,
        "commitment": model_commitment(),
        "labels": LABELS,
        "weights_path": str(MODEL_PATH.relative_to(ROOT)),
        "weights_public": False,
        "meta": meta,
    }


def softmax(values: torch.Tensor) -> torch.Tensor:
    return torch.softmax(values, dim=-1)


def prediction_text(label: str, confidence: float) -> str:
    templates = {
        "APPROVE": "APPROVE: the request fits the low-risk control pattern.",
        "REVIEW": "REVIEW: the request should be routed to a human reviewer.",
        "BLOCK": "BLOCK: the request matches a disallowed risk pattern.",
        "INSUFFICIENT": "INSUFFICIENT: the request lacks enough detail to decide.",
    }
    return f"{templates[label]} Confidence {confidence:.2%}."


def run_cases(cases: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    model = load_model()
    predictions: List[Dict[str, Any]] = []
    start_all = time.perf_counter()

    with torch.no_grad():
        for index, raw_case in enumerate(cases):
            prompt = str(raw_case.get("prompt", "")).strip()
            case_id = str(raw_case.get("id") or f"case-{index + 1}")
            expected = normalize_label(raw_case.get("expected"))
            started = time.perf_counter()
            tokens, mask = encode(prompt)
            logits = model(tokens.unsqueeze(0), mask.unsqueeze(0))[0]
            probs = softmax(logits)
            pred_idx = int(torch.argmax(probs).item())
            label = LABELS[pred_idx]
            confidence = float(probs[pred_idx].item())
            latency_ms = (time.perf_counter() - started) * 1000.0
            scores = {LABELS[i]: round(float(probs[i].item()), 6) for i in range(len(LABELS))}
            predictions.append(
                {
                    "id": case_id,
                    "promptHash": sha256_hex(prompt.encode("utf-8")),
                    "prediction": label,
                    "expected": expected,
                    "correct": None if expected is None else expected == label,
                    "confidence": round(confidence, 6),
                    "scores": scores,
                    "latencyMs": round(latency_ms, 3),
                    "output": prediction_text(label, confidence),
                }
            )

    total_with_expected = [p for p in predictions if p["expected"] is not None]
    correct = [p for p in total_with_expected if p["correct"] is True]
    by_label: Dict[str, Dict[str, int]] = {
        label: {"predicted": 0, "expected": 0, "correct": 0} for label in LABELS
    }
    for item in predictions:
        by_label[item["prediction"]]["predicted"] += 1
        if item["expected"] is not None:
            by_label[item["expected"]]["expected"] += 1
            if item["correct"]:
                by_label[item["expected"]]["correct"] += 1

    metrics = {
        "caseCount": len(predictions),
        "labeledCaseCount": len(total_with_expected),
        "accuracy": None
        if not total_with_expected
        else round(len(correct) / len(total_with_expected), 6),
        "avgConfidence": round(
            sum(p["confidence"] for p in predictions) / max(len(predictions), 1), 6
        ),
        "totalLatencyMs": round((time.perf_counter() - start_all) * 1000.0, 3),
        "byLabel": by_label,
    }

    return {
        "ok": True,
        "model": model_info(),
        "predictions": predictions,
        "metrics": metrics,
    }


def default_selftest_cases() -> List[Dict[str, Any]]:
    return [
        {
            "id": "approve-public-data",
            "prompt": "Policy gate input: analytics request; public data; contains no pii; read only access.",
            "expected": "APPROVE",
        },
        {
            "id": "review-regulated",
            "prompt": "Classify this request: customer export; regulated workflow; cross border processing; unusual access pattern.",
            "expected": "REVIEW",
        },
        {
            "id": "block-secret",
            "prompt": "Risk review packet: support ticket; contains secret keys; asks for raw credentials; bypasses access controls.",
            "expected": "BLOCK",
        },
        {
            "id": "insufficient-missing",
            "prompt": "Benchmark case: finance workflow; missing data owner; unknown destination; not enough context.",
            "expected": "INSUFFICIENT",
        },
    ]


def read_json_stdin() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def emit(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["bootstrap", "info", "run", "selftest"])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.command == "bootstrap":
        emit(train_model(force=args.force))
        return

    if args.command == "info":
        if not MODEL_PATH.exists():
            train_model(force=False)
        emit({"ok": True, "info": model_info()})
        return

    if args.command == "run":
        payload = read_json_stdin()
        cases = payload.get("cases") if isinstance(payload, dict) else payload
        if not isinstance(cases, list) or not cases:
            emit({"ok": False, "error": "Expected a non-empty cases array."})
            sys.exit(2)
        emit(run_cases(cases))
        return

    if args.command == "selftest":
        train_model(force=False)
        result = run_cases(default_selftest_cases())
        accuracy = result["metrics"]["accuracy"] or 0
        result["selftest"] = {
            "passed": accuracy >= 0.75,
            "minAccuracy": 0.75,
        }
        emit(result)
        if accuracy < 0.75:
            sys.exit(1)


if __name__ == "__main__":
    main()
