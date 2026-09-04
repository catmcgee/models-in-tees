"""tee-ai-disclosure/v1: deterministic partial reveal of Merkle leaves.

The seed depends only on committed material (results root, dataset hash,
model commitment), so the operator cannot choose which items are opened and
re-running an unchanged experiment opens the same items again.
"""

from __future__ import annotations

import struct
from typing import List

from .canonical import sha256_bytes

SCHEME = "tee-ai-disclosure/v1"
DOMAIN = b"tee-ai-disclosure/v1"


def disclosure_seed(results_root: str, dataset_hash: str, model_commitment: str) -> str:
    return sha256_bytes(
        DOMAIN + bytes.fromhex(results_root) + bytes.fromhex(dataset_hash) + bytes.fromhex(model_commitment)
    ).hex()


def disclosure_count(leaf_count: int, percent: int, minimum: int, maximum: int) -> int:
    if leaf_count <= 0:
        return 0
    wanted = -(-leaf_count * percent // 100)  # ceil
    wanted = max(minimum, min(maximum, wanted))
    return min(leaf_count, wanted)


def sample_indices(seed_hex: str, leaf_count: int, count: int) -> List[int]:
    if count > leaf_count:
        raise ValueError("cannot sample more indices than leaves")
    seed = bytes.fromhex(seed_hex)
    chosen: List[int] = []
    counter = 0
    while len(chosen) < count:
        digest = sha256_bytes(seed + struct.pack(">I", counter))
        index = struct.unpack(">Q", digest[:8])[0] % leaf_count
        if index not in chosen:
            chosen.append(index)
        counter += 1
    return sorted(chosen)
