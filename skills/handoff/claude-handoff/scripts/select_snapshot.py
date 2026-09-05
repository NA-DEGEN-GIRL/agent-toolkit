#!/usr/bin/env python3
"""Deterministically select latest, then newest valid same-lane backup."""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import argparse
from pathlib import Path

from snapshot_common import (
    MAX_DEFAULT_BYTES,
    SnapshotError,
    lane_for,
    path_display,
    redact_snapshot_content,
    resolve_handoff,
    sanitize_display,
    select_valid_snapshot,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Select a validated snapshot from exactly one handoff lane.")
    parser.add_argument("--root", default=".", help="Repo root or working directory")
    parser.add_argument("--dir", default=".handoff", help="Handoff directory under root")
    parser.add_argument("--scope", help="Selected scoped lane; omit for the default lane")
    parser.add_argument("--max-bytes", type=int, default=MAX_DEFAULT_BYTES, help="Positive maximum snapshot size")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--path-only", action="store_true", help="Exact repo-relative machine path; capture locally, do not display sensitive paths")
    output.add_argument("--content", action="store_true", help="Read already-validated snapshot content with best-effort redaction; no pathname reopen")
    args = parser.parse_args()

    try:
        root, handoff = resolve_handoff(Path(args.root).expanduser(), Path(args.dir).expanduser())
        lane = lane_for(handoff, args.scope)
        snapshot, errors = select_valid_snapshot(lane, args.max_bytes)
    except SnapshotError as exc:
        print(f"Error: {sanitize_display(str(exc), 300)}", file=sys.stderr)
        return 2

    if snapshot is None or snapshot.path is None:
        print(f"No valid handoff snapshot in lane {sanitize_display(lane.label)}.", file=sys.stderr)
        for error in errors:
            print(f"- {sanitize_display(error, 300)}", file=sys.stderr)
        return 1

    selected = path_display(snapshot.path, root)
    if args.path_only:
        # This explicit machine channel must never silently change/truncate a
        # valid pathname. Default user-facing diagnostics remain redacted.
        print(snapshot.path.relative_to(root).as_posix())
        return 0
    if args.content:
        print(f"SELECTED DISPLAY: {selected}", file=sys.stderr)
        print(f"- SHA-256 (original validated bytes): {snapshot.sha256}", file=sys.stderr)
        sys.stdout.write(redact_snapshot_content(snapshot.text))
        return 0
    source = "latest" if snapshot.path.name == "latest.md" else "dated backup"
    print(f"SELECTED: {selected}")
    print("- Path display may be redacted; use --content to read safely, not this display as a pathname.")
    print(f"- Lane: {sanitize_display(lane.label)}")
    print(f"- Source: {source}")
    print(f"- Agent: {sanitize_display(snapshot.metadata.get('Agent', 'Unknown'))}")
    print(f"- Created at: {sanitize_display(snapshot.metadata.get('Created at', 'Unknown'))}")
    print(f"- SHA-256: {snapshot.sha256}")
    for error in errors:
        print(f"- Skipped: {sanitize_display(error, 300)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
