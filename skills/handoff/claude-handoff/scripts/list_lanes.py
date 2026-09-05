#!/usr/bin/env python3
"""List safe handoff lanes, including backup-only (orphan) lanes."""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import argparse
import os
from pathlib import Path

from snapshot_common import (
    MAX_DEFAULT_BYTES,
    SnapshotError,
    discover_lanes,
    first_section_line,
    handoff_location,
    path_display,
    resolve_handoff,
    sanitize_display,
    select_valid_snapshot,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="List validated handoff lanes for resume selection.")
    parser.add_argument("--root", default=".", help="Repo root or working directory")
    parser.add_argument("--dir", default=".handoff", help="Handoff directory under root")
    parser.add_argument("--max-bytes", type=int, default=MAX_DEFAULT_BYTES, help="Positive maximum snapshot size")
    args = parser.parse_args()

    root_arg = Path(args.root).expanduser()
    dir_arg = Path(args.dir).expanduser()
    try:
        raw_root, raw_handoff = handoff_location(root_arg, dir_arg)
    except SnapshotError as exc:
        print(f"Error: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2
    if not os.path.lexists(raw_handoff):
        print(f"No handoff lanes found under {path_display(raw_handoff, raw_root)}")
        return 0

    try:
        root, handoff = resolve_handoff(root_arg, dir_arg)
        lanes, warnings = discover_lanes(handoff, root)
    except SnapshotError as exc:
        print(f"Error: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2

    if not lanes:
        print(f"No handoff lanes found under {path_display(handoff, root)}")
        for warning in warnings:
            print(f"Warning: {sanitize_display(warning)}", file=sys.stderr)
        return 1 if warnings else 0

    print(f"Handoff lanes under {path_display(handoff, root)}:")
    invalid = False
    for lane in lanes:
        snapshot, errors = select_valid_snapshot(lane, args.max_bytes)
        if snapshot is None:
            invalid = True
            reason = errors[0] if errors else "no valid snapshot"
            print(f"- {sanitize_display(lane.label)}: INVALID ({sanitize_display(reason, 240)})")
            continue
        agent = sanitize_display(snapshot.metadata.get("Agent", "Unknown"))
        created = sanitize_display(snapshot.metadata.get("Created at", "Unknown"))
        goal = sanitize_display(first_section_line(snapshot.text, "## Project Goal") or "(no goal line)", 100)
        source = "latest" if snapshot.path and snapshot.path.name == "latest.md" else "backup"
        print(f"- {sanitize_display(lane.label)}: agent={agent}, created={created}, source={source}")
        print(f"    goal: {goal}")
        if snapshot.path is not None:
            print(f"    path: {path_display(snapshot.path, root)}")
        if errors:
            print(f"    fallback: {sanitize_display(errors[0], 220)}")
    for warning in warnings:
        invalid = True
        print(f"Warning: {sanitize_display(warning)}", file=sys.stderr)
    return 1 if invalid else 0


if __name__ == "__main__":
    raise SystemExit(main())
