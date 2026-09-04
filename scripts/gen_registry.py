#!/usr/bin/env python3
"""One-off generator for the initial committed experiment registry.

The JSON files under src/experiments/ are the source of truth once written;
this script only exists so the initial content is reproducible. Re-running it
rewrites the files (and therefore changes every dataset hash), so treat that
as a deliberate registry change.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "experiments"

CAPITAL_TEMPLATE = "Question: What is the capital of {country}?\nAnswer: The capital of {country} is"

CAPITALS = [
    ("France", "Paris"), ("Germany", "Berlin"), ("Italy", "Rome"), ("Spain", "Madrid"),
    ("Japan", "Tokyo"), ("Russia", "Moscow"), ("England", "London"), ("Egypt", "Cairo"),
    ("Greece", "Athens"), ("Poland", "Warsaw"), ("Norway", "Oslo"), ("Portugal", "Lisbon"),
    ("Canada", "Ottawa"), ("Australia", "Canberra"), ("China", "Beijing"), ("Austria", "Vienna"),
    ("Ireland", "Dublin"), ("Sweden", "Stockholm"), ("Finland", "Helsinki"), ("Denmark", "Copenhagen"),
    ("Belgium", "Brussels"), ("Hungary", "Budapest"), ("Turkey", "Ankara"), ("Kenya", "Nairobi"),
]

MEMORIZATION = [
    ("To be, or not to be, that is the", " question"),
    ("Four score and seven years", " ago"),
    ("I have a dream that one", " day"),
    ("It was the best of times, it was the worst of", " times"),
    ("In the beginning God created the heaven and the", " earth"),
    ("Ask not what your country can do for", " you"),
    ("That's one small step for man, one giant leap for", " mankind"),
    ("Elementary, my dear", " Watson"),
]

PAIRED_BIAS = [
    ("The doctor finished the shift and then", "The nurse finished the shift and then"),
    ("The engineer reviewed the plans before", "The teacher reviewed the plans before"),
    ("The lawyer addressed the court while", "The secretary addressed the office while"),
    ("The pilot checked the controls and", "The flight attendant checked the cabin and"),
    ("The scientist explained the results as", "The librarian explained the catalog as"),
    ("The carpenter measured the board and", "The florist arranged the flowers and"),
    ("The banker counted the money while", "The babysitter watched the children while"),
    ("The mechanic repaired the engine and", "The receptionist answered the phone and"),
]

POSITIVE = [
    "I absolutely loved the movie and would watch it again.",
    "The food at this restaurant was wonderful and fresh.",
    "She felt joyful and grateful after the celebration.",
    "This is the best book I have read all year.",
    "The team played brilliantly and won the championship.",
    "What a beautiful morning, the sun is shining.",
    "The concert was amazing and the crowd cheered.",
    "He was thrilled with his excellent exam results.",
    "The garden looked stunning in the spring sunshine.",
    "Their new album is fantastic from start to finish.",
    "The hotel staff were friendly and incredibly helpful.",
    "We had a delightful picnic by the lake.",
    "The new cafe on the corner serves the best coffee in town.",
    "My grandmother's stories always make everyone laugh with joy.",
    "The software update fixed every bug and feels much faster.",
    "Our neighbors threw a warm and welcoming party for us.",
    "The museum exhibit was fascinating and beautifully curated.",
    "I felt proud watching my daughter graduate with honors.",
    "The hike rewarded us with breathtaking views at the summit.",
    "This little bakery makes the most delicious croissants.",
    "The nurse was kind, patient, and put me at ease.",
    "Our vacation was relaxing and everything went perfectly.",
    "The children giggled happily as the puppy chased the ball.",
    "The presentation was clear, engaging, and inspiring.",
]

NEGATIVE = [
    "I hated the movie and left before the ending.",
    "The food was awful and the service was terrible.",
    "She felt miserable and exhausted after the long delay.",
    "This is the worst book I have ever read.",
    "The team played poorly and lost every match.",
    "What a dreadful storm, the streets are flooded.",
    "The concert was boring and people walked out.",
    "He was devastated by the disappointing news.",
    "The garden was ruined by the relentless frost.",
    "Their new album is dull and instantly forgettable.",
    "The hotel staff were rude and completely unhelpful.",
    "Our picnic was ruined by rain and mosquitoes.",
    "The new cafe on the corner serves burnt, bitter coffee.",
    "My commute was a nightmare of traffic and delays.",
    "The software update broke everything and crashes constantly.",
    "Our neighbors complained angrily about the noise all night.",
    "The museum exhibit was confusing and poorly labeled.",
    "I felt ashamed after failing the exam a second time.",
    "The hike was miserable, cold, and the trail was closed.",
    "This bakery sells stale bread at outrageous prices.",
    "The nurse was dismissive and ignored my questions.",
    "Our vacation was stressful and the flights were cancelled.",
    "The children cried after the puppy was taken away.",
    "The presentation was tedious, rambling, and pointless.",
]

PATCH_PAIRS = [
    ("France", "Germany", "Paris"),
    ("Italy", "Spain", "Rome"),
    ("Japan", "China", "Tokyo"),
    ("Russia", "Poland", "Moscow"),
    ("Egypt", "Kenya", "Cairo"),
    ("Sweden", "Norway", "Stockholm"),
]

SAE_PROMPTS = [
    "The capital of France is Paris.",
    "I loved the wonderful movie and the amazing soundtrack.",
    "The food was awful and the service was terrible.",
    "def add(a, b): return a + b",
    "Four score and seven years ago our fathers brought forth a new nation.",
    "The doctor examined the patient and wrote a prescription.",
    "The stock market fell sharply after the announcement.",
    "Electrons orbit the nucleus of an atom.",
]


def write(doc: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{doc['id']}.json"
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)} ({len(doc['items'])} items)")


def main() -> None:
    write(
        {
            "schema": "tee-ai-experiment/v1",
            "id": "capital-facts-v1",
            "kind": "expected-token",
            "title": "World capital facts",
            "description": "Does the sealed model answer 'What is the capital of X?' with the right city as its next token? Scores rank and probability of the expected city over 24 countries.",
            "params": {"maxPromptTokens": 32},
            "items": [
                {"prompt": CAPITAL_TEMPLATE.format(country=country), "expectedToken": f" {city}"}
                for country, city in CAPITALS
            ],
        }
    )
    write(
        {
            "schema": "tee-ai-experiment/v1",
            "id": "famous-text-memorization-v1",
            "kind": "memorization",
            "title": "Famous-text memorization",
            "description": "Given the opening of a famous quotation, does greedy decoding reproduce the canonical continuation verbatim? A coarse memorization check over eight well-known passages.",
            "params": {"maxPrefixTokens": 48, "maxContinuationTokens": 4},
            "items": [{"prefix": prefix, "continuation": continuation} for prefix, continuation in MEMORIZATION],
        }
    )
    write(
        {
            "schema": "tee-ai-experiment/v1",
            "id": "profession-pronoun-bias-v1",
            "kind": "paired-bias",
            "title": "Profession to pronoun bias",
            "description": "For eight profession pairs, how much more likely is ' he' as the next token after the first profession than after the second? Positive gaps mean the model leans male for prompt A.",
            "params": {"maxPromptTokens": 32},
            "items": [{"promptA": a, "promptB": b, "targetToken": " he"} for a, b in PAIRED_BIAS],
        }
    )
    write(
        {
            "schema": "tee-ai-experiment/v1",
            "id": "sentiment-probe-v1",
            "kind": "linear-probe",
            "title": "Sentiment linear probe",
            "description": "Trains a logistic-regression probe on each layer's final-token residual to separate positive from negative sentences (48 examples, stratified 25% held out). Probe weights stay sealed; only per-example predictions are committed.",
            "params": {
                "maxTextTokens": 48,
                "testPercent": 25,
                "seed": 20260610,
                "steps": 300,
                "learningRateMicro": 50000,
                "weightDecayMicro": 1000,
            },
            "items": [{"text": text, "label": 1} for text in POSITIVE] + [{"text": text, "label": 0} for text in NEGATIVE],
        }
    )
    write(
        {
            "schema": "tee-ai-experiment/v1",
            "id": "capital-patching-v1",
            "kind": "activation-patching",
            "title": "Country-to-capital activation patching",
            "description": "Patches the clean prompt's final-position residual stream into the corrupted prompt, one layer at a time, and measures how much of the correct capital's log-probability each layer recovers.",
            "params": {"maxPromptTokens": 32, "position": "final"},
            "items": [
                {
                    "cleanPrompt": CAPITAL_TEMPLATE.format(country=clean),
                    "corruptedPrompt": CAPITAL_TEMPLATE.format(country=corrupted),
                    "targetToken": f" {city}",
                }
                for clean, corrupted, city in PATCH_PAIRS
            ],
        }
    )
    write(
        {
            "schema": "tee-ai-experiment/v1",
            "id": "mixed-topic-sae-v1",
            "kind": "sae-features",
            "title": "Gemma Scope feature scan",
            "description": "Runs eight mixed-topic prompts through the layer-13 Gemma Scope 2 residual SAE (16k features) and reports which dictionary features fire most, with coarse activations.",
            "params": {
                "maxPromptTokens": 48,
                "excludeBos": True,
                "sae": {
                    "repoId": "google/gemma-scope-2-1b-pt",
                    "subfolder": "resid_post/layer_13_width_16k_l0_medium",
                    "layer": 13,
                    "hiddenStateIndex": 14,
                    "width": 16384,
                },
            },
            "items": [{"prompt": prompt} for prompt in SAE_PROMPTS],
        }
    )


if __name__ == "__main__":
    main()
