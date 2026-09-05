#!/usr/bin/env python3
"""Safely install, inspect, or roll back repo-managed skill packages.

Backups live outside the agent's ``skills/`` discovery directory so an old
``SKILL.md`` cannot be rediscovered as a duplicate package. Mutating commands
are dry-run by default and require ``--apply``.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # POSIX
    import fcntl  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised on Windows
    fcntl = None  # type: ignore[assignment]

try:  # Windows
    import msvcrt  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised on POSIX
    msvcrt = None  # type: ignore[assignment]


REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = REPO_ROOT / "skills" / "catalog.json"
LOCAL_VALIDATOR = REPO_ROOT / "scripts" / "validate_skill.py"
NAME_RE = re.compile(r"^[a-z0-9-]{1,64}$")
BACKUP_NAME_RE = re.compile(r"^\d{14}(?:-\d{3})?$")
BACKUP_METADATA_MAX_BYTES = 16 * 1024
SKILL_METADATA_MAX_BYTES = 256 * 1024


class InstallError(RuntimeError):
    """A user-actionable installer safety or validation error."""


class InstallCancelled(BaseException):
    """A handled termination request; mutation recovery must run first."""

    def __init__(self, signum: int) -> None:
        self.signum = signum
        super().__init__(f"cancelled by signal {signum}")


class MutationJournal:
    """Caller-owned recovery paths, registered before helper mutations.

    Returning a path is not a transaction handoff: cancellation can occur on
    RETURN_VALUE or before the caller stores the result. Both sides therefore
    share this object throughout preparation, publication, and recovery.
    """

    def __init__(self) -> None:
        self.stage: Path | None = None
        self.stage_identity: tuple[int, int] | None = None
        self.backup_dir: Path | None = None
        self.backup_payload: Path | None = None
        self.backup_created = False


def resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def absolute_lexical(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path.expanduser())))


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def entry_exists(path: Path) -> bool:
    return os.path.lexists(path)


def entry_identity(path: Path) -> tuple[int, int] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    return info.st_dev, info.st_ino


def entry_type(path: Path) -> str:
    try:
        info = path.lstat()
    except OSError as exc:
        raise InstallError(f"cannot inspect entry {path}: {exc}") from exc
    if stat.S_ISLNK(info.st_mode):
        return "symlink"
    if stat.S_ISDIR(info.st_mode):
        return "directory"
    if stat.S_ISREG(info.st_mode):
        return "file"
    raise InstallError(f"refusing special filesystem entry: {path}")


def read_regular_bounded(path: Path, max_bytes: int, label: str) -> bytes:
    try:
        before = path.lstat()
    except OSError as exc:
        raise InstallError(f"cannot inspect {label} {path}: {exc}") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise InstallError(f"{label} must be a real regular file: {path}")
    if before.st_size > max_bytes:
        raise InstallError(f"{label} exceeds {max_bytes}-byte safety cap: {path}")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise InstallError(f"cannot safely open {label} {path}: {exc}") from exc
    try:
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
        ):
            raise InstallError(f"{label} changed during safe open: {path}")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if len(data) > max_bytes:
        raise InstallError(f"{label} exceeds {max_bytes}-byte safety cap: {path}")
    return data


def assert_safe_directory_chain(path: Path, label: str) -> None:
    """Reject symlinks/non-directories in every existing component."""
    path = absolute_lexical(path)
    parts = path.parts
    current = Path(parts[0])
    for part in parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        except OSError as exc:
            raise InstallError(f"cannot inspect {label} component {current}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode):
            raise InstallError(f"refusing symlinked {label} component: {current}")
        if not stat.S_ISDIR(info.st_mode):
            raise InstallError(f"refusing non-directory {label} component: {current}")


def ensure_safe_directory(path: Path, label: str) -> None:
    assert_safe_directory_chain(path, label)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise InstallError(f"cannot create {label} {path}: {exc}") from exc
    assert_safe_directory_chain(path, label)


def load_catalog(path: Path = CATALOG_PATH) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InstallError(f"cannot read package catalog {path}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("packages"), list):
        raise InstallError(f"unsupported or invalid catalog schema in {path}")
    packages = payload["packages"]
    for index, package in enumerate(packages):
        if not isinstance(package, dict):
            raise InstallError(f"catalog package #{index} must be an object")
        if not isinstance(package.get("name"), str) or not isinstance(package.get("source"), str):
            raise InstallError(f"catalog package #{index} has invalid name/source")
        targets = package.get("targets")
        if not isinstance(targets, list) or not all(isinstance(value, str) for value in targets):
            raise InstallError(f"catalog package #{index} has invalid targets")
    return packages


def select_package(packages: list[dict[str, Any]], name: str, agent: str) -> dict[str, Any]:
    matches = [item for item in packages if item.get("name") == name]
    if not matches:
        available = ", ".join(sorted(str(item.get("name")) for item in packages))
        raise InstallError(f"unknown skill '{name}'; available: {available}")
    package = matches[0]
    if agent not in package.get("targets", []):
        targets = ", ".join(package.get("targets", []))
        raise InstallError(f"skill '{name}' does not target {agent}; supported: {targets}")
    return package


def default_agent_home(agent: str) -> Path:
    if agent == "codex":
        return Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    return Path.home() / ".claude"


def agent_paths(args: argparse.Namespace, name: str) -> tuple[Path, Path, Path]:
    home = resolved(Path(args.agent_home)) if args.agent_home else resolved(default_agent_home(args.agent))
    skills_root = home / "skills"
    backup_root = absolute_lexical(Path(args.backup_root)) if args.backup_root else home / "skill-backups"
    if is_relative_to(resolved(backup_root), resolved(skills_root)):
        raise InstallError("backup root must be outside the agent skills discovery directory")
    backup_base = backup_root / name
    assert_safe_directory_chain(skills_root, "skills root")
    assert_safe_directory_chain(backup_root, "backup root")
    assert_safe_directory_chain(backup_base, "per-skill backup directory")
    return skills_root, skills_root / name, backup_base


def parse_skill_name(path: Path) -> str:
    entrypoint = path / "SKILL.md"
    try:
        text = read_regular_bounded(entrypoint, SKILL_METADATA_MAX_BYTES, "SKILL.md").decode("utf-8")
    except InstallError:
        raise
    except (OSError, UnicodeError) as exc:
        raise InstallError(f"cannot read {entrypoint}: {exc}") from exc
    match = re.search(r"^name:\s*['\"]?([a-z0-9-]+)['\"]?\s*$", text, flags=re.M)
    if not match:
        raise InstallError(f"cannot parse skill name from {path / 'SKILL.md'}")
    return match.group(1)


def read_version(path: Path) -> str:
    version_file = path / "VERSION"
    try:
        value = read_regular_bounded(version_file, 1024, "VERSION").decode("utf-8").strip()
    except (InstallError, UnicodeError):
        return "Unknown"
    return value or "Unknown"


def source_path(package: dict[str, Any]) -> Path:
    source_lexical = REPO_ROOT / str(package["source"])
    assert_safe_directory_chain(source_lexical.parent, "catalog source")
    if source_lexical.is_symlink():
        raise InstallError(f"catalog source must not be a symlink: {source_lexical}")
    source = resolved(source_lexical)
    if not is_relative_to(source, resolved(REPO_ROOT)):
        raise InstallError(f"catalog source escapes repository: {source}")
    validate_source_tree(source)
    expected = str(package["name"])
    if not NAME_RE.fullmatch(expected) or parse_skill_name(source) != expected:
        raise InstallError(f"catalog/package name mismatch for {source}")
    return source


def validate_source_tree(source: Path) -> None:
    """Reject links and special files inside an installable package.

    Copy mode must not preserve an unexpected link to data outside the package,
    and symlink mode must not expose such a link through the installed package.
    Current repo packages need only real directories and regular files.
    """
    try:
        root_info = source.lstat()
    except OSError as exc:
        raise InstallError(f"cannot inspect source package {source}: {exc}") from exc
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise InstallError(f"source package must be a real directory: {source}")
    for dirpath, dirnames, filenames in os.walk(source, followlinks=False):
        base = Path(dirpath)
        for name in [*dirnames, *filenames]:
            entry = base / name
            try:
                info = entry.lstat()
            except OSError as exc:
                raise InstallError(f"cannot inspect source entry {entry}: {exc}") from exc
            if stat.S_ISLNK(info.st_mode):
                raise InstallError(f"source package contains a symlink: {entry.relative_to(source)}")
            if name in dirnames:
                if not stat.S_ISDIR(info.st_mode):
                    raise InstallError(f"source package contains a non-directory entry: {entry.relative_to(source)}")
            elif not stat.S_ISREG(info.st_mode):
                raise InstallError(f"source package contains a special file: {entry.relative_to(source)}")


def run_local_validator(source: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(LOCAL_VALIDATOR), str(source)],
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if result.returncode != 0:
        detail = (result.stdout + result.stderr).strip()
        raise InstallError(f"source package validation failed:\n{detail}")


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def unique_backup_dir(base: Path) -> Path:
    stamp = timestamp()
    for index in range(1000):
        suffix = stamp if index == 0 else f"{stamp}-{index:03d}"
        candidate = base / suffix
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    raise InstallError(f"could not allocate a unique backup directory under {base}")


def operation_lock_backend() -> str:
    if fcntl is not None:
        return "flock"
    if msvcrt is not None:
        return "msvcrt"
    raise InstallError("no supported advisory file-lock backend; refusing concurrent-unsafe mutation")


def operation_lock_path(skills_root: Path, name: str) -> Path:
    return skills_root.parent / "skill-locks" / f"{name}.lock"


def acquire_operation_lock(lock: Path) -> tuple[int, str]:
    """Acquire a per-agent/per-skill advisory mutation lock."""
    assert_safe_directory_chain(lock.parent, "skill lock directory")
    backend = operation_lock_backend()
    before: os.stat_result | None = None
    try:
        before = lock.lstat()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise InstallError(f"cannot inspect operation lock {lock}: {exc}") from exc
    if before is not None and (
        stat.S_ISLNK(before.st_mode)
        or not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
    ):
        raise InstallError(f"operation lock must be a real, non-hard-linked regular file: {lock}")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(lock, flags, 0o600)
    except OSError as exc:
        raise InstallError(f"operation lock is unsafe or unavailable: {lock}: {exc}") from exc
    try:
        info = os.fstat(fd)
        named = lock.lstat()
        if (
            stat.S_ISLNK(named.st_mode)
            or not stat.S_ISREG(named.st_mode)
            or named.st_nlink != 1
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino)
            or (
                before is not None
                and (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
            )
        ):
            raise InstallError("operation lock must be a real, non-hard-linked regular file")
        if backend == "flock":
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[union-attr]
            except (BlockingIOError, OSError) as exc:
                raise InstallError("another install/rollback operation holds this skill lock") from exc
        else:
            if info.st_size < 1:
                os.write(fd, b"\0")
                os.fsync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)  # type: ignore[union-attr]
            except OSError as exc:
                raise InstallError("another install/rollback operation holds this skill lock") from exc
        return fd, backend
    except BaseException:
        os.close(fd)
        raise


def release_operation_lock(handle: tuple[int, str]) -> None:
    fd, backend = handle
    try:
        if backend == "flock":
            fcntl.flock(fd, fcntl.LOCK_UN)  # type: ignore[union-attr]
        else:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)  # type: ignore[union-attr]
    finally:
        os.close(fd)


def backup_existing(
    dest: Path, backup_base: Path, *, journal: MutationJournal | None = None,
) -> tuple[Path | None, Path | None]:
    if not entry_exists(dest):
        return None, None
    assert_safe_directory_chain(backup_base, "per-skill backup directory")
    kind = entry_type(dest)
    backup_dir = unique_backup_dir(backup_base)
    payload = backup_dir / "payload"
    state = journal if journal is not None else MutationJournal()
    state.backup_dir = backup_dir
    state.backup_payload = payload
    try:
        backup_dir.mkdir(parents=True, exist_ok=False)
        state.backup_created = True
        metadata = {
            "schema_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "original_path": str(dest),
            "skill_name": dest.name,
            "entry_type": kind,
        }
        (backup_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        # Finish all preparation before removing the live destination. Catch
        # cancellation even when the move completed just before it was raised.
        shutil.move(str(dest), str(payload))
    except BaseException as exc:
        if not state.backup_created:
            # A colliding record belongs to another operation; never clean it.
            raise
        if entry_exists(payload):
            if entry_exists(dest):
                raise InstallError(
                    f"backup was interrupted with both entries present; inspect destination={dest} and backup={payload}"
                ) from exc
            try:
                shutil.move(str(payload), str(dest))
            except BaseException as recovery_exc:
                raise InstallError(
                    f"backup failed and restoration was incomplete; recover manually from {payload}: {recovery_exc}"
                ) from exc
        shutil.rmtree(backup_dir, ignore_errors=True)
        raise
    return backup_dir, payload


def remove_entry(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        if path.is_dir():
            shutil.rmtree(path)
        else:
            raise InstallError(f"refusing to remove special filesystem entry: {path}")


def stage_package(
    source: Path, skills_root: Path, name: str, mode: str,
    *, journal: MutationJournal | None = None,
) -> Path:
    stage = skills_root / f".{name}.install-{os.getpid()}-{timestamp()}"
    if stage.exists() or stage.is_symlink():
        raise InstallError(f"staging path already exists: {stage}")
    state = journal if journal is not None else MutationJournal()
    state.stage = stage
    try:
        if mode == "copy":
            shutil.copytree(source, stage, symlinks=True)
            state.stage_identity = entry_identity(stage)
            validate_source_tree(stage)
        else:
            os.symlink(source, stage, target_is_directory=True)
            state.stage_identity = entry_identity(stage)
    except BaseException:
        if entry_exists(stage):
            remove_entry(stage)
        raise
    return stage


def verify_installed(dest: Path, source: Path, expected_name: str) -> None:
    if not dest.exists():
        raise InstallError(f"installed destination is missing: {dest}")
    if parse_skill_name(dest) != expected_name:
        raise InstallError(f"installed skill name mismatch at {dest}")
    source_version = read_version(source)
    installed_version = read_version(dest)
    if source_version != installed_version:
        raise InstallError(
            f"installed VERSION mismatch: source={source_version}, installed={installed_version}"
        )


def iter_skill_files(skills_root: Path) -> list[Path]:
    if not skills_root.is_dir():
        return []
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(skills_root, followlinks=False):
        base = Path(dirpath)
        dirnames[:] = [name for name in dirnames if not (base / name).is_symlink()]
        if "SKILL.md" in filenames:
            found.append(base / "SKILL.md")
    # Direct symlinked package directories are intentionally not traversed by
    # os.walk; inspect their entrypoint explicitly.
    for child in skills_root.iterdir():
        if child.is_symlink() and (child / "SKILL.md").is_file():
            found.append(child / "SKILL.md")
    return sorted(set(found))


def duplicate_locations(skills_root: Path, name: str, expected_dest: Path) -> list[Path]:
    duplicates: list[Path] = []
    expected = expected_dest.absolute()
    for skill_file in iter_skill_files(skills_root):
        try:
            found_name = parse_skill_name(skill_file.parent)
        except InstallError:
            continue
        if found_name == name and skill_file.parent.absolute() != expected:
            duplicates.append(skill_file.parent)
    return duplicates


def relative_display(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def install(args: argparse.Namespace) -> int:
    packages = load_catalog()
    package = select_package(packages, args.skill, args.agent)
    source = source_path(package)
    skills_root, dest, backup_base = agent_paths(args, args.skill)

    print(f"Mode:        {'apply' if args.apply else 'dry-run'}")
    print(f"Agent:       {args.agent}")
    print(f"Skill:       {args.skill}")
    print(f"Source:      {source}")
    print(f"Destination: {dest}")
    print(f"Install as:  {args.mode}")
    print(f"Backup root: {backup_base}")

    if not args.skip_validation:
        run_local_validator(source)
        print("Validation:  passed")
    else:
        print("Validation:  skipped by request")

    if not args.apply:
        print("No changes made. Re-run with --apply to install.")
        return 0

    ensure_safe_directory(skills_root, "skills root")
    ensure_safe_directory(backup_base, "per-skill backup directory")
    lock_path = operation_lock_path(skills_root, args.skill)
    ensure_safe_directory(lock_path.parent, "skill lock directory")
    state = MutationJournal()
    lock_handle: tuple[int, str] | None = None
    try:
        lock_handle = acquire_operation_lock(lock_path)
        validate_source_tree(source)
        # Copy and verify while the old skill remains available. Only the
        # prepared entry participates in the short backup/publish phase.
        stage_package(source, skills_root, args.skill, args.mode, journal=state)
        if state.stage is None:
            raise InstallError("staging helper did not register its destination")
        verify_installed(state.stage, source, args.skill)
        backup_existing(dest, backup_base, journal=state)
        os.replace(state.stage, dest)
        verify_installed(dest, source, args.skill)
    except BaseException as exc:
        recovery_errors: list[str] = []
        stage, stage_identity = state.stage, state.stage_identity
        backup_payload = state.backup_payload if state.backup_created else None
        if stage is not None and entry_exists(stage):
            if stage_identity is not None and entry_identity(stage) == stage_identity:
                try:
                    remove_entry(stage)
                except BaseException as recovery_exc:
                    recovery_errors.append(f"staging cleanup failed at {stage}: {recovery_exc}")
            else:
                recovery_errors.append(f"staging identity changed; inspect {stage}")
        # An interrupt may arrive after os.replace succeeds but before Python
        # records that fact. Match the staged inode instead of a success flag;
        # never delete a destination replaced by another writer.
        if stage_identity is not None and entry_identity(dest) == stage_identity:
            try:
                remove_entry(dest)
            except BaseException as recovery_exc:
                recovery_errors.append(f"installed entry cleanup failed at {dest}: {recovery_exc}")
        if backup_payload is not None and entry_exists(backup_payload):
            if entry_exists(dest):
                recovery_errors.append(f"destination remains occupied; backup preserved at {backup_payload}")
            else:
                try:
                    shutil.move(str(backup_payload), str(dest))
                except BaseException as recovery_exc:
                    recovery_errors.append(f"recover manually from {backup_payload}: {recovery_exc}")
        if recovery_errors:
            raise InstallError("install recovery incomplete: " + "; ".join(recovery_errors)) from exc
        if isinstance(exc, InstallError) or not isinstance(exc, Exception):
            raise
        raise InstallError(f"install failed and rollback was attempted: {exc}") from exc
    finally:
        if lock_handle is not None:
            release_operation_lock(lock_handle)

    print(f"Installed:   {dest}")
    print(f"Version:     {read_version(dest)}")
    if state.backup_created:
        print(f"Backup:      {state.backup_dir}")
    else:
        print("Backup:      none (destination did not exist)")
    duplicates = duplicate_locations(skills_root, args.skill, dest)
    if duplicates:
        print("WARNING: duplicate discoverable skill locations remain:")
        for path in duplicates:
            print(f"- {relative_display(path, skills_root)}")
        return 1
    print("Duplicate discoverable copies: none")
    return 0


def doctor(args: argparse.Namespace) -> int:
    packages = load_catalog()
    selected = [item for item in packages if args.agent in item.get("targets", [])]
    if args.skill:
        selected = [select_package(packages, args.skill, args.agent)]
    issues = 0
    for package in selected:
        name = str(package["name"])
        source = source_path(package)
        skills_root, dest, _ = agent_paths(args, name)
        expected_version = read_version(source)
        if not dest.exists():
            print(f"MISSING {name}: expected version {expected_version}")
            issues += 1
            continue
        try:
            actual_name = parse_skill_name(dest)
            installed_version = read_version(dest)
        except InstallError as exc:
            print(f"INVALID {name}: {exc}")
            issues += 1
            continue
        mode = "symlink" if dest.is_symlink() else "copy"
        status = "OK" if actual_name == name and installed_version == expected_version else "STALE"
        print(
            f"{status} {name}: installed={installed_version}, repo={expected_version}, mode={mode}"
        )
        if status != "OK":
            issues += 1
        duplicates = duplicate_locations(skills_root, name, dest)
        for duplicate in duplicates:
            print(f"  DUPLICATE: {relative_display(duplicate, skills_root)}")
            issues += 1
    return 1 if issues else 0


def read_backup_metadata(directory: Path) -> dict[str, Any]:
    metadata_path = directory / "metadata.json"
    try:
        data = read_regular_bounded(metadata_path, BACKUP_METADATA_MAX_BYTES, "backup metadata")
        payload = json.loads(data.decode("utf-8"))
    except InstallError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InstallError(f"cannot read backup metadata {metadata_path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise InstallError(f"backup metadata must be an object: {metadata_path}")
    return payload


def validate_backup_record(
    directory: Path,
    payload: Path,
    *,
    dest: Path,
    skill: str,
) -> dict[str, Any]:
    try:
        directory_info = directory.lstat()
    except OSError as exc:
        raise InstallError(f"cannot inspect backup directory {directory}: {exc}") from exc
    if stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
        raise InstallError(f"backup record must be a real directory: {directory}")
    if not entry_exists(payload):
        raise InstallError(f"backup payload is missing: {payload}")
    metadata = read_backup_metadata(directory)
    required = {
        "schema_version": 1,
        "original_path": str(dest),
        "skill_name": skill,
    }
    for key, expected in required.items():
        if metadata.get(key) != expected:
            raise InstallError(f"backup metadata {key!r} does not match requested destination")
    recorded_type = metadata.get("entry_type")
    actual_type = entry_type(payload)
    if recorded_type not in {"directory", "file", "symlink"} or recorded_type != actual_type:
        raise InstallError(
            f"backup payload type mismatch: recorded={recorded_type!r}, actual={actual_type!r}"
        )
    return metadata


def choose_backup(
    backup_base: Path,
    requested: str,
    *,
    dest: Path,
    skill: str,
) -> tuple[Path, Path, dict[str, Any]]:
    assert_safe_directory_chain(backup_base, "per-skill backup directory")
    if not backup_base.is_dir():
        raise InstallError(f"no backups found under {backup_base}")
    candidates: list[Path] = []
    for entry in backup_base.iterdir():
        if not BACKUP_NAME_RE.fullmatch(entry.name):
            continue
        try:
            info = entry.lstat()
        except OSError:
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            continue
        if entry_exists(entry / "payload"):
            candidates.append(entry)
    candidates.sort(key=lambda path: path.name)
    if not candidates:
        raise InstallError(f"no usable backups found under {backup_base}")
    if requested == "latest":
        selected = candidates[-1]
    else:
        selected = backup_base / requested
        if selected not in candidates:
            raise InstallError(f"backup '{requested}' was not found under {backup_base}")
    payload = selected / "payload"
    metadata = validate_backup_record(selected, payload, dest=dest, skill=skill)
    return selected, payload, metadata


def rollback(args: argparse.Namespace) -> int:
    packages = load_catalog()
    select_package(packages, args.skill, args.agent)
    skills_root, dest, backup_base = agent_paths(args, args.skill)
    selected_dir, payload, metadata = choose_backup(
        backup_base,
        args.backup,
        dest=dest,
        skill=args.skill,
    )

    print(f"Mode:        {'apply' if args.apply else 'dry-run'}")
    print(f"Restore:     {selected_dir}")
    print(f"Destination: {dest}")
    if not args.apply:
        print("No changes made. Re-run with --apply to roll back.")
        return 0

    ensure_safe_directory(skills_root, "skills root")
    ensure_safe_directory(backup_base, "per-skill backup directory")
    lock_path = operation_lock_path(skills_root, args.skill)
    ensure_safe_directory(lock_path.parent, "skill lock directory")
    state = MutationJournal()
    selected_identity: tuple[int, int] | None = None
    restored_identity: tuple[int, int] | None = None
    lock_handle: tuple[int, str] | None = None
    try:
        lock_handle = acquire_operation_lock(lock_path)
        # The record may have changed while the dry-run/report was printed.
        metadata = validate_backup_record(selected_dir, payload, dest=dest, skill=args.skill)
        selected_identity = entry_identity(payload)
        backup_existing(dest, backup_base, journal=state)
        shutil.move(str(payload), str(dest))
        restored_identity = entry_identity(dest)
        if entry_type(dest) != metadata["entry_type"]:
            raise InstallError("restored destination type does not match backup metadata")
    except BaseException as exc:
        recovery_error: BaseException | None = None
        current_payload = state.backup_payload if state.backup_created else None
        dest_identity = entry_identity(dest)
        if dest_identity is not None and dest_identity in (selected_identity, restored_identity):
            try:
                shutil.move(str(dest), str(payload))
            except BaseException as move_exc:
                recovery_error = move_exc
        elif current_payload is not None and entry_exists(current_payload) and entry_exists(dest):
            # Do not delete a destination that appeared after the current one
            # was backed up; leave both it and the backup for manual recovery.
            raise InstallError(
                f"rollback failed, but destination changed externally; current backup remains at {current_payload}"
            ) from exc
        if recovery_error is None and current_payload is not None and entry_exists(current_payload):
            try:
                shutil.move(str(current_payload), str(dest))
            except BaseException as move_exc:
                recovery_error = move_exc
        if recovery_error is not None:
            raise InstallError(
                "rollback and automatic recovery were incomplete; "
                f"inspect destination={dest}, selected_backup={payload}, current_backup={current_payload}: {recovery_error}"
            ) from exc
        if isinstance(exc, InstallError) or not isinstance(exc, Exception):
            raise
        raise InstallError(f"rollback failed and current install restoration was attempted: {exc}") from exc
    finally:
        if lock_handle is not None:
            release_operation_lock(lock_handle)

    print(f"Restored:    {dest}")
    print(f"Version:     {read_version(dest)}")
    if state.backup_created:
        print(f"Previous current install backed up to: {state.backup_dir}")
    print("Note: rollback restores the recorded prior entry exactly; run doctor separately to compare it with the repo package.")
    return 0


def add_common(parser: argparse.ArgumentParser, *, skill_required: bool = True) -> None:
    parser.add_argument("--agent", required=True, choices=("codex", "claude"))
    parser.add_argument("--skill", required=skill_required, help="Package name from skills/catalog.json")
    parser.add_argument("--agent-home", help="Override agent home; useful for tests or non-default installs")
    parser.add_argument("--backup-root", help="Override backup root; must stay outside <agent-home>/skills")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    install_parser = subparsers.add_parser("install", help="Validate and install one package")
    add_common(install_parser)
    install_parser.add_argument("--mode", choices=("copy", "symlink"), default="copy")
    install_parser.add_argument("--apply", action="store_true", help="Apply changes; default is dry-run")
    install_parser.add_argument("--skip-validation", action="store_true")
    install_parser.set_defaults(handler=install)

    doctor_parser = subparsers.add_parser("doctor", help="Read-only installed-version and duplicate check")
    add_common(doctor_parser, skill_required=False)
    doctor_parser.set_defaults(handler=doctor)

    rollback_parser = subparsers.add_parser("rollback", help="Restore a backup outside discovery root")
    add_common(rollback_parser)
    rollback_parser.add_argument("--backup", default="latest", help="Backup directory name or 'latest'")
    rollback_parser.add_argument("--apply", action="store_true", help="Apply changes; default is dry-run")
    rollback_parser.set_defaults(handler=rollback)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    def terminate(signum: int, _frame: Any) -> None:
        raise InstallCancelled(signum)

    previous_sigterm = signal.signal(signal.SIGTERM, terminate)
    try:
        return int(args.handler(args))
    except InstallError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except (KeyboardInterrupt, InstallCancelled) as exc:
        print("Cancelled; any started mutation was recovered or reported above.", file=sys.stderr)
        return 128 + (exc.signum if isinstance(exc, InstallCancelled) else signal.SIGINT)
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)


if __name__ == "__main__":
    raise SystemExit(main())
