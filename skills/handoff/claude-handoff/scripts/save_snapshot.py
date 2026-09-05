#!/usr/bin/env python3
"""Safely save a validated handoff backup and atomically update latest.md."""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import argparse
import ctypes
import hashlib
import os
import re
import secrets
import stat
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

try:  # POSIX
    import fcntl  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised on Windows
    fcntl = None  # type: ignore[assignment]

try:  # Windows
    import msvcrt  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised on POSIX
    msvcrt = None  # type: ignore[assignment]

from snapshot_common import (
    DirectoryHandle,
    Lane,
    MAX_DEFAULT_BYTES,
    Snapshot,
    SnapshotError,
    handoff_location,
    open_directory_handle,
    parse_backup_name,
    path_display,
    read_regular_bounded,
    read_regular_bounded_at,
    read_stream_bounded,
    require_dirfd_support,
    sanitize_display,
    valid_agent,
    valid_scope,
    validate_snapshot_bytes,
    validate_snapshot_at,
)

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-\d{6}$")


@dataclass(frozen=True)
class LatestState:
    exists: bool
    device: int = 0
    inode: int = 0
    size: int = 0
    mtime_ns: int = 0
    sha256: str = ""
    agent: str = "Unknown"
    valid: bool = True


class AtomicLatestError(SnapshotError):
    def __init__(self, message: str, *, installed: bool, displaced: str | None) -> None:
        super().__init__(message)
        self.installed = installed
        self.displaced = displaced


def inspect_name(
    handle: DirectoryHandle,
    name: str,
    lane: Lane,
    max_bytes: int,
    *,
    allow_invalid: bool,
) -> tuple[LatestState, Snapshot | None]:
    handle.verify()
    try:
        info = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
    except FileNotFoundError:
        return LatestState(False), None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise SnapshotError("existing latest.md is symlinked or non-regular; refusing overwrite")
    try:
        data = read_regular_bounded_at(handle, name, max_bytes)
        snapshot = validate_snapshot_bytes(
            data,
            max_bytes=max_bytes,
            expected_scope=lane.scope,
            path=lane.directory / name,
        )
        valid = True
        agent = snapshot.metadata.get("Agent", "Unknown")
        digest = snapshot.sha256
    except SnapshotError as exc:
        if not allow_invalid:
            raise SnapshotError(
                f"existing latest.md is invalid ({sanitize_display(str(exc), 180)}); "
                "review it and use --replace-invalid-latest or an exact hash precondition"
            ) from exc
        snapshot = None
        valid = False
        agent = "Unknown"
        try:
            raw = read_regular_bounded_at(handle, name, max_bytes)
            digest = hashlib.sha256(raw).hexdigest()
        except SnapshotError:
            digest = ""
    return (
        LatestState(
            True,
            info.st_dev,
            info.st_ino,
            info.st_size,
            info.st_mtime_ns,
            digest,
            agent,
            valid,
        ),
        snapshot,
    )


def inspect_latest(
    handle: DirectoryHandle,
    lane: Lane,
    max_bytes: int,
    *,
    allow_invalid: bool,
) -> tuple[LatestState, Snapshot | None]:
    return inspect_name(handle, "latest.md", lane, max_bytes, allow_invalid=allow_invalid)


def state_matches(left: LatestState, right: LatestState) -> bool:
    return left == right


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write")
        view = view[written:]


def write_exclusive_at(handle: DirectoryHandle, name: str, data: bytes, mode: int = 0o600) -> None:
    handle.verify()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, mode, dir_fd=handle.fd)
    identity = (os.fstat(fd).st_dev, os.fstat(fd).st_ino)
    try:
        write_all(fd, data)
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        try:
            current = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) == identity:
                os.unlink(name, dir_fd=handle.fd)
        except OSError:
            pass
        raise
    else:
        os.close(fd)
    handle.verify()


def fsync_directory(handle: DirectoryHandle) -> None:
    try:
        os.fsync(handle.fd)
    except OSError:
        pass


def _rename_exchange_syscall(directory_fd: int, left: str, right: str) -> None:
    """Atomically exchange two names with Linux/macOS dirfd primitives."""
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is not None:
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        function.restype = ctypes.c_int
        result = function(directory_fd, os.fsencode(left), directory_fd, os.fsencode(right), 2)  # RENAME_EXCHANGE
    else:
        function = getattr(libc, "renameatx_np", None)
        if function is None:
            raise SnapshotError("atomic rename exchange is unavailable on this platform")
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        function.restype = ctypes.c_int
        result = function(directory_fd, os.fsencode(left), directory_fd, os.fsencode(right), 0x00000002)  # RENAME_SWAP
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def rename_exchange_at(directory_fd: int, left: str, right: str) -> None:
    _rename_exchange_syscall(directory_fd, left, right)


def rename_exchange_available(directory_fd: int | None = None) -> bool:
    libc = ctypes.CDLL(None)
    if getattr(libc, "renameat2", None) is None and getattr(libc, "renameatx_np", None) is None:
        return False
    if directory_fd is None:
        return True
    # A libc symbol can exist while an older kernel/filesystem rejects the
    # exchange flag. Probe two unpredictable absent names: ENOENT proves the
    # syscall/flag reached normal path lookup without creating anything.
    token = secrets.token_hex(16)
    left = f".exchange-probe-a.{token}"
    right = f".exchange-probe-b.{token}"
    try:
        _rename_exchange_syscall(directory_fd, left, right)
    except FileNotFoundError:
        return True
    except (OSError, SnapshotError):
        return False
    # Both names could only have appeared through a non-cooperating race.
    # Restore their original names before continuing.
    try:
        _rename_exchange_syscall(directory_fd, left, right)
    except (OSError, SnapshotError) as exc:
        raise SnapshotError("atomic exchange capability probe raced and could not be restored") from exc
    return True


def rollback_exchange_if_ours(handle: DirectoryHandle, tmp_name: str, new_identity: tuple[int, int], new_data: bytes) -> bool:
    """Rollback only our bytes, detecting pathname and in-place writer races."""
    def is_ours(name: str) -> bool:
        try:
            info = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
            return (
                (info.st_dev, info.st_ino) == new_identity
                and read_regular_bounded_at(handle, name, len(new_data)) == new_data
            )
        except (OSError, SnapshotError):
            return False

    if not is_ours("latest.md"):
        return False
    rename_exchange_at(handle.fd, "latest.md", tmp_name)
    if is_ours(tmp_name):
        return True
    # A new writer replaced our latest just before rollback.  Swap again so
    # that writer regains latest; preserve the displaced snapshot in tmp_name.
    rename_exchange_at(handle.fd, "latest.md", tmp_name)
    return False


def atomic_latest_cas(
    handle: DirectoryHandle,
    lane: Lane,
    data: bytes,
    mode: int,
    expected: LatestState,
    max_bytes: int,
) -> tuple[bool, str | None, str | None]:
    """Install latest only if the captured state still matches.

    Existing latest and the new temp inode are exchanged atomically, then the
    displaced inode is verified.  A mismatched/racing writer is restored only
    while latest still names our exact new inode; otherwise it is untouched.
    """
    token = f"{os.getpid()}.{secrets.token_hex(6)}"
    tmp_name = f".latest.new.{token}"
    old_name = tmp_name
    write_exclusive_at(handle, tmp_name, data, mode)
    new_info = os.stat(tmp_name, dir_fd=handle.fd, follow_symlinks=False)
    new_identity = (new_info.st_dev, new_info.st_ino)
    temp_exists = True
    latest_installed = False
    exchanged = False
    try:
        handle.verify()
        if expected.exists:
            try:
                rename_exchange_at(handle.fd, "latest.md", tmp_name)
            except FileNotFoundError:
                return False, "latest.md disappeared during conditional replace", None
            exchanged = True
            latest_installed = True
            moved, _ = inspect_name(handle, tmp_name, lane, max_bytes, allow_invalid=True)
            if not state_matches(expected, moved):
                try:
                    current = os.stat("latest.md", dir_fd=handle.fd, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if current is None:
                    try:
                        os.link(tmp_name, "latest.md", src_dir_fd=handle.fd, dst_dir_fd=handle.fd, follow_symlinks=False)
                        os.unlink(tmp_name, dir_fd=handle.fd)
                        temp_exists = False
                        exchanged = False
                        latest_installed = False
                        return False, "latest.md disappeared during CAS verification; displaced snapshot restored", None
                    except OSError:
                        return False, "latest.md disappeared during CAS verification", tmp_name
                if current is not None and (current.st_dev, current.st_ino) == new_identity:
                    restored = rollback_exchange_if_ours(handle, tmp_name, new_identity, data)
                    latest_installed = False
                    if restored:
                        exchanged = False
                        return False, "latest.md changed during atomic conditional replace", None
                    return False, "another writer raced with CAS rollback", tmp_name
                latest_installed = False
                return False, "another writer replaced latest.md during CAS verification", tmp_name
        else:
            try:
                os.stat("latest.md", dir_fd=handle.fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                return False, "latest.md appeared during conditional replace", None

        try:
            if not expected.exists:
                os.link(tmp_name, "latest.md", src_dir_fd=handle.fd, dst_dir_fd=handle.fd, follow_symlinks=False)
        except FileExistsError:
            return False, "another writer created latest.md during conditional replace", None
        if not expected.exists:
            latest_installed = True
        os.unlink(tmp_name, dir_fd=handle.fd)
        temp_exists = False
        exchanged = False
        fsync_directory(handle)
        handle.verify()
        return True, None, None
    except BaseException as exc:
        displaced: str | None = None
        if exchanged:
            try:
                current = os.stat("latest.md", dir_fd=handle.fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == new_identity:
                    restored = rollback_exchange_if_ours(handle, tmp_name, new_identity, data)
                    latest_installed = False
                    if restored:
                        exchanged = False
                    else:
                        displaced = tmp_name
                else:
                    latest_installed = False
                    displaced = tmp_name
            except FileNotFoundError:
                try:
                    os.link(tmp_name, "latest.md", src_dir_fd=handle.fd, dst_dir_fd=handle.fd, follow_symlinks=False)
                    os.unlink(tmp_name, dir_fd=handle.fd)
                    temp_exists = False
                    exchanged = False
                    latest_installed = False
                except BaseException:
                    displaced = tmp_name
            except BaseException:
                displaced = tmp_name
        if not isinstance(exc, (OSError, SnapshotError)):
            raise
        raise AtomicLatestError(
            f"conditional latest install failed: {exc}",
            installed=latest_installed,
            displaced=displaced,
        ) from exc
    finally:
        if temp_exists and not exchanged:
            try:
                os.unlink(tmp_name, dir_fd=handle.fd)
            except OSError:
                pass
        # If exchange rollback failed, tmp_name contains the displaced snapshot
        # and is intentionally retained/reported rather than deleted.


def lock_backend() -> str:
    if fcntl is not None:
        return "flock"
    if msvcrt is not None:
        return "msvcrt"
    raise SnapshotError("no supported advisory file-lock backend; refusing unsafe save")


def acquire_lock(handle: DirectoryHandle) -> tuple[Path, tuple[int, str]]:
    """Acquire an auto-releasing advisory lock on a persistent real file."""
    backend = lock_backend()
    handle.verify()
    lock = handle.directory / ".save.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(".save.lock", flags, 0o600, dir_fd=handle.fd)
    except OSError as exc:
        raise SnapshotError(f"save lock is unsafe or unavailable: {lock.name}: {exc}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise SnapshotError("save lock must be a real regular file")
        if info.st_nlink != 1:
            raise SnapshotError("save lock must not be hard-linked")
        if backend == "flock":
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[union-attr]
            except (BlockingIOError, OSError) as exc:
                raise SnapshotError("another save process holds the lane lock") from exc
        else:
            # msvcrt locks a byte range from the current position.  Ensure a
            # private one-byte file exists; nlink==1 prevents hardlink writes.
            if info.st_size < 1:
                write_all(fd, b"\0")
                os.fsync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)  # type: ignore[union-attr]
            except OSError as exc:
                raise SnapshotError("another save process holds the lane lock") from exc
        return lock, (fd, backend)
    except BaseException:
        os.close(fd)
        raise


def release_lock(handle: tuple[int, str]) -> None:
    fd, backend = handle
    try:
        if backend == "flock":
            fcntl.flock(fd, fcntl.LOCK_UN)  # type: ignore[union-attr]
        else:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)  # type: ignore[union-attr]
    finally:
        os.close(fd)


def checked_agent_backups(handle: DirectoryHandle, lane: Lane, agent: str) -> list[str]:
    handle.verify()
    try:
        names = os.listdir(handle.fd)
    except OSError as exc:
        raise SnapshotError(f"cannot list retention candidates: {exc}") from exc
    paths = sorted(
        (name for name in names if (parsed := parse_backup_name(name)) is not None and parsed[1] == agent),
        reverse=True,
    )
    for name in paths:
        try:
            info = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
        except OSError as exc:
            raise SnapshotError(f"unreadable retention candidate {name}: {exc}") from exc
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SnapshotError(f"unsafe retention candidate refused: {name}")
    return paths


def prune_saved_agent(handle: DirectoryHandle, lane: Lane, agent: str, keep: int, protected: str) -> list[str]:
    removed: list[str] = []
    paths = checked_agent_backups(handle, lane, agent)
    keep_set = set(paths[:keep])
    if protected not in keep_set:
        if len(keep_set) >= keep:
            keep_set.remove(sorted(keep_set)[0])
        keep_set.add(protected)
    for name in (item for item in paths if item not in keep_set):
        try:
            info = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise SnapshotError(f"unsafe retention candidate refused: {name}")
            identity = (info.st_dev, info.st_ino)
            tombstone = f".prune.{os.getpid()}.{secrets.token_hex(6)}.tmp"
            os.rename(name, tombstone, src_dir_fd=handle.fd, dst_dir_fd=handle.fd)
            moved = os.stat(tombstone, dir_fd=handle.fd, follow_symlinks=False)
            if (moved.st_dev, moved.st_ino) != identity:
                try:
                    os.link(
                        tombstone,
                        name,
                        src_dir_fd=handle.fd,
                        dst_dir_fd=handle.fd,
                        follow_symlinks=False,
                    )
                    os.unlink(tombstone, dir_fd=handle.fd)
                    location = name
                except OSError:
                    location = tombstone
                raise SnapshotError(
                    f"retention candidate changed during atomic quarantine; replacement preserved as {location}"
                )
            os.unlink(tombstone, dir_fd=handle.fd)
            removed.append(name)
        except OSError as exc:
            raise SnapshotError(f"retention failed for {name}: {exc}") from exc
    handle.verify()
    return removed


def timestamp_value(override: str | None) -> str:
    value = override or datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    if not STAMP_RE.fullmatch(value):
        raise SnapshotError("timestamp must use YYYY-MM-DD-HHMMSS")
    try:
        datetime.strptime(value, "%Y-%m-%d-%H%M%S")
    except ValueError as exc:
        raise SnapshotError("timestamp is not a real UTC date/time") from exc
    return value


def conflict_reason(
    state: LatestState,
    *,
    agent: str,
    expected_hash: str | None,
    expect_no_latest: bool,
    recent_seconds: int,
    allow_recent_other: bool,
    replace_invalid: bool,
) -> str | None:
    if expected_hash is not None and (not state.exists or state.sha256 != expected_hash):
        return "latest.md SHA-256 did not match --expected-latest-sha256"
    if expect_no_latest and state.exists:
        return "latest.md exists but --expect-no-latest was requested"
    invalid_override = replace_invalid and not state.valid
    if state.exists and state.agent != agent and not allow_recent_other and not invalid_override:
        age = max(0.0, time.time() - (state.mtime_ns / 1_000_000_000))
        if age <= recent_seconds:
            return f"latest.md was updated recently by different agent '{sanitize_display(state.agent)}'"
    if state.exists and expected_hash is None and not invalid_override:
        return "existing latest.md requires --expected-latest-sha256; refusing unconditional replacement"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate and safely save one handoff snapshot.")
    parser.add_argument("--root", default=".", help="Repo root or working directory")
    parser.add_argument("--dir", default=".handoff", help="Handoff directory under root")
    parser.add_argument("--scope", help="Selected scoped lane; omit for the default lane")
    parser.add_argument("--agent", required=True, help="Writer suffix and required Agent metadata")
    parser.add_argument("--input", default="-", help="Snapshot source file, or - for stdin")
    parser.add_argument("--max-bytes", type=int, default=MAX_DEFAULT_BYTES, help="Positive maximum snapshot size")
    parser.add_argument("--expected-latest-sha256", help="CAS: update latest only if its content hash matches")
    parser.add_argument("--expect-no-latest", action="store_true", help="CAS: update latest only if it does not exist")
    parser.add_argument("--recent-seconds", type=int, default=600, help="Protect a recent latest from another agent")
    parser.add_argument("--allow-recent-other-agent", action="store_true", help="Explicitly override only the recent-agent guard")
    parser.add_argument(
        "--replace-invalid-latest",
        action="store_true",
        help="Explicitly allow replacement of a reviewed invalid/oversized regular latest.md",
    )
    parser.add_argument("--keep", type=int, default=20, help="Backups for this agent to retain in this lane")
    parser.add_argument("--no-prune", action="store_true", help="Skip integrated retention")
    parser.add_argument("--timestamp", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if not valid_agent(args.agent):
        print("Error: --agent must match ^[a-z0-9][a-z0-9-]{0,31}$", file=sys.stderr)
        return 2
    if args.scope is not None and not valid_scope(args.scope):
        print("Error: invalid --scope slug", file=sys.stderr)
        return 2
    if args.expected_latest_sha256 and args.expect_no_latest:
        print("Error: use only one CAS precondition", file=sys.stderr)
        return 2
    if args.expected_latest_sha256 and not SHA256_RE.fullmatch(args.expected_latest_sha256):
        print("Error: --expected-latest-sha256 must be 64 lowercase hex characters", file=sys.stderr)
        return 2
    if args.recent_seconds < 0 or args.keep < 1 or args.max_bytes < 1:
        print("Error: recent-seconds must be >= 0; keep and max-bytes must be >= 1", file=sys.stderr)
        return 2

    try:
        if args.input == "-":
            data = read_stream_bounded(sys.stdin.buffer, args.max_bytes)
        else:
            data = read_regular_bounded(Path(args.input).expanduser(), args.max_bytes)
        payload = validate_snapshot_bytes(
            data,
            max_bytes=args.max_bytes,
            expected_scope=args.scope,
            expected_agent=args.agent,
        )
        stamp = timestamp_value(args.timestamp)
        require_dirfd_support(os.open, os.stat, os.mkdir, os.link, os.unlink, list_fd=True)
        root_arg = Path(args.root).expanduser()
        dir_arg = Path(args.dir).expanduser()
        root, handoff = handoff_location(root_arg, dir_arg)
        lane_path = handoff if args.scope is None else handoff / "scopes" / args.scope
        lane = Lane(args.scope, lane_path, root)
        lane_handle = open_directory_handle(root, lane_path, create=True)
    except SnapshotError as exc:
        print(f"Error: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2

    latest = lane.directory / "latest.md"
    backup_name = f"{stamp}-{args.agent}.md"
    backup = lane.directory / backup_name
    lock_handle: tuple[int, str] | None = None
    displaced_name: str | None = None
    backup_created = False
    latest_replaced = False
    try:
        _, lock_handle = acquire_lock(lane_handle)
        before, _ = inspect_latest(
            lane_handle,
            lane,
            args.max_bytes,
            allow_invalid=args.replace_invalid_latest or args.expected_latest_sha256 is not None,
        )
        # Fail before writing if retention would later encounter a malicious
        # same-agent filename.  A post-save I/O failure is still reported as a
        # partial save below with exact persisted paths.
        checked_agent_backups(lane_handle, lane, args.agent)
        reason = conflict_reason(
            before,
            agent=args.agent,
            expected_hash=args.expected_latest_sha256,
            expect_no_latest=args.expect_no_latest,
            recent_seconds=args.recent_seconds,
            allow_recent_other=args.allow_recent_other_agent,
            replace_invalid=args.replace_invalid_latest,
        )
        if reason is None and before.exists and not rename_exchange_available(lane_handle.fd):
            raise SnapshotError("atomic rename exchange is unavailable; refusing before backup write")

        # Backup first, with O_EXCL.  On a CAS/recent-writer conflict this is
        # intentionally a recoverable backup-only save; latest stays intact.
        write_exclusive_at(lane_handle, backup_name, payload.data)
        backup_created = True
        fsync_directory(lane_handle)
        saved_backup = validate_snapshot_at(
            backup_name,
            lane,
            lane_handle,
            args.max_bytes,
            expected_agent=args.agent,
            display_path=backup,
        )
        if saved_backup.data != payload.data:
            raise SnapshotError("dated backup parity verification failed")

        if reason is None:
            after_backup, _ = inspect_latest(lane_handle, lane, args.max_bytes, allow_invalid=True)
            if not state_matches(before, after_backup):
                reason = "latest.md changed during save (CAS conflict)"

        updated_latest = False
        if reason is None:
            try:
                installed, atomic_reason, displaced_name = atomic_latest_cas(
                    lane_handle, lane, payload.data, 0o600, before, args.max_bytes
                )
            except AtomicLatestError as exc:
                latest_replaced = exc.installed
                displaced_name = exc.displaced
                raise
            if not installed:
                reason = atomic_reason or "conditional latest install failed"
            else:
                latest_replaced = True
                saved_latest = validate_snapshot_at(
                    "latest.md",
                    lane,
                    lane_handle,
                    args.max_bytes,
                    expected_agent=args.agent,
                    display_path=latest,
                )
                if saved_latest.data != saved_backup.data:
                    raise SnapshotError("latest/backup parity verification failed")
                updated_latest = True

        removed: list[str] = []
        if not args.no_prune:
            removed = prune_saved_agent(lane_handle, lane, args.agent, args.keep, backup_name)
            fsync_directory(lane_handle)

        print(f"BACKUP: {path_display(backup, root)}")
        print(f"- SHA-256: {hashlib.sha256(payload.data).hexdigest()}")
        print(f"- Retention pruned: {len(removed)}")
        if updated_latest:
            print(f"LATEST: {path_display(latest, root)}")
            print("- Parity: verified")
            return 0
        print("LATEST: NOT UPDATED")
        print(f"- Conflict: {sanitize_display(reason or 'unknown', 300)}")
        if displaced_name:
            print(f"- Preserved displaced snapshot: {path_display(lane.directory / displaced_name, root)}")
        return 3
    except FileExistsError:
        print(f"Error: backup already exists; nothing overwritten: {path_display(backup, root)}", file=sys.stderr)
        return 2
    except (OSError, SnapshotError) as exc:
        if backup_created:
            print("SAVE PARTIAL:")
            try:
                lane_handle.verify()
                backup_report = path_display(backup, root)
            except SnapshotError:
                backup_report = "original lane inode (pathname identity changed; inspect manually)"
            print(f"- Backup persisted: {backup_report}")
            print(f"- latest.md replaced: {'yes' if latest_replaced else 'no'}")
            if displaced_name:
                print(f"- Preserved displaced snapshot: {path_display(lane.directory / displaced_name, root)}")
            print("- Retention/parity may be incomplete; inspect before resuming.")
        print(f"Error: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 4 if backup_created else 2
    finally:
        if lock_handle is not None:
            release_lock(lock_handle)
        lane_handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
