#!/usr/bin/env python3
"""Idempotently insert or replace a Markdown marker block.

Reads a complete block from --block-file or stdin. The block must include both
markers, e.g. <!-- BEGIN handoff-rule --> and <!-- END handoff-rule -->.
Creates without clobbering or conditionally exchanges an existing file, preserving
concurrent edits in place or in an explicitly reported recovery file.
"""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import argparse
import os
import hashlib
import secrets
import stat
from pathlib import Path

from snapshot_common import (
    MAX_DEFAULT_BYTES,
    SnapshotError,
    absolute_lexical,
    is_relative_to,
    open_directory_handle,
    path_display,
    read_regular_bounded,
    read_stream_bounded,
    require_dirfd_support,
    sanitize_display,
)
from save_snapshot import rename_exchange_at, rename_exchange_available

DEFAULT_BEGIN = "<!-- BEGIN handoff-rule -->"
DEFAULT_END = "<!-- END handoff-rule -->"


def read_text(handle: object, name: str) -> tuple[str, int | None, tuple[int, int, int, int, str] | None]:
    try:
        info = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)  # type: ignore[attr-defined]
    except FileNotFoundError:
        return "", None, None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValueError("target must be a real regular file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, dir_fd=handle.fd)  # type: ignore[attr-defined]
    try:
        data = b""
        while len(data) <= 4 * 1024 * 1024:
            chunk = os.read(fd, min(65536, 4 * 1024 * 1024 + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        opened = os.fstat(fd)
    finally:
        os.close(fd)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("target exceeds 4 MiB safety cap")
    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError("target changed during safe open")
    text = data.decode("utf-8")
    token = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, hashlib.sha256(data).hexdigest())
    return text, stat.S_IMODE(info.st_mode), token


def atomic_write(handle: object, name: str, text: str, mode: int | None, token: tuple[int, int, int, int, str] | None) -> None:
    if token is not None and not rename_exchange_available(handle.fd):  # type: ignore[attr-defined]
        raise ValueError("atomic exchange is unavailable; refusing concurrent-unsafe overwrite")
    tmp = f".{name}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(tmp, flags, 0o600, dir_fd=handle.fd)  # type: ignore[attr-defined]
    new_info = os.fstat(fd)
    new_identity = (new_info.st_dev, new_info.st_ino)
    new_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    displaced = False

    def identity(entry: str) -> tuple[int, int] | None:
        try:
            info = os.stat(entry, dir_fd=handle.fd, follow_symlinks=False)  # type: ignore[attr-defined]
        except FileNotFoundError:
            return None
        return info.st_dev, info.st_ino

    def is_ours(entry: str) -> bool:
        if identity(entry) != new_identity:
            return False
        _, _, found = read_text(handle, entry)
        return found is not None and found[-1] == new_digest

    def restore() -> bool:
        """Restore a displaced edit without discarding a later writer's entry."""
        current = identity(name)
        if current is None:
            try:
                os.link(tmp, name, src_dir_fd=handle.fd, dst_dir_fd=handle.fd, follow_symlinks=False)  # type: ignore[attr-defined]
                os.unlink(tmp, dir_fd=handle.fd)  # type: ignore[attr-defined]
                return True
            except OSError:
                return False
        if not is_ours(name):
            return False
        rename_exchange_at(handle.fd, name, tmp)  # type: ignore[attr-defined]
        if is_ours(tmp):
            return True
        # Another writer won between our identity check and rollback exchange.
        # Give that writer its pathname back and retain the displaced edit.
        rename_exchange_at(handle.fd, name, tmp)  # type: ignore[attr-defined]
        return False

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            os.fchmod(f.fileno(), mode if mode is not None else 0o644)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        handle.verify()  # type: ignore[attr-defined]
        if token is None:
            # A check followed by rename would clobber a concurrent first file.
            os.link(tmp, name, src_dir_fd=handle.fd, dst_dir_fd=handle.fd, follow_symlinks=False)  # type: ignore[attr-defined]
        else:
            rename_exchange_at(handle.fd, name, tmp)  # type: ignore[attr-defined]
            displaced = True
            _, _, moved_token = read_text(handle, tmp)
            if moved_token != token:
                raise ValueError("target changed since read; refusing concurrent overwrite")
        handle.verify()  # type: ignore[attr-defined]
        if not is_ours(name):
            raise ValueError("another writer replaced the marker update")
        os.unlink(tmp, dir_fd=handle.fd)  # type: ignore[attr-defined]
        displaced = False
        os.fsync(handle.fd)  # type: ignore[attr-defined]
    except BaseException as exc:
        if displaced:
            try:
                restored = restore()
            except (OSError, SnapshotError):
                restored = False
            if restored:
                displaced = False
            else:
                raise ValueError(
                    f"marker update conflicted; displaced file preserved beside target as {tmp}; inspect before retrying"
                ) from exc
        raise
    finally:
        if not displaced:
            try:
                # Never remove a preserved external replacement.
                if is_ours(tmp):
                    os.unlink(tmp, dir_fd=handle.fd)  # type: ignore[attr-defined]
            except FileNotFoundError:
                pass


def apply_block(original: str, block: str, begin: str, end: str) -> tuple[str, str]:
    if not begin or not end or begin == end:
        raise ValueError("begin/end markers must be distinct and non-empty")
    if block.count(begin) != 1 or block.count(end) != 1:
        raise ValueError("block must contain each marker exactly once")
    if block.index(begin) > block.index(end):
        raise ValueError("block must contain begin/end markers in order")
    if original.count(begin) > 1 or original.count(end) > 1:
        raise ValueError("target contains duplicate markers; refusing ambiguous replacement")
    start = original.find(begin)
    finish = original.find(end)
    if (start == -1) ^ (finish == -1):
        raise ValueError("target contains only one marker; refusing partial replacement")
    if start != -1:
        if start > finish:
            raise ValueError("target markers are out of order")
        finish += len(end)
        new_text = original[:start] + block.strip() + original[finish:]
        return new_text, "replaced"
    separator = "" if not original or original.endswith("\n\n") else ("\n" if original.endswith("\n") else "\n\n")
    return original + separator + block.strip() + "\n", "inserted"


def main() -> int:
    parser = argparse.ArgumentParser(description="Insert or replace a marker-delimited Markdown block.")
    parser.add_argument("--file", required=True, help="Target Markdown file")
    parser.add_argument("--root", default=".", help="Trusted repo root containing the target")
    parser.add_argument("--block-file", help="File containing full marker block; stdin is used when omitted")
    parser.add_argument("--begin", default=DEFAULT_BEGIN, help="Begin marker")
    parser.add_argument("--end", default=DEFAULT_END, help="End marker")
    parser.add_argument("--dry-run", action="store_true", help="Print action without writing")
    args = parser.parse_args()

    root = absolute_lexical(Path(args.root).expanduser())
    target_arg = Path(args.file).expanduser()
    target = absolute_lexical(target_arg if target_arg.is_absolute() else root / target_arg)
    if not is_relative_to(target, root):
        print("Error: target is outside --root", file=sys.stderr)
        return 2
    try:
        block_data = (
            read_regular_bounded(Path(args.block_file).expanduser(), MAX_DEFAULT_BYTES)
            if args.block_file
            else read_stream_bounded(sys.stdin.buffer, MAX_DEFAULT_BYTES)
        )
        block = block_data.decode("utf-8")
        require_dirfd_support(os.open, os.stat, os.mkdir, os.link, os.unlink)
        with open_directory_handle(root, target.parent) as handle:
            original, mode, token = read_text(handle, target.name)
            new_text, action = apply_block(original, block, args.begin, args.end)
            if not args.dry_run:
                atomic_write(handle, target.name, new_text, mode, token)
    except (OSError, UnicodeError, ValueError, SnapshotError) as exc:
        print(f"Error: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"Would {action} marker block in {path_display(target, root)}")
        return 0
    print(f"{action.capitalize()} marker block in {path_display(target, root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
