#!/usr/bin/env python3
"""Prune real, validly timestamped backups per lane and agent."""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import argparse
import os
import secrets
import stat
from pathlib import Path

from snapshot_common import (
    DirectoryHandle,
    Lane,
    SnapshotError,
    discover_lanes,
    handoff_location,
    lane_for,
    open_directory_handle,
    parse_backup_name,
    path_display,
    resolve_handoff,
    require_dirfd_support,
    sanitize_display,
    valid_agent,
    valid_scope,
)


def find_matches(handle: DirectoryHandle, agent: str) -> tuple[list[tuple[str, int, tuple[int, int]]], list[str], bool]:
    matches: list[tuple[str, int, tuple[int, int]]] = []
    warnings: list[str] = []
    unsafe = False
    try:
        entries = os.listdir(handle.fd)
    except OSError as exc:
        raise SnapshotError(f"cannot list requested lane: {exc}") from exc
    for name in entries:
        if name == "latest.md":
            continue
        parsed = parse_backup_name(name)
        looks_requested = name.endswith(f"-{agent}.md")
        if parsed is None:
            if looks_requested:
                warnings.append(f"skipping invalid timestamp/name: {sanitize_display(name)}")
            continue
        if parsed[1] != agent:
            continue
        try:
            info = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
        except OSError as exc:
            warnings.append(f"unreadable candidate: {sanitize_display(name)} ({sanitize_display(str(exc))})")
            unsafe = True
            continue
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            warnings.append(f"unsafe candidate refused: {sanitize_display(name)}")
            unsafe = True
            continue
        matches.append((name, info.st_mtime_ns, (info.st_dev, info.st_ino)))
    return matches, warnings, unsafe


def sort_matches(paths: list[tuple[str, int, tuple[int, int]]], mode: str) -> list[tuple[str, int, tuple[int, int]]]:
    if mode == "mtime":
        return sorted(paths, key=lambda item: (item[1], item[0]), reverse=True)
    return sorted(paths, key=lambda item: item[0], reverse=True)


def prune_lane(lane: Lane, root: Path, agent: str, keep: int, sort_mode: str, dry_run: bool) -> int:
    try:
        with open_directory_handle(root, lane.directory) as handle:
            matches, warnings, unsafe = find_matches(handle, agent)
            return prune_open_lane(handle, lane, root, agent, keep, sort_mode, dry_run, matches, warnings, unsafe)
    except SnapshotError as exc:
        print(f"Refusing unsafe requested lane: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2


def prune_open_lane(
    handle: DirectoryHandle,
    lane: Lane,
    root: Path,
    agent: str,
    keep: int,
    sort_mode: str,
    dry_run: bool,
    matches: list[tuple[str, int, tuple[int, int]]],
    warnings: list[str],
    unsafe: bool,
) -> int:
    for warning in warnings:
        print(f"Warning: {warning}")
    matches = sort_matches(matches, sort_mode)
    if not matches:
        print(f"No valid timestamped backups for agent `{agent}` in {path_display(lane.directory, root)}; nothing to prune.")
        return 1 if unsafe else 0

    keep_list, drop = matches[:keep], matches[keep:]
    print(f"Directory: {path_display(lane.directory, root)}")
    print(f"Agent:     {agent}")
    print(f"Sort:      {sort_mode}")
    print(f"Matched:   {len(matches)} valid timestamped backup(s)")
    print(f"Keeping:   {len(keep_list)} (newest)")
    print(f"Pruning:   {len(drop)}")

    rc = 1 if unsafe else 0
    for name, _, identity in drop:
        action = "would delete" if dry_run else "deleting"
        print(f"  {action}: {name}")
        if dry_run:
            continue
        try:
            handle.verify()
            before = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
            if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
                print(f"    refused: candidate became unsafe", file=sys.stderr)
                rc = 1
                continue
            if (before.st_dev, before.st_ino) != identity:
                print("    refused: candidate identity changed", file=sys.stderr)
                rc = 1
                continue
            tombstone = f".prune.{os.getpid()}.{secrets.token_hex(6)}.tmp"
            os.rename(name, tombstone, src_dir_fd=handle.fd, dst_dir_fd=handle.fd)
            moved = os.stat(tombstone, dir_fd=handle.fd, follow_symlinks=False)
            if (moved.st_dev, moved.st_ino) != identity:
                try:
                    os.link(tombstone, name, src_dir_fd=handle.fd, dst_dir_fd=handle.fd, follow_symlinks=False)
                    os.unlink(tombstone, dir_fd=handle.fd)
                except OSError:
                    print(f"    refused: replacement preserved as {tombstone}", file=sys.stderr)
                print("    refused: candidate changed during atomic quarantine", file=sys.stderr)
                rc = 1
                continue
            os.unlink(tombstone, dir_fd=handle.fd)
        except OSError as exc:
            print(f"    failed: {sanitize_display(str(exc))}", file=sys.stderr)
            rc = 1
    handle.verify()
    return rc


def main() -> int:
    parser = argparse.ArgumentParser(description="Keep newest N timestamped handoff backups per requested lane.")
    parser.add_argument("--dir", default=".handoff", help="Handoff directory under root")
    parser.add_argument("--root", default=".", help="Expected project root")
    parser.add_argument("--agent", required=True, help="Exact safe agent suffix, e.g. codex or claude")
    parser.add_argument("--keep", type=int, default=20, help="Number of newest backups to retain per lane")
    parser.add_argument("--sort", choices=("name", "mtime"), default="name", help="Newest ordering")
    parser.add_argument("--scope", help="Prune only this scoped lane")
    parser.add_argument("--all-lanes", action="store_true", help="Prune the default and all safely discovered scoped lanes")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without deleting")
    args = parser.parse_args()

    if args.keep < 1:
        print("--keep must be >= 1", file=sys.stderr)
        return 2
    if not valid_agent(args.agent):
        print("--agent must match ^[a-z0-9][a-z0-9-]{0,31}$", file=sys.stderr)
        return 2
    if args.scope is not None and args.all_lanes:
        print("Use either --scope or --all-lanes, not both", file=sys.stderr)
        return 2

    root_arg = Path(args.root).expanduser()
    dir_arg = Path(args.dir).expanduser()
    try:
        require_dirfd_support(os.open, os.stat, os.mkdir, os.rename, os.link, os.unlink, list_fd=True)
        raw_root, raw_handoff = handoff_location(root_arg, dir_arg)
    except SnapshotError as exc:
        print(f"Refusing unsafe requested lane: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2
    if not os.path.lexists(raw_handoff):
        print(f"No handoff directory at {path_display(raw_handoff, raw_root)}; nothing to prune.")
        return 0
    try:
        root, handoff = resolve_handoff(root_arg, dir_arg)
        warnings: list[str] = []
        if args.scope is not None:
            if not valid_scope(args.scope):
                raise SnapshotError(f"invalid scope '{args.scope}'")
            scopes_root = handoff / "scopes"
            if os.path.lexists(scopes_root):
                scope_info = scopes_root.lstat()
                if stat.S_ISLNK(scope_info.st_mode) or not stat.S_ISDIR(scope_info.st_mode):
                    raise SnapshotError("unsafe scopes directory")
            lane_path = handoff / "scopes" / args.scope
            if not os.path.lexists(lane_path):
                print(f"No requested lane at {path_display(lane_path, root)}; nothing to prune.")
                return 0
            lanes = [lane_for(handoff, args.scope)]
        elif args.all_lanes:
            discovered, warnings = discover_lanes(handoff, root)
            default = Lane(None, handoff)
            lanes = [default, *(lane for lane in discovered if lane.scope is not None)]
        else:
            lanes = [Lane(None, handoff)]
    except SnapshotError as exc:
        print(f"Refusing unsafe requested lane: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2

    rc = 1 if warnings else 0
    for warning in warnings:
        print(f"Warning: {sanitize_display(warning)}", file=sys.stderr)
    multi = len(lanes) > 1
    for lane in lanes:
        if multi:
            print(f"== Lane: {lane.label} ==")
        rc = max(rc, prune_lane(lane, root, args.agent, args.keep, args.sort, args.dry_run))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
