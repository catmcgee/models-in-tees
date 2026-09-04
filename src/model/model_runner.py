#!/usr/bin/env python3
"""TEE experiment runner entrypoint.

    model_runner.py serve               persistent NDJSON worker (used by the API)
    model_runner.py model-info          one-shot JSON on stdout
    model_runner.py registry
    model_runner.py validate-registry
    model_runner.py run-experiment      payload {"experimentId": "..."} on stdin
    model_runner.py selftest

The sealed model lives under private/llm and never leaves this process except
through the committed leaf schemas in tee_runner/experiments.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import torch  # noqa: F401
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

from tee_runner import paths  # noqa: E402,F401  (sets HF env defaults)


def read_json_stdin():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def emit(payload) -> None:
    sys.__stdout__.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=["serve", "model-info", "registry", "validate-registry", "run-experiment", "selftest"],
    )
    args = parser.parse_args()

    if args.command == "serve":
        from tee_runner.worker import serve

        return serve()

    if args.command == "registry":
        from tee_runner.registry import public_registry

        emit({"ok": True, "result": public_registry(include_items=True)})
        return 0

    sys.stdout = sys.stderr  # keep library noise off the protocol channel
    from tee_runner.worker import Runner, dispatch

    runner = Runner(force_commitment=True)

    if args.command == "selftest":
        from tee_runner.selftest import run_selftest

        result = run_selftest(runner)
        emit(result)
        return 0 if result["ok"] else 1

    payload = read_json_stdin() if args.command == "run-experiment" else {}
    if not isinstance(payload, dict):
        emit({"ok": False, "error": {"code": "bad-request", "message": "Expected a JSON object."}})
        return 2
    response = dispatch(runner, {"id": "cli", "command": args.command, "payload": payload})
    emit(response)
    if not response.get("ok"):
        return 2
    if args.command == "validate-registry" and not response["result"].get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
