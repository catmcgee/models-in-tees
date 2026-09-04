"""tee-ai-canonical-json/v1.

Deterministic JSON used for every hash and signature in the system. Both this
module and src/shared/canonical.ts implement the same rules:

- values: object, array, string, bool, null, and *safe integers* only
  (|n| <= 2^53 - 1). Floats are rejected so no float-formatting rule is needed.
- object keys sorted by UTF-16 code units (JavaScript's default string order)
- no whitespace, separators "," and ":"
- strings escaped like JSON.stringify: only '"', '\\' and U+0000..U+001F
- hash = SHA-256 over the UTF-8 bytes, lowercase hex
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Dict, List

MAX_SAFE_INTEGER = 2**53 - 1


class CanonicalError(TypeError):
    pass


def _key_order(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def _normalize(value: Any, path: str) -> Any:
    if value is None or value is True or value is False:
        return value
    if isinstance(value, bool):  # pragma: no cover - handled above
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalError(f"{path}: integer {value} exceeds 2^53-1")
        return int(value)
    if isinstance(value, float):
        raise CanonicalError(f"{path}: floats are not allowed in canonical JSON ({value!r})")
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise CanonicalError(f"{path}: string is not valid UTF-8") from exc
        return value
    if isinstance(value, (list, tuple)):
        return [_normalize(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key in sorted(value.keys(), key=_key_order):
            if not isinstance(key, str):
                raise CanonicalError(f"{path}: object keys must be strings")
            out[key] = _normalize(value[key], f"{path}.{key}")
        return out
    if hasattr(value, "item") and not isinstance(value, (bytes, bytearray)):
        # numpy / torch scalars
        return _normalize(value.item(), path)
    raise CanonicalError(f"{path}: unsupported type {type(value).__name__}")


def canonical_json(value: Any) -> str:
    normalized = _normalize(value, "$")
    return json.dumps(
        normalized,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
        sort_keys=False,
    )


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_bytes(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def canonical_hash(value: Any) -> str:
    return sha256_hex(canonical_bytes(value))


def assert_no_floats(value: Any, path: str = "$") -> None:
    _normalize(value, path)


# --- fixed-point helpers ---------------------------------------------------
# Only the runner converts floats to integers. Verifiers do integer math.

PROBABILITY_SCALE = 10_000   # "Bp"
LOGPROB_SCALE = 1_000        # "Milli"
SCORE_SCALE = 1_000          # "Milli"
ACTIVATION_SCALE = 100       # "Centi"


def fixed(value: float, scale: int) -> int:
    """Round half away from zero to an integer at the given scale."""
    x = float(value)
    if math.isnan(x) or math.isinf(x):
        raise CanonicalError(f"cannot fix non-finite value {x!r}")
    magnitude = math.floor(abs(x) * scale + 0.5)
    return int(-magnitude if x < 0 else magnitude)


def div_round(a: int, b: int) -> int:
    """Integer division rounded half up; b > 0."""
    if b <= 0:
        raise ValueError("div_round requires b > 0")
    return (2 * a + b) // (2 * b)


def mean_fixed(values: List[int]) -> int:
    if not values:
        return 0
    return div_round(sum(values), len(values))


def isqrt(value: int) -> int:
    return math.isqrt(max(0, int(value)))
