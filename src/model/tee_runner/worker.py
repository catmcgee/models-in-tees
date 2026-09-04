"""Persistent worker: NDJSON over stdin/stdout.

stdout carries protocol lines only; everything else (library warnings, our
own logging) is redirected to stderr. Requests are served strictly in order.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any, Dict, Optional

from . import paths
from .canonical import CanonicalError
from .envelope import RunError, run_experiment
from .llm import LLM, eprint
from .policy import policy_hash
from .registry import RegistryError, public_registry, require_registry
from .sae import JumpReluSae, SaeError
from .validation import validate_registry


class Runner:
    def __init__(self, force_commitment: bool = True) -> None:
        self.llm = LLM(force_commitment=force_commitment)
        self.sae: Optional[JumpReluSae] = None
        self.sae_error: Optional[str] = None
        try:
            self.sae = JumpReluSae(force_commitment=force_commitment)
        except (SaeError, Exception) as exc:  # SAE is optional at boot
            self.sae_error = str(exc)
            eprint(f"[runner] SAE unavailable: {exc}")

    def model_info(self) -> Dict[str, Any]:
        info = self.llm.info()
        info["sae"] = self.sae.info() if self.sae else None
        if self.sae_error:
            info["saeError"] = self.sae_error
        return info

    def handle(self, command: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if command == "ping":
            return {"pong": True}
        if command == "model-info":
            return self.model_info()
        if command == "registry":
            return public_registry(include_items=True)
        if command == "validate-registry":
            return validate_registry(self.llm, self.sae)
        if command == "run-experiment":
            experiment_id = payload.get("experimentId")
            if not isinstance(experiment_id, str):
                raise RunError("bad-request", "payload.experimentId must be a string")
            return run_experiment(self.llm, self.sae, experiment_id)
        raise RunError("bad-request", f"unknown command {command!r}")


def _error_envelope(request_id: Any, code: str, message: str) -> Dict[str, Any]:
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


def dispatch(runner: Runner, request: Dict[str, Any]) -> Dict[str, Any]:
    request_id = request.get("id")
    command = request.get("command")
    payload = request.get("payload") or {}
    if not isinstance(command, str) or not isinstance(payload, dict):
        return _error_envelope(request_id, "bad-request", "request needs a string command and object payload")
    try:
        result = runner.handle(command, payload)
        return {"id": request_id, "ok": True, "result": result}
    except RunError as exc:
        return _error_envelope(request_id, exc.code, str(exc))
    except RegistryError as exc:
        return _error_envelope(request_id, "registry-invalid", str(exc))
    except SaeError as exc:
        return _error_envelope(request_id, "sae-unavailable", str(exc))
    except CanonicalError as exc:
        return _error_envelope(request_id, "internal", f"canonical JSON violation: {exc}")
    except Exception as exc:  # noqa: BLE001
        eprint(traceback.format_exc())
        return _error_envelope(request_id, "internal", f"{type(exc).__name__}: {exc}")


def serve() -> int:
    protocol = sys.__stdout__
    sys.stdout = sys.stderr  # anything printed by libraries goes to stderr

    def emit(message: Dict[str, Any]) -> None:
        protocol.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
        protocol.flush()

    started = time.perf_counter()
    try:
        runner = Runner(force_commitment=True)
        registry = require_registry()
    except Exception as exc:  # noqa: BLE001
        eprint(traceback.format_exc())
        emit({"event": "fatal", "error": {"code": "model-unavailable", "message": str(exc)}})
        return 3

    emit(
        {
            "event": "ready",
            "pid": __import__("os").getpid(),
            "model": {"commitment": runner.llm.commitment, "modelId": paths.LLM_MODEL_ID},
            "sae": {"commitment": runner.sae.commitment} if runner.sae else None,
            "registryHash": registry["registryHash"],
            "policyHash": policy_hash(),
            "loadMs": int((time.perf_counter() - started) * 1000),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            emit(_error_envelope(None, "bad-request", "request line is not valid JSON"))
            continue
        if not isinstance(request, dict):
            emit(_error_envelope(None, "bad-request", "request must be a JSON object"))
            continue
        emit(dispatch(runner, request))
    return 0
