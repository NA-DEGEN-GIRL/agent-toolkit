#!/usr/bin/env python3
"""Smoke tests for the safe skill installer using isolated temporary homes."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import importlib.util
import contextlib
import io
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("install_skill.py")
REPO_ROOT = Path(__file__).resolve().parents[1]


def load_installer_module():
    spec = importlib.util.spec_from_file_location("repo_install_skill", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load installer module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if check and result.returncode != 0:
        raise AssertionError(
            f"command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}\n{result.stderr}"
        )
    return result


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_copy_backup_doctor_and_rollback() -> None:
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        common = ("--agent", "codex", "--skill", "distill-ramble", "--agent-home", str(home))

        dry = run("install", *common)
        check("No changes made" in dry.stdout, "install must be dry-run by default")
        check(not (home / "skills").exists(), "dry-run created the skills directory")

        run("install", *common, "--apply")
        dest = home / "skills" / "distill-ramble"
        check((dest / "SKILL.md").is_file(), "copy install did not create the package")
        check(not list((home / "skills").glob("*.bak.*")), "backup leaked into discovery root")

        (dest / "VERSION").write_text("0.0.0\n", encoding="utf-8")
        run("install", *common, "--apply")
        backups = sorted((home / "skill-backups" / "distill-ramble").glob("*/payload"))
        check(len(backups) == 1, "replacement did not create exactly one external backup")
        check((backups[0] / "VERSION").read_text(encoding="utf-8").strip() == "0.0.0", "wrong backup payload")

        doctor = run("doctor", *common)
        check("OK distill-ramble" in doctor.stdout, "doctor did not report current install")

        run("rollback", *common, "--apply")
        check((dest / "VERSION").read_text(encoding="utf-8").strip() == "0.0.0", "rollback did not restore backup")


def test_symlink_replaces_directory_instead_of_nesting() -> None:
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "claude"
        dest = home / "skills" / "orient-repo"
        dest.mkdir(parents=True)
        (dest / "old.txt").write_text("old\n", encoding="utf-8")
        run(
            "install",
            "--agent",
            "claude",
            "--skill",
            "orient-repo",
            "--agent-home",
            str(home),
            "--mode",
            "symlink",
            "--apply",
        )
        check(dest.is_symlink(), "symlink mode left a directory at the destination")
        check(not (dest / "orient-repo").is_symlink(), "installer created a nested symlink")
        payloads = list((home / "skill-backups" / "orient-repo").glob("*/payload"))
        check(len(payloads) == 1 and (payloads[0] / "old.txt").is_file(), "old directory was not backed up")

        run(
            "rollback",
            "--agent",
            "claude",
            "--skill",
            "orient-repo",
            "--agent-home",
            str(home),
            "--apply",
        )
        check(not dest.is_symlink() and (dest / "old.txt").is_file(), "rollback did not restore the arbitrary old directory")


def test_doctor_reports_discoverable_duplicate() -> None:
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        common = ("--agent", "codex", "--skill", "orient-repo", "--agent-home", str(home))
        run("install", *common, "--apply")
        duplicate = home / "skills" / "orient-repo.bak.legacy"
        shutil.copytree(REPO_ROOT / "skills" / "repo-orientation" / "orient-repo", duplicate)
        result = run("doctor", *common, check=False)
        check(result.returncode == 1, "doctor must fail when a duplicate is discoverable")
        check("DUPLICATE" in result.stdout, "doctor did not identify the duplicate")


def test_backup_root_inside_discovery_is_rejected() -> None:
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        result = run(
            "install",
            "--agent",
            "codex",
            "--skill",
            "orient-repo",
            "--agent-home",
            str(home),
            "--backup-root",
            str(home / "skills" / "backups"),
            check=False,
        )
        check(result.returncode == 2, "unsafe backup root must be rejected")
        check("outside the agent skills" in result.stderr, "unsafe backup error was not actionable")


def test_source_tree_symlink_is_rejected() -> None:
    if not hasattr(os, "symlink"):
        return
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw:
        source = Path(raw) / "package"
        source.mkdir()
        (source / "SKILL.md").write_text("---\nname: demo\n---\n", encoding="utf-8")
        outside = Path(raw) / "outside.txt"
        outside.write_text("private\n", encoding="utf-8")
        try:
            (source / "linked.txt").symlink_to(outside)
        except OSError:
            return
        try:
            installer.validate_source_tree(source)
        except installer.InstallError as exc:
            check("contains a symlink" in str(exc), "source symlink error was not actionable")
        else:
            raise AssertionError("source package symlink must be rejected")


def test_source_path_rejects_symlink_before_parsing_entrypoint() -> None:
    if not hasattr(os, "symlink"):
        return
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw) / "repo"
        source = root / "skills" / "demo"
        source.mkdir(parents=True)
        outside = Path(raw) / "outside-skill.md"
        outside.write_text("---\nname: demo\n---\n", encoding="utf-8")
        try:
            (source / "SKILL.md").symlink_to(outside)
        except OSError:
            return
        previous_root = installer.REPO_ROOT
        installer.REPO_ROOT = root
        try:
            installer.source_path({"name": "demo", "source": "skills/demo"})
        except installer.InstallError as exc:
            check("contains a symlink" in str(exc), "entrypoint symlink was read before rejection")
        else:
            raise AssertionError("source_path must reject a symlinked SKILL.md")
        finally:
            installer.REPO_ROOT = previous_root


def test_per_skill_backup_symlink_is_rejected() -> None:
    if not hasattr(os, "symlink"):
        return
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        trap = home / "skills" / "trap"
        trap.mkdir(parents=True)
        backup_root = home / "skill-backups"
        backup_root.mkdir()
        try:
            (backup_root / "distill-ramble").symlink_to(trap, target_is_directory=True)
        except OSError:
            return
        result = run(
            "install",
            "--agent",
            "codex",
            "--skill",
            "distill-ramble",
            "--agent-home",
            str(home),
            "--apply",
            check=False,
        )
        check(result.returncode == 2, "symlinked per-skill backup directory must fail")
        check("symlinked per-skill backup" in result.stderr, "backup symlink error was not actionable")
        check(not list(trap.iterdir()), "backup payload escaped into the skills discovery tree")


def test_operation_lock_rejects_concurrent_mutation() -> None:
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        lock = home / "skill-locks" / "distill-ramble.lock"
        lock.parent.mkdir(parents=True)
        handle = installer.acquire_operation_lock(lock)
        try:
            result = run(
                "install",
                "--agent",
                "codex",
                "--skill",
                "distill-ramble",
                "--agent-home",
                str(home),
                "--backup-root",
                str(home / "alternate-backups"),
                "--apply",
                check=False,
            )
        finally:
            installer.release_operation_lock(handle)
        check(result.returncode == 2, "concurrent install must fail closed")
        check("holds this skill lock" in result.stderr, "concurrency error was not actionable")
        check(not (home / "skills" / "distill-ramble").exists(), "blocked install mutated destination")


def test_operation_lock_symlink_is_rejected() -> None:
    if not hasattr(os, "symlink"):
        return
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        lock = root / "skill-locks" / "demo.lock"
        lock.parent.mkdir()
        outside = root / "outside.lock"
        outside.write_text("sentinel\n", encoding="utf-8")
        try:
            lock.symlink_to(outside)
        except OSError:
            return
        try:
            installer.acquire_operation_lock(lock)
        except installer.InstallError as exc:
            check("operation lock must be a real" in str(exc), "lock symlink error was not actionable")
        else:
            raise AssertionError("symlinked operation lock must be rejected")
        check(outside.read_text(encoding="utf-8") == "sentinel\n", "lock symlink target was modified")


def test_doctor_handles_invalid_utf8() -> None:
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        common = ("--agent", "codex", "--skill", "distill-ramble", "--agent-home", str(home))
        run("install", *common, "--apply")
        (home / "skills" / "distill-ramble" / "SKILL.md").write_bytes(b"\xff\xfe")
        result = run("doctor", *common, check=False)
        check(result.returncode == 1, "doctor must report invalid UTF-8 as an issue")
        check("INVALID distill-ramble" in result.stdout, "doctor did not classify invalid UTF-8")
        check("Traceback" not in result.stderr, "doctor crashed on invalid UTF-8")


def installer_args(installer, home: Path, command: str = "install"):
    arguments = [command, "--agent", "codex", "--skill", "distill-ramble", "--agent-home", str(home), "--apply"]
    if command == "install":
        arguments.append("--skip-validation")
    return installer.build_parser().parse_args(arguments)


def assert_original_and_no_stage(home: Path) -> None:
    dest = home / "skills" / "distill-ramble"
    check((dest / "original.txt").read_text() == "original\n", "interruption lost the old destination")
    check(sorted(path.name for path in dest.iterdir()) == ["original.txt"], "recovery altered the old destination")
    check(not list((home / "skills").glob(".*.install-*")), "interruption left discoverable staging content")


def test_install_interruption_recovery() -> None:
    """Inject cancellation before/after live moves, not just ordinary failures."""
    for phase in ("copy", "staged-verify", "metadata", "backup-before", "backup-after", "publish-before", "publish-after", "installed-verify"):
        for cancellation in (KeyboardInterrupt, SystemExit):
            installer = load_installer_module()
            with tempfile.TemporaryDirectory() as raw, contextlib.redirect_stdout(io.StringIO()):
                home = Path(raw) / "codex"
                dest = home / "skills" / "distill-ramble"
                dest.mkdir(parents=True)
                (dest / "original.txt").write_text("original\n")
                args = installer_args(installer, home)
                original_copy = installer.shutil.copytree
                original_move = installer.shutil.move
                original_replace = installer.os.replace
                original_verify = installer.verify_installed
                original_write = Path.write_text

                def copy(source, target, *positional, **kwargs):
                    check((dest / "original.txt").is_file(), "old skill was removed before staging")
                    result = original_copy(source, target, *positional, **kwargs)
                    if phase == "copy":
                        raise cancellation("injected copy interruption")
                    return result

                def move(source, target, *positional, **kwargs):
                    live_backup = Path(source) == dest
                    if live_backup and phase == "backup-before":
                        raise cancellation("injected backup interruption")
                    result = original_move(source, target, *positional, **kwargs)
                    if live_backup and phase == "backup-after":
                        raise cancellation("injected post-backup interruption")
                    return result

                def replace(source, target):
                    if phase == "publish-before":
                        raise cancellation("injected publish interruption")
                    result = original_replace(source, target)
                    if phase == "publish-after":
                        raise cancellation("injected post-publish interruption")
                    return result

                def verify(target, source, name):
                    if (phase == "staged-verify" and target != dest) or (phase == "installed-verify" and target == dest):
                        raise cancellation("injected verify interruption")
                    return original_verify(target, source, name)

                def write(path, *positional, **kwargs):
                    if phase == "metadata" and path.name == "metadata.json":
                        raise cancellation("injected metadata interruption")
                    return original_write(path, *positional, **kwargs)

                with mock.patch.object(installer.shutil, "copytree", side_effect=copy), mock.patch.object(installer.shutil, "move", side_effect=move), mock.patch.object(installer.os, "replace", side_effect=replace), mock.patch.object(installer, "verify_installed", side_effect=verify), mock.patch.object(Path, "write_text", new=write):
                    try:
                        installer.install(args)
                    except cancellation:
                        pass
                    else:
                        raise AssertionError(f"{phase} did not propagate {cancellation.__name__}")
                assert_original_and_no_stage(home)
                lock = installer.operation_lock_path(home / "skills", "distill-ramble")
                handle = installer.acquire_operation_lock(lock)
                installer.release_operation_lock(handle)


def test_failed_staging_validation_preserves_live_install() -> None:
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw, contextlib.redirect_stdout(io.StringIO()):
        home = Path(raw) / "codex"
        dest = home / "skills" / "distill-ramble"
        dest.mkdir(parents=True)
        (dest / "original.txt").write_text("original\n")
        with mock.patch.object(installer, "verify_installed", side_effect=installer.InstallError("staged validation failure")), mock.patch.object(installer, "backup_existing") as backup:
            try:
                installer.install(installer_args(installer, home))
            except installer.InstallError:
                pass
            else:
                raise AssertionError("staged verification failure was ignored")
            backup.assert_not_called()
        assert_original_and_no_stage(home)


def test_new_install_cancellation_removes_published_entry() -> None:
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw, contextlib.redirect_stdout(io.StringIO()):
        home = Path(raw) / "codex"
        replace = installer.os.replace

        def interrupted_replace(source, dest):
            replace(source, dest)
            raise KeyboardInterrupt("after successful publish")

        with mock.patch.object(installer.os, "replace", side_effect=interrupted_replace):
            try:
                installer.install(installer_args(installer, home))
            except KeyboardInterrupt:
                pass
            else:
                raise AssertionError("cancellation was not propagated")
        check(not (home / "skills" / "distill-ramble").exists(), "cancelled new install left a live entry")
        check(not list((home / "skills").glob(".*.install-*")), "cancelled new install leaked staging")


def test_recovery_does_not_delete_external_replacement() -> None:
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw, contextlib.redirect_stdout(io.StringIO()):
        home = Path(raw) / "codex"
        dest = home / "skills" / "distill-ramble"
        dest.mkdir(parents=True)
        (dest / "original.txt").write_text("original\n")
        verify = installer.verify_installed

        def externally_replaced(target, source, name):
            if target == dest:
                # Move aside instead of deleting, so the replacement cannot
                # immediately reuse the just-freed inode in this fixture.
                target.rename(home / "external-moved-install")
                target.mkdir()
                (target / "external.txt").write_text("external\n")
                raise KeyboardInterrupt("external writer interrupted validation")
            return verify(target, source, name)

        with mock.patch.object(installer, "verify_installed", side_effect=externally_replaced):
            try:
                installer.install(installer_args(installer, home))
            except installer.InstallError as exc:
                check("backup preserved" in str(exc), "external replacement recovery is not actionable")
            else:
                raise AssertionError("external replacement must require manual recovery")
        check((dest / "external.txt").read_text() == "external\n", "recovery deleted another writer's entry")
        backups = list((home / "skill-backups" / "distill-ramble").glob("*/payload/original.txt"))
        check(len(backups) == 1 and backups[0].read_text() == "original\n", "old install backup was not preserved")


def test_rollback_interruption_recovers_both_entries() -> None:
    for phase in ("backup-before", "backup-after", "restore-before", "restore-after"):
        for cancellation in (KeyboardInterrupt, SystemExit):
            installer = load_installer_module()
            with tempfile.TemporaryDirectory() as raw, contextlib.redirect_stdout(io.StringIO()):
                home = Path(raw) / "codex"
                dest = home / "skills" / "distill-ramble"
                dest.mkdir(parents=True)
                (dest / "prior.txt").write_text("prior\n")
                installer.install(installer_args(installer, home))
                (dest / "current.txt").write_text("current\n")
                base = home / "skill-backups" / "distill-ramble"
                selected = next(base.glob("*/payload"))
                move = installer.shutil.move
                injected = False

                def interrupted_move(source, target, *positional, **kwargs):
                    nonlocal injected
                    operation = "backup" if Path(source) == dest else "restore" if Path(source) == selected else "recovery"
                    should_interrupt = not injected and phase.startswith(operation + "-")
                    if should_interrupt and phase.endswith("before"):
                        injected = True
                        raise cancellation("injected rollback interruption")
                    result = move(source, target, *positional, **kwargs)
                    if should_interrupt and phase.endswith("after"):
                        injected = True
                        raise cancellation("injected post-move rollback interruption")
                    return result

                with mock.patch.object(installer.shutil, "move", side_effect=interrupted_move):
                    try:
                        installer.rollback(installer_args(installer, home, "rollback"))
                    except cancellation:
                        pass
                    else:
                        raise AssertionError(f"{phase} did not propagate cancellation")
                check((dest / "current.txt").read_text() == "current\n", "rollback cancellation lost current install")
                check((selected / "prior.txt").read_text() == "prior\n", "rollback cancellation consumed selected backup")


def test_sigterm_during_copy_preserves_live_install() -> None:
    if os.name != "posix":
        return
    with tempfile.TemporaryDirectory() as raw:
        home = Path(raw) / "codex"
        dest = home / "skills" / "distill-ramble"
        dest.mkdir(parents=True)
        (dest / "original.txt").write_text("original\n")
        code = f"""
import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location('installer', {str(SCRIPT)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_copy = module.shutil.copytree
def terminate_copy(source, target, *positional, **kwargs):
    original_copy(source, target, *positional, **kwargs)
    os.kill(os.getpid(), signal.SIGTERM)
module.shutil.copytree = terminate_copy
sys.argv = ['install_skill.py', 'install', '--agent', 'codex', '--skill', 'distill-ramble', '--agent-home', {str(home)!r}, '--apply', '--skip-validation']
raise SystemExit(module.main())
"""
        result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, timeout=20, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        check(result.returncode == 143, f"SIGTERM was not handled: {result.stderr}")
        check("Cancelled" in result.stderr and "Traceback" not in result.stderr, "SIGTERM did not report clean cancellation")
        assert_original_and_no_stage(home)


def test_backup_allocation_collision_preserves_other_record() -> None:
    installer = load_installer_module()
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        dest = root / "skills" / "demo"
        dest.mkdir(parents=True)
        (dest / "original.txt").write_text("original\n")
        backup_base = root / "backups" / "demo"
        record = backup_base / "20260905000000"
        record.mkdir(parents=True)
        (record / "sentinel.txt").write_text("other record\n")
        with mock.patch.object(installer, "unique_backup_dir", return_value=record):
            try:
                installer.backup_existing(dest, backup_base)
            except FileExistsError:
                pass
            else:
                raise AssertionError("backup allocation collision should fail")
        check((record / "sentinel.txt").read_text() == "other record\n", "collision deleted another backup record")
        check((dest / "original.txt").read_text() == "original\n", "collision changed live install")


def test_helper_return_and_caller_opcode_cancellation() -> None:
    """Recovery must not depend on receiving/storing a helper's return value."""
    cases = (
        ("install", "stage_package"),
        ("install", "backup_existing"),
        ("rollback", "backup_existing"),
    )
    for command, helper_name in cases:
        for boundary in ("helper-return", "caller-post-call"):
            for cancellation in (KeyboardInterrupt, SystemExit):
                installer = load_installer_module()
                with tempfile.TemporaryDirectory() as raw, contextlib.redirect_stdout(io.StringIO()):
                    home = Path(raw) / "codex"
                    dest = home / "skills" / "distill-ramble"
                    dest.mkdir(parents=True)
                    (dest / "original.txt").write_text("original\n")
                    selected = None
                    if command == "rollback":
                        installer.install(installer_args(installer, home))
                        (dest / "current.txt").write_text("current\n")
                        selected = next((home / "skill-backups" / "distill-ramble").glob("*/payload"))
                    helper_code = getattr(installer, helper_name).__code__
                    caller_code = getattr(installer, command).__code__
                    caller_frame = None
                    injected = False

                    def trace(frame, event, value):
                        nonlocal caller_frame, injected
                        if frame.f_code is caller_code and event == "call" and boundary == "caller-post-call":
                            frame.f_trace_opcodes = True
                        if frame.f_code is helper_code and event == "return" and value is not None:
                            # A return trace fires after helper mutations but
                            # before the return value reaches the caller.
                            if boundary == "helper-return":
                                injected = True
                                raise cancellation("injected helper return boundary")
                            caller_frame = frame.f_back
                            check(caller_frame is not None and caller_frame.f_code is caller_code, "unexpected helper caller")
                            caller_frame.f_trace_opcodes = True
                        elif boundary == "caller-post-call" and frame is caller_frame and event == "opcode":
                            # Stop at the very next caller opcode, before
                            # STORE_FAST / UNPACK_SEQUENCE / POP_TOP can run.
                            injected = True
                            raise cancellation("injected caller post-call boundary")
                        return trace

                    previous_trace = sys.gettrace()
                    test_frame = sys._getframe()
                    previous_opcodes = test_frame.f_trace_opcodes
                    try:
                        # Python 3.12 activates opcode tracing globally only
                        # when a current frame has opted in before settrace.
                        test_frame.f_trace_opcodes = True
                        sys.settrace(trace)
                        try:
                            getattr(installer, command)(installer_args(installer, home, command))
                        except cancellation:
                            pass
                        else:
                            raise AssertionError(f"{command}/{helper_name}/{boundary} did not propagate cancellation")
                    finally:
                        sys.settrace(previous_trace)
                        test_frame.f_trace_opcodes = previous_opcodes
                    check(injected, f"{command}/{helper_name}/{boundary} trace hook never fired")
                    if command == "install":
                        assert_original_and_no_stage(home)
                    else:
                        check((dest / "current.txt").read_text() == "current\n", "return-boundary cancellation lost current install")
                        check(selected is not None and (selected / "original.txt").read_text() == "original\n", "return-boundary cancellation consumed selected backup")
                    handle = installer.acquire_operation_lock(installer.operation_lock_path(home / "skills", "distill-ramble"))
                    installer.release_operation_lock(handle)


def main() -> int:
    test_copy_backup_doctor_and_rollback()
    test_symlink_replaces_directory_instead_of_nesting()
    test_doctor_reports_discoverable_duplicate()
    test_backup_root_inside_discovery_is_rejected()
    test_source_tree_symlink_is_rejected()
    test_source_path_rejects_symlink_before_parsing_entrypoint()
    test_per_skill_backup_symlink_is_rejected()
    test_operation_lock_rejects_concurrent_mutation()
    test_operation_lock_symlink_is_rejected()
    test_doctor_handles_invalid_utf8()
    test_install_interruption_recovery()
    test_failed_staging_validation_preserves_live_install()
    test_new_install_cancellation_removes_published_entry()
    test_recovery_does_not_delete_external_replacement()
    test_rollback_interruption_recovers_both_entries()
    test_sigterm_during_copy_preserves_live_install()
    test_backup_allocation_collision_preserves_other_record()
    test_helper_return_and_caller_opcode_cancellation()
    print("install_skill.py smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
