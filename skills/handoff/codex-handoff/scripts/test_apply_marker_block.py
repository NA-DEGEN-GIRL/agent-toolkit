#!/usr/bin/env python3
"""Smoke tests for apply_marker_block.py."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import stat
from pathlib import Path
from unittest import mock

import apply_marker_block as marker
from snapshot_common import open_directory_handle

SCRIPT = Path(__file__).with_name("apply_marker_block.py")
BLOCK1 = """<!-- BEGIN handoff-rule -->
## Handoff / Clear Session Rule
first
<!-- END handoff-rule -->
"""
BLOCK2 = """<!-- BEGIN handoff-rule -->
## Handoff / Clear Session Rule
second
<!-- END handoff-rule -->
"""


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def run(cmd: list[str], input_text: str | None = None, check_result: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, input=input_text, text=True, capture_output=True, check=check_result)


def test_exchange_rechecks_displaced_content() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        target = root / "AGENTS.md"
        target.write_text("original\n")
        with open_directory_handle(root, root) as handle:
            original, mode, token = marker.read_text(handle, target.name)
            updated, _ = marker.apply_block(original, BLOCK1, marker.DEFAULT_BEGIN, marker.DEFAULT_END)
            real_exchange = marker.rename_exchange_at
            calls = 0

            def concurrent_edit(fd: int, left: str, right: str) -> None:
                nonlocal calls
                calls += 1
                if calls == 1:
                    target.write_text("unrelated concurrent user edit\n")
                real_exchange(fd, left, right)

            with mock.patch.object(marker, "rename_exchange_at", side_effect=concurrent_edit):
                try:
                    marker.atomic_write(handle, target.name, updated, mode, token)
                except ValueError:
                    pass
                else:
                    raise AssertionError("concurrent edit must report a conflict")
        check(target.read_text() == "unrelated concurrent user edit\n", "exchange lost the concurrent edit")
        check(not list(root.glob(".*.tmp")), "successful restoration left unnecessary recovery files")


def test_second_writer_during_rollback_is_preserved() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        target = root / "AGENTS.md"
        target.write_text("original\n")
        with open_directory_handle(root, root) as handle:
            _, mode, token = marker.read_text(handle, target.name)
            real_exchange = marker.rename_exchange_at
            calls = 0

            def racing_rollback(fd: int, left: str, right: str) -> None:
                nonlocal calls
                calls += 1
                if calls == 1:
                    target.write_text("first concurrent edit\n")
                elif calls == 2:
                    # Modify our inode in place immediately before rollback:
                    # checking inode identity alone would delete this edit.
                    target.write_text("later concurrent edit\n")
                real_exchange(fd, left, right)

            with mock.patch.object(marker, "rename_exchange_at", side_effect=racing_rollback):
                try:
                    marker.atomic_write(handle, target.name, "our marker update\n", mode, token)
                except ValueError as exc:
                    check("preserved" in str(exc), "unrestored conflict must identify recovery state")
                else:
                    raise AssertionError("racing rollback must report a conflict")
        check(target.read_text() == "later concurrent edit\n", "later writer did not retain its pathname")
        backups = list(root.glob(".*.tmp"))
        check(len(backups) == 1 and backups[0].read_text() == "first concurrent edit\n", "displaced edit was not retained")


def test_first_create_does_not_clobber_and_exchange_unavailable_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        target = root / "AGENTS.md"
        with open_directory_handle(root, root) as handle:
            real_link = marker.os.link

            def concurrent_create(*args: object, **kwargs: object) -> None:
                target.write_text("concurrent first file\n")
                real_link(*args, **kwargs)

            with mock.patch.object(marker.os, "link", side_effect=concurrent_create):
                try:
                    marker.atomic_write(handle, target.name, BLOCK1, None, None)
                except FileExistsError:
                    pass
                else:
                    raise AssertionError("first-create race must fail without overwrite")
            check(target.read_text() == "concurrent first file\n", "first-create race lost user content")
            _, mode, token = marker.read_text(handle, target.name)
            with mock.patch.object(marker, "rename_exchange_available", return_value=False):
                try:
                    marker.atomic_write(handle, target.name, BLOCK1, mode, token)
                except ValueError:
                    pass
                else:
                    raise AssertionError("missing exchange must fail closed")
            check(target.read_text() == "concurrent first file\n", "unsupported exchange mutated target")
            check(not list(root.glob(".*.tmp")), "failed first-create left a temporary file")


def main() -> int:
    test_exchange_rechecks_displaced_content()
    test_second_writer_during_rollback_is_preserved()
    test_first_create_does_not_clobber_and_exchange_unavailable_fails_closed()
    repeated, _ = marker.apply_block(BLOCK1, BLOCK1, marker.DEFAULT_BEGIN, marker.DEFAULT_END)
    check(repeated == BLOCK1, "marker at start of file must be byte-idempotent")
    with tempfile.TemporaryDirectory() as td:
        target = Path(td) / "CODEX.md"
        target.write_text("# Existing\n", encoding="utf-8")
        target.chmod(0o640)
        run([sys.executable, str(SCRIPT), "--root", td, "--file", str(target)], BLOCK1)
        text = target.read_text(encoding="utf-8")
        check("# Existing" in text and "first" in text, "block should be inserted")
        check(stat.S_IMODE(target.stat().st_mode) == 0o640, "existing target mode should be preserved")
        run([sys.executable, str(SCRIPT), "--root", td, "--file", str(target)], BLOCK2)
        text = target.read_text(encoding="utf-8")
        check("second" in text and "first" not in text, "block should be replaced idempotently")

        broken = Path(td) / "BROKEN.md"
        broken.write_text("before\n<!-- BEGIN handoff-rule -->\npartial\n", encoding="utf-8")
        result = run([sys.executable, str(SCRIPT), "--root", td, "--file", str(broken)], BLOCK1, check_result=False)
        check(result.returncode == 2, "partial marker target should fail")

        duplicate = Path(td) / "DUPLICATE.md"
        duplicate.write_text(BLOCK1 + "\n" + BLOCK2, encoding="utf-8")
        duplicate_result = run([sys.executable, str(SCRIPT), "--root", td, "--file", str(duplicate)], BLOCK1, check_result=False)
        check(duplicate_result.returncode == 2 and "duplicate markers" in duplicate_result.stderr, "duplicate target markers should fail")

        duplicate_block = BLOCK1 + "\n<!-- BEGIN handoff-rule -->\n"
        block_result = run([sys.executable, str(SCRIPT), "--root", td, "--file", str(target)], duplicate_block, check_result=False)
        check(block_result.returncode == 2 and "exactly once" in block_result.stderr, "duplicate input markers should fail")

        repo = Path(td) / "repo"
        outside = Path(td) / "outside"
        repo.mkdir()
        outside.mkdir()
        outside_target = outside / "CODEX.md"
        outside_target.write_text("outside sentinel\n", encoding="utf-8")
        (repo / "link").symlink_to(outside, target_is_directory=True)
        escaped = run(
            [sys.executable, str(SCRIPT), "--root", str(repo), "--file", str(repo / "link" / "CODEX.md")],
            BLOCK1,
            check_result=False,
        )
        check(escaped.returncode == 2, "symlinked parent should be rejected")
        check(outside_target.read_text() == "outside sentinel\n", "symlink parent escaped trusted root")
    print("apply_marker_block.py smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
