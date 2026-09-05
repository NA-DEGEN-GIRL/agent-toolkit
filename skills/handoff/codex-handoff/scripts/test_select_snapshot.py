#!/usr/bin/env python3
"""Deterministic same-lane selection tests for select_snapshot.py."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import contextlib
import io
from pathlib import Path
from unittest import mock

import select_snapshot as selector

SCRIPT = Path(__file__).with_name("select_snapshot.py")


def snapshot(scope: str | None, goal: str = "goal") -> str:
    scope_line = f"- Scope: {scope}\n" if scope else ""
    return (
        "# Handoff Snapshot\n\n## Metadata\n"
        "- Schema Version: handoff-v1\n- Agent: codex\n"
        "- Created at: 2026-07-09T00:00:00Z\n"
        f"{scope_line}\n## Project Goal\n- {goal}\n"
    )


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run(root: Path, *args: str, check_result: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), *args],
        text=True,
        capture_output=True,
        check=check_result,
    )


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_latest_precedence() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        write(lane / "latest.md", snapshot(None, "latest"))
        write(lane / "2026-07-09-235959-codex.md", snapshot(None, "new backup"))
        result = run(root, "--path-only")
        check(result.stdout.strip() == ".handoff/latest.md", "valid latest must win over backups")


def test_invalid_latest_and_newest_invalid_fallback() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        write(lane / "latest.md", "invalid\n")
        write(lane / "2026-07-09-000003-codex.md", "invalid newest\n")
        write(lane / "2026-07-09-000002-codex.md", snapshot(None, "chosen"))
        write(lane / "2026-07-09-000001-codex.md", snapshot(None, "old"))
        result = run(root)
        check("2026-07-09-000002-codex.md" in result.stdout, "newest valid backup should be selected")
        check(result.stdout.count("Skipped:") == 2, "both invalid candidates should be reported")


def test_scoped_orphan_and_no_cross_lane_fallback() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        write(root / ".handoff" / "latest.md", snapshot(None, "default"))
        orphan = root / ".handoff" / "scopes" / "auth"
        write(orphan / "2026-07-09-000001-codex.md", snapshot("auth", "orphan"))
        selected = run(root, "--scope", "auth", "--path-only")
        check("scopes/auth/2026-07-09-000001-codex.md" in selected.stdout, "orphan scoped backup should select")

        bad_lane = root / ".handoff" / "scopes" / "broken"
        write(bad_lane / "latest.md", snapshot("wrong", "mismatch"))
        failed = run(root, "--scope", "broken", check_result=False)
        check(failed.returncode == 1, "invalid scoped lane should have no selection")
        check(".handoff/latest.md" not in failed.stdout, "scoped selection must never fall back to default")


def test_symlink_latest_is_skipped() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        lane.mkdir()
        target = root / "outside.md"
        target.write_text(snapshot(None), encoding="utf-8")
        (lane / "latest.md").symlink_to(target)
        write(lane / "2026-07-09-000001-codex.md", snapshot(None, "safe"))
        result = run(root)
        check("2026-07-09-000001-codex.md" in result.stdout, "symlink latest should be skipped")
        check("symlink" in result.stdout, "symlink rejection should be reported")


def test_sensitive_and_long_paths_have_lossless_machine_output() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for scope in ("secrets", "credentials", "s" * 230, "sk-syntheticnotasecret"):
            expected = root / ".handoff" / "scopes" / scope / "latest.md"
            write(expected, snapshot(scope, "selected goal"))
            selected = run(root, "--scope", scope, "--path-only")
            check(root / selected.stdout.rstrip("\n") == expected, "machine path was redacted or truncated")
            check((root / selected.stdout.rstrip("\n")).is_file(), "machine path does not exist")
            shown = run(root, "--scope", scope)
            check("use --content" in shown.stdout, "display output must not imply it is a reopenable pathname")
            if scope.startswith("sk-"):
                check(scope not in shown.stdout, "default report exposed a credential-like scope")
            content = run(root, "--scope", scope, "--content")
            check("# Handoff Snapshot\n" in content.stdout and "selected goal" in content.stdout, "content mode did not read selected snapshot")
            check("SELECTED DISPLAY:" in content.stderr, "content mode lost redacted selection diagnostics")


def test_content_redacts_sensitive_values_without_losing_markdown_structure() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        data = snapshot(None) + "\n## Notes\n- owner@example.invalid\n- https://internal.invalid/private\n- api_key=synthetic-only-value\n```text\n  safe indented data\n```\n"
        write(root / ".handoff" / "latest.md", data)
        result = run(root, "--content")
        for sensitive in ("owner@example.invalid", "internal.invalid", "synthetic-only-value"):
            check(sensitive not in result.stdout, "content mode disclosed a recognized sensitive value")
        check("## Notes\n" in result.stdout and "```text\n  safe indented data\n```" in result.stdout, "content redaction damaged Markdown structure")


def test_content_does_not_reopen_after_validation() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        target = root / ".handoff" / "latest.md"
        write(target, snapshot(None, "validated original"))
        real_select = selector.select_valid_snapshot

        def replace_after_selection(*args: object, **kwargs: object) -> object:
            selected = real_select(*args, **kwargs)
            target.write_text("unvalidated replacement must not be read\n")
            return selected

        output = io.StringIO()
        with mock.patch.object(sys, "argv", [str(SCRIPT), "--root", str(root), "--content"]), mock.patch.object(selector, "select_valid_snapshot", side_effect=replace_after_selection), contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            code = selector.main()
        check(code == 0 and "validated original" in output.getvalue(), "content mode lost the validated bytes")
        check("unvalidated replacement" not in output.getvalue(), "content mode reopened a changed pathname")


def main() -> int:
    test_latest_precedence()
    test_invalid_latest_and_newest_invalid_fallback()
    test_scoped_orphan_and_no_cross_lane_fallback()
    test_symlink_latest_is_skipped()
    test_sensitive_and_long_paths_have_lossless_machine_output()
    test_content_redacts_sensitive_values_without_losing_markdown_structure()
    test_content_does_not_reopen_after_validation()
    print("select_snapshot.py safety tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
