"""Model and SAE commitments: a manifest of per-file SHA-256 over the resolved
Hugging Face snapshot, cached by (path, size, mtime, inode).

The commitment is public (Hugging Face publishes the same file hashes); the
weights are not.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import paths
from .canonical import canonical_hash

MODEL_SCHEMA = "tee-ai-model-commitment/v1"
SAE_SCHEMA = "tee-ai-sae-commitment/v1"

MODEL_PATTERNS = [
    "config.json",
    "generation_config.json",
    "*.safetensors",
    "model.safetensors.index.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
]


class CommitmentError(RuntimeError):
    pass


def resolve_snapshot(repo_id: str, cache_dir: Path, allow_patterns: List[str]) -> Path:
    try:
        from huggingface_hub import snapshot_download
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise CommitmentError("huggingface_hub is required") from exc
    try:
        return Path(
            snapshot_download(
                repo_id,
                cache_dir=str(cache_dir),
                allow_patterns=allow_patterns,
                local_files_only=True,
            )
        )
    except Exception as exc:
        raise CommitmentError(
            f"{repo_id} is not present under {cache_dir}. Run: npm run fetch:artifacts ({exc})"
        ) from exc


def _matching_files(snapshot: Path, patterns: List[str]) -> List[Path]:
    files: List[Path] = []
    for file in sorted(snapshot.rglob("*")):
        if not file.is_file() and not file.is_symlink():
            continue
        rel = file.relative_to(snapshot).as_posix()
        if any(fnmatch.fnmatch(rel, pattern) for pattern in patterns):
            files.append(file)
    return files


def _sha256_file(file: Path) -> str:
    digest = hashlib.sha256()
    with open(file, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stat_entry(snapshot: Path, file: Path) -> Dict[str, Any]:
    st = os.stat(file)  # follows the snapshot symlink to the blob
    return {
        "path": file.relative_to(snapshot).as_posix(),
        "sizeBytes": int(st.st_size),
        "mtimeNs": int(st.st_mtime_ns),
        "inode": int(st.st_ino),
    }


def compute_manifest_commitment(
    schema: str,
    id_fields: Dict[str, str],
    snapshot: Path,
    patterns: List[str],
    cache_path: Path,
    force: bool,
) -> Dict[str, Any]:
    files = _matching_files(snapshot, patterns)
    if not files:
        raise CommitmentError(f"no files matching {patterns} under {snapshot}")
    stats = [_stat_entry(snapshot, file) for file in files]

    cached: Optional[Dict[str, Any]] = None
    if not force and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cached = None
    if (
        cached
        and cached.get("schema") == schema
        and all(cached.get(k) == v for k, v in id_fields.items())
        and cached.get("cache", {}).get("stat") == stats
    ):
        return cached

    manifest = [
        {"path": stat["path"], "sizeBytes": stat["sizeBytes"], "sha256": _sha256_file(file)}
        for stat, file in zip(stats, files)
    ]
    material = {"schema": schema, **id_fields, "files": manifest}
    record = {
        "schema": schema,
        **id_fields,
        "snapshotDir": snapshot.relative_to(snapshot.parents[2]).as_posix()
        if len(snapshot.parents) > 2
        else snapshot.name,
        "files": manifest,
        "commitment": canonical_hash(material),
        "cache": {
            "computedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "stat": stats,
        },
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, cache_path)
    return record


def model_commitment(force: bool = False) -> Dict[str, Any]:
    snapshot = resolve_snapshot(paths.LLM_MODEL_ID, paths.LLM_DIR, MODEL_PATTERNS)
    return compute_manifest_commitment(
        MODEL_SCHEMA,
        {"modelId": paths.LLM_MODEL_ID},
        snapshot,
        MODEL_PATTERNS,
        paths.MODEL_COMMITMENT_CACHE,
        force,
    )


def sae_patterns(subfolder: str) -> List[str]:
    return [f"{subfolder}/config.json", f"{subfolder}/params.safetensors"]


def sae_commitment(force: bool = False) -> Dict[str, Any]:
    patterns = sae_patterns(paths.SAE_SUBFOLDER)
    snapshot = resolve_snapshot(paths.SAE_REPO_ID, paths.SAE_HUB_DIR, patterns)
    return compute_manifest_commitment(
        SAE_SCHEMA,
        {"repoId": paths.SAE_REPO_ID, "subfolder": paths.SAE_SUBFOLDER},
        snapshot,
        patterns,
        paths.SAE_COMMITMENT_CACHE,
        force,
    )


def public_manifest(record: Dict[str, Any]) -> Dict[str, Any]:
    """Everything except the local stat cache."""
    return {key: value for key, value in record.items() if key != "cache"}
