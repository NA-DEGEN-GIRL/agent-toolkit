#!/usr/bin/env python3
"""Atomicity, CAS, path, and retention tests for save_snapshot.py."""
from __future__ import annotations

import hashlib
import contextlib
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

import save_snapshot as saver

SCRIPT = Path(__file__).with_name("save_snapshot.py")


def snapshot(agent: str = "codex", scope: str | None = None, goal: str = "goal") -> str:
    scope_line = f"- Scope: {scope}\n" if scope else ""
    return (
        "# Handoff Snapshot\n\n## Metadata\n"
        "- Schema Version: handoff-v1\n"
        "- Skill Version: 0.1.11\n"
        f"- Skill Variant: {agent}-handoff\n"
        f"- Agent: {agent}\n"
        f"{scope_line}"
        "- Created at: 2026-07-09T00:00:00Z\n\n"
        f"## Project Goal\n- {goal}\n"
    )


def run_save(
    root: Path,
    text: str,
    *args: str,
    check_result: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), "--agent", "codex", *args],
        input=text,
        text=True,
        capture_output=True,
        check=check_result,
    )


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_initial_save_parity_and_retention() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        first = snapshot(goal="first")
        result = run_save(root, first, "--expect-no-latest", "--timestamp", "2026-07-09-000001")
        lane = root / ".handoff"
        backup = lane / "2026-07-09-000001-codex.md"
        latest = lane / "latest.md"
        check(backup.read_text(encoding="utf-8") == first, "backup content mismatch")
        check(latest.read_bytes() == backup.read_bytes(), "latest/backup must be byte-identical")
        check("Parity: verified" in result.stdout, "parity result missing")

        run_save(
            root,
            snapshot(goal="second"),
            "--expected-latest-sha256",
            digest(latest),
            "--timestamp",
            "2026-07-09-000002",
            "--keep",
            "2",
        )
        run_save(
            root,
            snapshot(goal="third"),
            "--expected-latest-sha256",
            digest(latest),
            "--timestamp",
            "2026-07-09-000003",
            "--keep",
            "2",
        )
        names = sorted(path.name for path in lane.glob("*-codex.md"))
        check(names == ["2026-07-09-000002-codex.md", "2026-07-09-000003-codex.md"], "retention should keep newest two")
        check("third" in latest.read_text(encoding="utf-8"), "latest should contain newest save")


def test_collision_does_not_overwrite() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        run_save(root, snapshot(goal="old"), "--timestamp", "2026-07-09-000001")
        lane = root / ".handoff"
        collision = lane / "2026-07-09-000002-codex.md"
        collision.write_text("collision sentinel\n", encoding="utf-8")
        before = (lane / "latest.md").read_bytes()
        result = run_save(root, snapshot(goal="new"), "--timestamp", "2026-07-09-000002", check_result=False)
        check(result.returncode == 2 and "already exists" in result.stderr, "collision must fail")
        check(collision.read_text(encoding="utf-8") == "collision sentinel\n", "backup collision was overwritten")
        check((lane / "latest.md").read_bytes() == before, "latest changed on backup collision")


def test_cas_and_recent_other_are_backup_only() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        old = snapshot(goal="old")
        run_save(root, old, "--timestamp", "2026-07-09-000001")
        latest = root / ".handoff" / "latest.md"
        before = latest.read_bytes()
        result = run_save(
            root,
            snapshot(goal="cas conflict"),
            "--expected-latest-sha256",
            "0" * 64,
            "--timestamp",
            "2026-07-09-000002",
            check_result=False,
        )
        check(result.returncode == 3 and "NOT UPDATED" in result.stdout, "CAS mismatch should be backup-only")
        check(latest.read_bytes() == before, "CAS mismatch changed latest")
        check((root / ".handoff" / "2026-07-09-000002-codex.md").exists(), "CAS backup missing")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        lane.mkdir()
        foreign = snapshot(agent="claude", goal="foreign")
        (lane / "latest.md").write_text(foreign, encoding="utf-8")
        os.utime(lane / "latest.md", None)
        result = run_save(root, snapshot(goal="codex"), "--timestamp", "2026-07-09-000001", check_result=False)
        check(result.returncode == 3 and "different agent" in result.stdout, "recent foreign writer must protect latest")
        check((lane / "latest.md").read_text(encoding="utf-8") == foreign, "foreign latest was overwritten")
        check((lane / "2026-07-09-000001-codex.md").exists(), "recent conflict backup missing")
        allowed = run_save(
            root,
            snapshot(goal="allowed"),
            "--allow-recent-other-agent",
            "--expected-latest-sha256",
            digest(lane / "latest.md"),
            "--timestamp",
            "2026-07-09-000002",
        )
        check(allowed.returncode == 0 and "allowed" in (lane / "latest.md").read_text(encoding="utf-8"), "explicit override should update")


def test_exact_cas_and_scoped_save() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        old = snapshot(goal="old")
        run_save(root, old, "--timestamp", "2026-07-09-000001")
        digest = hashlib.sha256(old.encode()).hexdigest()
        result = run_save(
            root,
            snapshot(goal="new"),
            "--expected-latest-sha256",
            digest,
            "--timestamp",
            "2026-07-09-000002",
        )
        check(result.returncode == 0, "exact CAS should update")

        scoped = run_save(
            root,
            snapshot(scope="auth", goal="scoped"),
            "--scope",
            "auth",
            "--timestamp",
            "2026-07-09-000003",
        )
        check(scoped.returncode == 0, "scoped save should succeed")
        scoped_lane = root / ".handoff" / "scopes" / "auth"
        check((scoped_lane / "latest.md").exists(), "scoped latest missing")
        check((scoped_lane / "2026-07-09-000003-codex.md").exists(), "scoped backup missing")


def test_unsafe_and_invalid_inputs_write_nothing() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        invalid_scope = run_save(root, snapshot(scope="../evil"), "--scope", "../evil", check_result=False)
        check(invalid_scope.returncode == 2 and not (root / ".handoff").exists(), "invalid scope must not create files")

        oversized = run_save(root, "x" * 65, "--max-bytes", "64", check_result=False)
        check(oversized.returncode == 2 and not (root / ".handoff").exists(), "oversized input must not create files")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        outside = root / "outside"
        outside.mkdir()
        target = outside / "latest.md"
        target.write_text(snapshot(goal="target"), encoding="utf-8")
        (root / ".handoff").symlink_to(outside, target_is_directory=True)
        before = target.read_bytes()
        result = run_save(root, snapshot(goal="attack"), "--timestamp", "2026-07-09-000001", check_result=False)
        check(result.returncode == 2 and "directory traversal failed" in result.stderr, "symlinked handoff must fail")
        check(target.read_bytes() == before, "symlink target changed")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        lane.mkdir()
        target = root / "target.md"
        target.write_text(snapshot(goal="target"), encoding="utf-8")
        (lane / "latest.md").symlink_to(target)
        result = run_save(root, snapshot(goal="attack"), "--timestamp", "2026-07-09-000001", check_result=False)
        check(result.returncode == 2 and "symlinked or non-regular" in result.stderr, "symlink latest must fail")
        check("target" in target.read_text(encoding="utf-8"), "latest symlink target changed")
        check(not (lane / "2026-07-09-000001-codex.md").exists(), "unsafe latest must fail before backup")


def test_lock_is_auto_releasing_and_concurrent_lock_fails() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        lane.mkdir()
        lock = lane / ".save.lock"
        lock.write_text("stale pid from crashed process\n", encoding="utf-8")
        recovered = run_save(root, snapshot(), "--timestamp", "2026-07-09-000001")
        check(recovered.returncode == 0, "an unlocked stale lock file must not block save")

        if fcntl is None:
            return
        fd = os.open(lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            blocked = run_save(root, snapshot(goal="blocked"), "--timestamp", "2026-07-09-000002", check_result=False)
            check(blocked.returncode == 2 and "holds the lane lock" in blocked.stderr, "active concurrent lock must fail")
            check(not (lane / "2026-07-09-000002-codex.md").exists(), "blocked save created a backup")
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def test_existing_requires_cas_and_invalid_recovery_is_explicit() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        run_save(root, snapshot(goal="old"), "--timestamp", "2026-07-09-000001")
        latest = root / ".handoff" / "latest.md"
        before = latest.read_bytes()
        result = run_save(root, snapshot(goal="no cas"), "--timestamp", "2026-07-09-000002", check_result=False)
        check(result.returncode == 3 and "requires --expected" in result.stdout, "existing latest must require CAS")
        check(latest.read_bytes() == before, "unconditional attempt changed latest")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        lane.mkdir()
        (lane / "latest.md").write_text("truncated garbage\n", encoding="utf-8")
        refused = run_save(root, snapshot(), "--timestamp", "2026-07-09-000001", check_result=False)
        check(refused.returncode == 2 and "--replace-invalid-latest" in refused.stderr, "invalid latest needs explicit recovery")
        check(not (lane / "2026-07-09-000001-codex.md").exists(), "refused invalid recovery created backup")
        recovered = run_save(
            root,
            snapshot(goal="recovered"),
            "--replace-invalid-latest",
            "--timestamp",
            "2026-07-09-000002",
        )
        check(recovered.returncode == 0 and "recovered" in (lane / "latest.md").read_text(), "explicit invalid recovery failed")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane = root / ".handoff"
        lane.mkdir()
        foreign = snapshot(agent="claude", goal="valid foreign")
        (lane / "latest.md").write_text(foreign, encoding="utf-8")
        attempt = run_save(
            root,
            snapshot(goal="must not overwrite"),
            "--replace-invalid-latest",
            "--timestamp",
            "2026-07-09-000001",
            check_result=False,
        )
        check(attempt.returncode == 3, "invalid-recovery flag must not bypass valid-latest CAS")
        check((lane / "latest.md").read_text(encoding="utf-8") == foreign, "valid foreign latest was overwritten")


def test_lock_backend_fails_closed_when_unavailable() -> None:
    old_fcntl, old_msvcrt = saver.fcntl, saver.msvcrt
    try:
        saver.fcntl = None
        saver.msvcrt = None
        try:
            saver.lock_backend()
        except saver.SnapshotError as exc:
            check("refusing unsafe save" in str(exc), "missing lock backend should fail closed")
        else:
            raise AssertionError("missing lock backend was accepted")
    finally:
        saver.fcntl, saver.msvcrt = old_fcntl, old_msvcrt

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        run_save(root, snapshot(), "--timestamp", "2026-07-09-000001")
        latest = root / ".handoff" / "latest.md"
        draft = root / "draft.md"
        draft.write_text(snapshot(goal="unsupported"), encoding="utf-8")
        argv = [
            str(SCRIPT), "--root", str(root), "--agent", "codex", "--input", str(draft),
            "--expected-latest-sha256", digest(latest), "--timestamp", "2026-07-09-000002",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            saver, "rename_exchange_available", return_value=False
        ):
            rc = saver.main()
        check(rc == 2, "missing atomic exchange should fail before write")
        check(not (root / ".handoff" / "2026-07-09-000002-codex.md").exists(), "unsupported platform wrote backup")


def test_noncooperating_race_is_backup_only() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        run_save(root, snapshot(goal="old"), "--timestamp", "2026-07-09-000001")
        latest = root / ".handoff" / "latest.md"
        expected = digest(latest)
        draft = root / "draft.md"
        draft.write_text(snapshot(goal="ours"), encoding="utf-8")
        external = snapshot(agent="claude", goal="external").encode()
        original_exchange = saver.rename_exchange_at
        raced = False

        def racing_exchange(directory_fd: int, left: str, right: str) -> None:
            nonlocal raced
            if not raced:
                raced = True
                race_name = ".external-race.tmp"
                fd = os.open(race_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
                try:
                    os.write(fd, external)
                finally:
                    os.close(fd)
                os.replace(race_name, "latest.md", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            original_exchange(directory_fd, left, right)

        argv = [
            str(SCRIPT), "--root", str(root), "--agent", "codex", "--input", str(draft),
            "--expected-latest-sha256", expected, "--timestamp", "2026-07-09-000002",
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            saver, "rename_exchange_at", side_effect=racing_exchange
        ):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                rc = saver.main()
        check(rc == 3 and "NOT UPDATED" in stdout.getvalue(), "racing writer should produce backup-only")
        check(latest.read_bytes() == external, "racing external latest was overwritten")


def test_partial_retention_failure_reports_persisted_state() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        draft = root / "draft.md"
        draft.write_text(snapshot(goal="partial"), encoding="utf-8")
        argv = [
            str(SCRIPT), "--root", str(root), "--agent", "codex", "--input", str(draft),
            "--timestamp", "2026-07-09-000001",
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            saver, "prune_saved_agent", side_effect=saver.SnapshotError("simulated retention failure")
        ):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                rc = saver.main()
        check(rc == 4 and "SAVE PARTIAL" in stdout.getvalue(), "post-write failure must report partial save")
        check("latest.md replaced: yes" in stdout.getvalue(), "partial report must state latest persistence")
        check((root / ".handoff" / "latest.md").exists(), "partial latest should actually persist")


def test_integrated_retention_preserves_racing_replacement() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        lane_path = root / ".handoff"
        lane_path.mkdir()
        old_name = "2026-07-09-000001-codex.md"
        keep_name = "2026-07-09-000002-codex.md"
        (lane_path / old_name).write_text("old\n", encoding="utf-8")
        (lane_path / keep_name).write_text("keep\n", encoding="utf-8")
        replacement = b"racing replacement\n"
        original_rename = saver.os.rename
        raced = False

        def racing_rename(src: str, dst: str, **kwargs: object) -> None:
            nonlocal raced
            if src == old_name and not raced:
                raced = True
                directory_fd = int(kwargs["src_dir_fd"])
                race_name = ".retention-race.tmp"
                fd = os.open(race_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
                try:
                    os.write(fd, replacement)
                finally:
                    os.close(fd)
                os.replace(race_name, old_name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            original_rename(src, dst, **kwargs)

        lane = saver.Lane(None, lane_path, root)
        with saver.open_directory_handle(root, lane_path) as handle, mock.patch.object(
            saver.os, "rename", side_effect=racing_rename
        ):
            try:
                saver.prune_saved_agent(handle, lane, "codex", 1, keep_name)
            except saver.SnapshotError as exc:
                check("replacement preserved" in str(exc), "retention race was not reported safely")
            else:
                raise AssertionError("retention race should fail closed")
        preserved = [path for path in lane_path.iterdir() if path.is_file() and path.read_bytes() == replacement]
        check(bool(preserved), "racing replacement was deleted by integrated retention")


def test_writer_racing_rollback_is_preserved(inplace: bool = False) -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        run_save(root, snapshot(goal="A"), "--timestamp", "2026-07-09-000001")
        latest = root / ".handoff" / "latest.md"
        expected = digest(latest)
        draft = root / "draft.md"
        draft.write_text(snapshot(goal="ours"), encoding="utf-8")
        writer_b = snapshot(agent="claude", goal="B").encode()
        writer_c = snapshot(agent="claude", goal="C").encode()
        original_exchange = saver.rename_exchange_at
        exchange_count = 0

        def replace_latest(directory_fd: int, payload: bytes, name: str) -> None:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
            try:
                os.write(fd, payload)
            finally:
                os.close(fd)
            os.replace(name, "latest.md", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)

        def racing_exchange(directory_fd: int, left: str, right: str) -> None:
            nonlocal exchange_count
            exchange_count += 1
            if exchange_count == 1:
                replace_latest(directory_fd, writer_b, ".writer-b.tmp")
            elif exchange_count == 2:
                if inplace:
                    latest.write_bytes(writer_c)
                else:
                    replace_latest(directory_fd, writer_c, ".writer-c.tmp")
            original_exchange(directory_fd, left, right)

        argv = [
            str(SCRIPT), "--root", str(root), "--agent", "codex", "--input", str(draft),
            "--expected-latest-sha256", expected, "--timestamp", "2026-07-09-000002",
        ]
        stdout = io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            saver, "rename_exchange_at", side_effect=racing_exchange
        ), contextlib.redirect_stdout(stdout):
            rc = saver.main()
        check(rc == 3, "rollback race should be a protected backup-only result")
        check(latest.read_bytes() == writer_c, "writer racing rollback was not preserved as latest")
        check("Preserved displaced snapshot" in stdout.getvalue(), "displaced writer B was not reported")


def test_lane_swap_never_redirects_writes() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        outside = root / "outside"
        outside.mkdir()
        draft = root / "draft.md"
        draft.write_text(snapshot(), encoding="utf-8")
        original_write = saver.write_exclusive_at
        swapped = False

        def swap_before_write(handle: object, name: str, data: bytes, mode: int = 0o600) -> None:
            nonlocal swapped
            if name.endswith("-codex.md") and not swapped:
                swapped = True
                (root / ".handoff").rename(root / ".handoff-moved")
                (root / ".handoff").symlink_to(outside, target_is_directory=True)
            original_write(handle, name, data, mode)

        argv = [
            str(SCRIPT), "--root", str(root), "--agent", "codex", "--input", str(draft),
            "--timestamp", "2026-07-09-000001",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(
            saver, "write_exclusive_at", side_effect=swap_before_write
        ):
            rc = saver.main()
        check(rc == 2, "lane identity swap before backup should fail")
        check(not any(outside.iterdir()), "lane swap redirected a write outside root")


def main() -> int:
    test_initial_save_parity_and_retention()
    test_collision_does_not_overwrite()
    test_cas_and_recent_other_are_backup_only()
    test_exact_cas_and_scoped_save()
    test_unsafe_and_invalid_inputs_write_nothing()
    test_lock_is_auto_releasing_and_concurrent_lock_fails()
    test_existing_requires_cas_and_invalid_recovery_is_explicit()
    test_lock_backend_fails_closed_when_unavailable()
    test_noncooperating_race_is_backup_only()
    test_partial_retention_failure_reports_persisted_state()
    test_integrated_retention_preserves_racing_replacement()
    test_writer_racing_rollback_is_preserved()
    test_writer_racing_rollback_is_preserved(inplace=True)
    test_lane_swap_never_redirects_writes()
    print("save_snapshot.py safety tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
