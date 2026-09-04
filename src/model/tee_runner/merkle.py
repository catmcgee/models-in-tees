"""RFC 6962 (Certificate Transparency) Merkle tree over canonical leaves.

leafHash = SHA256(0x00 || canonical(leaf))
node     = SHA256(0x01 || left || right)
split at the largest power of two strictly less than n; no padding.

Inclusion proofs are serialised as [{hash, side}] from leaf to root, where
side is the position of the *sibling* ("left" or "right").
"""

from __future__ import annotations

from typing import Any, Dict, List

from .canonical import canonical_bytes, sha256_bytes

LEAF_PREFIX = b"\x00"
NODE_PREFIX = b"\x01"
SCHEME = "rfc6962-sha256"


def leaf_hash_bytes(leaf: Any) -> bytes:
    return sha256_bytes(LEAF_PREFIX + canonical_bytes(leaf))


def leaf_hash(leaf: Any) -> str:
    return leaf_hash_bytes(leaf).hex()


def node_hash_bytes(left: bytes, right: bytes) -> bytes:
    return sha256_bytes(NODE_PREFIX + left + right)


def _split_point(n: int) -> int:
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def merkle_root_bytes(hashes: List[bytes]) -> bytes:
    n = len(hashes)
    if n == 0:
        raise ValueError("merkle root of zero leaves is undefined")
    if n == 1:
        return hashes[0]
    k = _split_point(n)
    return node_hash_bytes(merkle_root_bytes(hashes[:k]), merkle_root_bytes(hashes[k:]))


def merkle_root(hashes_hex: List[str]) -> str:
    return merkle_root_bytes([bytes.fromhex(h) for h in hashes_hex]).hex()


def inclusion_proof(hashes_hex: List[str], index: int) -> List[Dict[str, str]]:
    hashes = [bytes.fromhex(h) for h in hashes_hex]
    if not 0 <= index < len(hashes):
        raise IndexError("leaf index out of range")

    def path(m: int, nodes: List[bytes]) -> List[Dict[str, str]]:
        n = len(nodes)
        if n == 1:
            return []
        k = _split_point(n)
        if m < k:
            return path(m, nodes[:k]) + [{"hash": merkle_root_bytes(nodes[k:]).hex(), "side": "right"}]
        return path(m - k, nodes[k:]) + [{"hash": merkle_root_bytes(nodes[:k]).hex(), "side": "left"}]

    return path(index, hashes)


def verify_inclusion(leaf_hash_hex: str, proof: List[Dict[str, str]], root_hex: str) -> bool:
    current = bytes.fromhex(leaf_hash_hex)
    for step in proof:
        sibling = bytes.fromhex(step["hash"])
        if step["side"] == "left":
            current = node_hash_bytes(sibling, current)
        elif step["side"] == "right":
            current = node_hash_bytes(current, sibling)
        else:
            return False
    return current.hex() == root_hex
