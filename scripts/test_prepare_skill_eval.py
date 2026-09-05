#!/usr/bin/env python3
"""Check isolated fixture materialization and assertion-free forward prompts."""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from prepare_skill_eval import ROOT, prepare, validate_fixture


def main() -> int:
    cases = json.loads((ROOT / "evals/scenarios.json").read_text(encoding="utf-8"))["cases"]
    with tempfile.TemporaryDirectory() as raw:
        for case in cases:
            if "fixture" not in case:
                continue
            for skill in case["skills"]:
                result = prepare(case["id"], skill, parent=Path(raw))
                try:
                    repo = Path(result["repo"])
                    assert repo.is_dir()
                    assert case["request"] in result["prompt"]
                    for assertion in [*case["expected"], *case["forbidden"]]:
                        assert assertion not in result["prompt"], "grader assertion leaked"
                    fixture = json.loads((ROOT / "evals/fixtures" / case["fixture"]).read_text())
                    for name, content in fixture["files"].items():
                        assert (Path(result["fixture_root"]) / name).read_text() == content
                    for name in fixture["symlinks"]:
                        target = Path(result["fixture_root"]) / name
                        assert target.is_symlink()
                        assert target.resolve().is_relative_to(Path(result["fixture_root"]))
                finally:
                    shutil.rmtree(result["fixture_root"])
        assert not list(Path(raw).iterdir())
    invalid = [
        {"files": {"../escape": "x"}, "symlinks": {}},
        {"files": {"/escape": "x"}, "symlinks": {}},
        {"files": {"C:/escape": "x"}, "symlinks": {}},
        {"files": {"C:escape": "x"}, "symlinks": {}},
        {"files": {"repo/link/child": "x"}, "symlinks": {"repo/link": "../outside"}},
        {"files": {"repo/a": "x", "repo/./a": "y"}, "symlinks": {}},
        {"files": {"repo/a": "x"}, "symlinks": {"repo/link": "../../escape"}},
        {"files": {"repo/a": 3}, "symlinks": {}},
    ]
    for fixture in invalid:
        try:
            validate_fixture(fixture)
        except ValueError:
            pass
        else:
            raise AssertionError("unsafe fixture accepted")
    print("prepare_skill_eval.py isolated-fixture tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
