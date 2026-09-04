from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..registry import item_hash


class RunContext:
    """What an experiment gets to see: the sealed model and, optionally, the SAE."""

    def __init__(self, llm: Any, sae: Optional[Any] = None) -> None:
        self.llm = llm
        self.sae = sae
        self.forward_passes = 0


def base_leaf(schema: str, index: int, item: Dict[str, Any]) -> Dict[str, Any]:
    return {"schema": schema, "index": index, "itemHash": item_hash(item)}


def require_str(item: Dict[str, Any], key: str, errors: List[str], prefix: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}.{key} must be a non-empty string")
        return ""
    if len(value) > 2000:
        errors.append(f"{prefix}.{key} is longer than 2000 characters")
    return value


def check_prompt_length(llm: Any, text: str, cap: int, errors: List[str], prefix: str) -> None:
    if not text:
        return
    try:
        llm.encode_prompt(text, cap)
    except Exception as exc:  # TokenizationError
        errors.append(f"{prefix}: {exc}")


def check_single_token(llm: Any, text: str, errors: List[str], prefix: str) -> None:
    if not text:
        return
    try:
        llm.single_token_id(text)
    except Exception as exc:
        errors.append(f"{prefix}: {exc}")


def check_item_keys(item: Dict[str, Any], allowed: List[str], errors: List[str], prefix: str) -> None:
    extra = set(item.keys()) - set(allowed)
    if extra:
        errors.append(f"{prefix}: unexpected keys {sorted(extra)}")
