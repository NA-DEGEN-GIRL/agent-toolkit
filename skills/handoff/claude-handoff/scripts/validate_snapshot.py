#!/usr/bin/env python3
"""Validate one in-lane handoff snapshot before loading it into context."""
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
    resolve_handoff,
    sanitize_display,
    validate_snapshot_path,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely validate an in-lane handoff snapshot.")
    parser.add_argument("path", help="Snapshot path in the selected lane")
    parser.add_argument("--root", default=".", help="Repo root or working directory")
    parser.add_argument("--dir", default=".handoff", help="Handoff directory under root")
    parser.add_argument("--scope", help="Selected scoped lane; omit for the default lane")
    parser.add_argument("--max-bytes", type=int, default=MAX_DEFAULT_BYTES, help="Positive maximum snapshot size")
    args = parser.parse_args()

    try:
        root, handoff = resolve_handoff(Path(args.root).expanduser(), Path(args.dir).expanduser())
        lane = lane_for(handoff, args.scope)
        path_arg = Path(args.path).expanduser()
        selected_path = path_arg if path_arg.is_absolute() else root / path_arg
        snapshot = validate_snapshot_path(selected_path, lane, args.max_bytes)
    except SnapshotError as exc:
        print(f"INVALID: {sanitize_display(args.path, 240)}")
        print(f"- {sanitize_display(str(exc), 300)}")
        return 1

    print(f"OK: {path_display(snapshot.path or Path(args.path), root)}")
    for key in ("Schema Version", "Agent", "Skill Variant", "Scope"):
        if key == "Scope" and lane.scope is None:
            continue
        print(f"- {key}: {sanitize_display(snapshot.metadata.get(key, 'Unknown'))}")
    if not snapshot.metadata:
        print("- Metadata: missing or unparseable; treat missing fields as Unknown")
    print(f"- SHA-256: {snapshot.sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
