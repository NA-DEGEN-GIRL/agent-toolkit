#!/usr/bin/env python3
"""Regression test that malformed eval fields fail cleanly instead of crashing."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("check_evals.py")


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        catalog = root / "catalog.json"
        scenarios = root / "scenarios.json"
        catalog.write_text(
            json.dumps({"packages": [{"name": "demo"}]}),
            encoding="utf-8",
        )
        scenarios.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "cases": [
                        {
                            "id": ["not", "a", "string"],
                            "skills": [["unhashable"]],
                            "request": "request",
                            "expected": [1],
                            "forbidden": [""],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--scenarios",
                str(scenarios),
                "--catalog",
                str(catalog),
            ],
            text=True,
            capture_output=True,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        if result.returncode != 1:
            raise AssertionError(f"malformed eval should fail cleanly: {result.stdout}\n{result.stderr}")
        if "Traceback" in result.stderr:
            raise AssertionError(f"malformed eval crashed: {result.stderr}")
        for document in ([], None, "not an object"):
            scenarios.write_text(json.dumps(document), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--scenarios", str(scenarios), "--catalog", str(catalog)],
                text=True, capture_output=True, check=False,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            if result.returncode != 1 or "Traceback" in result.stderr:
                raise AssertionError("top-level malformed eval must fail without traceback")
    print("check_evals.py malformed-input test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
