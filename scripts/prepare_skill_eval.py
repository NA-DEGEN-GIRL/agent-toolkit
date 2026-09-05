#!/usr/bin/env python3
"""Prepare an inert, temporary forward-eval workspace without leaking assertions."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path, PurePosixPath, PureWindowsPath


ROOT = Path(__file__).resolve().parents[1]
MAX_FIXTURE_BYTES = 1024 * 1024


def relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("fixture paths must be non-empty POSIX relative paths")
    path = PurePosixPath(value)
    if path.is_absolute() or PureWindowsPath(value).drive or ".." in path.parts or not path.parts:
        raise ValueError("fixture path escapes the temporary workspace")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("fixture paths cannot contain control characters")
    return path


def validate_fixture(fixture: object) -> tuple[dict[str, str], dict[str, str]]:
    if not isinstance(fixture, dict) or set(fixture) != {"files", "symlinks"}:
        raise ValueError("fixture must contain files and symlinks objects")
    files, symlinks = fixture["files"], fixture["symlinks"]
    if not isinstance(files, dict) or not isinstance(symlinks, dict):
        raise ValueError("fixture entries must be objects")
    if len(files) + len(symlinks) > 200:
        raise ValueError("fixture has too many entries")
    paths = [relative_path(name) for name in [*files, *symlinks]]
    if len(paths) != len(set(paths)):
        raise ValueError("fixture paths collide")
    for path in paths:
        if any(parent in paths for parent in path.parents):
            raise ValueError("fixture file/symlink cannot be another entry's parent")
    if not all(isinstance(value, str) for value in [*files.values(), *symlinks.values()]):
        raise ValueError("fixture contents and link targets must be strings")
    if sum(len(value.encode("utf-8")) for value in files.values()) > MAX_FIXTURE_BYTES:
        raise ValueError("fixture exceeds the size limit")
    normalized_links: dict[str, str] = {}
    file_paths = {str(relative_path(name)) for name in files}
    for name, target in symlinks.items():
        if not target or PurePosixPath(target).is_absolute() or PureWindowsPath(target).drive or "\\" in target:
            raise ValueError("fixture links must use relative targets")
        # A link may escape repo/, but never the enclosing inert fixture root.
        resolved = os.path.normpath(str(relative_path(name).parent / target))
        relative_path(resolved)
        if resolved not in file_paths:
            raise ValueError("fixture links must point to a real fixture file")
        # Normalize before creation so a link chain cannot change how '..' resolves.
        normalized_links[name] = os.path.relpath(resolved, str(relative_path(name).parent))
    return files, normalized_links


def prepare(case_id: str, skill_name: str, *, root: Path = ROOT, parent: Path | None = None) -> dict[str, str]:
    cases = json.loads((root / "evals/scenarios.json").read_text(encoding="utf-8"))["cases"]
    case = next((case for case in cases if case["id"] == case_id), None)
    if case is None or skill_name not in case["skills"]:
        raise ValueError("select a registered case and one of its named skills")
    fixture_name = case.get("fixture")
    if fixture_name != f"{case_id}.json":
        raise ValueError("case has no registered inert fixture")
    fixture_path = root / "evals/fixtures" / fixture_name
    files, symlinks = validate_fixture(json.loads(fixture_path.read_text(encoding="utf-8")))
    packages = json.loads((root / "skills/catalog.json").read_text(encoding="utf-8"))["packages"]
    package = next(package for package in packages if package["name"] == skill_name)
    source = relative_path(package["source"])
    skill = root / str(source) / "SKILL.md"
    if not skill.is_file():
        raise ValueError("registered skill entrypoint is missing")
    workspace = Path(tempfile.mkdtemp(prefix="skill-eval-", dir=parent))
    try:
        for name, content in files.items():
            target = workspace / str(relative_path(name))
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("x", encoding="utf-8") as stream:
                stream.write(content)
            target.chmod(0o600)
        for name, target in symlinks.items():
            link = workspace / str(relative_path(name))
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(target)
        repo = workspace / "repo"
        if not repo.is_dir() or repo.is_symlink():
            raise ValueError("fixture must contain a real repo directory")
        # Deliberately export only raw request/setup, never expected/forbidden.
        prompt = f"Use the skill at {skill.resolve()}.\nTarget repository: {repo}\n\n{case['request']}"
        return {"case": case_id, "skill": skill_name, "fixture_root": str(workspace), "repo": str(repo), "prompt": prompt}
    except BaseException:
        shutil.rmtree(workspace)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    parser.add_argument("--skill", required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.case, args.skill)
    except (ValueError, KeyError, OSError) as exc:
        parser.exit(2, f"Error: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
