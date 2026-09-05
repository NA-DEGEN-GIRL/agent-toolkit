#!/usr/bin/env python3
"""Emit a compact, safe Markdown repo-state fragment for handoff snapshots.

This script intentionally avoids raw diffs and file contents. It uses git metadata
when available and a bounded filesystem-only fallback for non-git directories.
"""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import argparse
import hashlib
import os
import re
import selectors
import signal
import stat
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from snapshot_common import SnapshotError, open_directory_handle, redact_label, sanitize_display

DEFAULT_VERSION = "0.1.11"
SCHEMA_VERSION = "handoff-v1"

EXCLUDE_DIRS = {
    ".git",
    ".handoff",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    "dist",
    "build",
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    "gcloud",
}
SENSITIVE_HINTS = (
    ".env",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".ssh/",
    "anthropic_api",
    "api-key",
    "apikey",
    "api_key",
    "auth.json",
    "authorized_keys",
    "aws_access",
    "client_secret",
    "cookie",
    "credential",
    "credentials",
    "docker-config.json",
    "gcp-sa",
    "github_token",
    "id_dsa",
    "id_ed25519",
    "id_rsa",
    "kubeconfig",
    "openai_api",
    "passwd",
    "password",
    "private",
    "private_key",
    "secret",
    "secrets",
    "service-account",
    "service_account",
    "slack_bot",
    "token",
    ".pem",
    ".p12",
    ".pfx",
)
SENSITIVE_PATTERNS = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"sk-[A-Za-z0-9_-]{8,}",
        r"AKIA[0-9A-Z]{8,}",
        r"ASIA[0-9A-Z]{8,}",
        r"ghp_[A-Za-z0-9_]{8,}",
        r"github_pat_[A-Za-z0-9_]{8,}",
        r"xox[baprs]-[A-Za-z0-9-]{8,}",
        r"ya29\.[A-Za-z0-9_-]{8,}",
        r"(?:^|[/_.-])(?:access|refresh|id)?token(?:[/_.-]|$)",
        r"(?:^|[/_.-])(?:api|private|secret|access)[_-]?key(?:[/_.-]|$)",
    )
)


@dataclass
class CmdResult:
    code: int
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    stdout_bytes: bytes = b""


@dataclass(frozen=True)
class ProbeLine:
    value: str
    synthetic: bool = False


def load_version() -> str:
    version_file = Path(__file__).resolve().parents[1] / "VERSION"
    try:
        value = version_file.read_text(encoding="utf-8").strip()
        return value or DEFAULT_VERSION
    except OSError:
        return DEFAULT_VERSION


def run(cmd: list[str], cwd: Path, capture_bytes: int = 65536, timeout: float = 30) -> CmdResult:
    """Bound retained bytes and the lifetime of both the child and its pipes."""
    capture_bytes = max(1, min(capture_bytes, 1024 * 1024))
    # Do not inherit repository/index/object routing, injected configuration,
    # external helpers, or trace output paths from the caller.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update({
        "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0",
        "GIT_PAGER": "cat", "PAGER": "cat", "GIT_NO_LAZY_FETCH": "1",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
    })
    try:
        p = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            start_new_session=os.name == "posix",
        )
    except OSError as exc:
        return CmdResult(127, stderr=str(exc))
    captured: dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = {"stdout": False, "stderr": False}
    timed_out = False
    deadline = time.monotonic() + timeout

    def terminate_group() -> None:
        try:
            if os.name == "posix":
                os.killpg(p.pid, signal.SIGKILL)
            else:  # Windows is not part of the release baseline.
                p.kill()
        except ProcessLookupError:
            pass

    try:
        with selectors.DefaultSelector() as selector:
            for name, stream in (("stdout", p.stdout), ("stderr", p.stderr)):
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map() or p.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    terminate_group()
                    break
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    name = key.data
                    room = max(0, capture_bytes + 1 - len(captured[name]))
                    captured[name].extend(chunk[:room])
                    if len(chunk) > room or len(captured[name]) > capture_bytes:
                        truncated[name] = True
        code = p.wait(timeout=1)
    finally:
        # Killing only the leader does not release pipes held by descendants.
        # Also reap background descendants when the leader exited normally.
        terminate_group()
        if p.stdout is not None:
            p.stdout.close()
        if p.stderr is not None:
            p.stderr.close()
        if p.poll() is None:
            p.kill()
            p.wait(timeout=1)

    def decoded(name: str) -> str:
        return bytes(captured[name][:capture_bytes]).decode("utf-8", "replace").strip()

    if timed_out:
        return CmdResult(124, decoded("stdout"), "command timed out", True, truncated["stdout"], truncated["stderr"], bytes(captured["stdout"][:capture_bytes]))
    return CmdResult(code, decoded("stdout"), decoded("stderr"), False, truncated["stdout"], truncated["stderr"], bytes(captured["stdout"][:capture_bytes]))


def git_root(start: Path) -> Path | None:
    result = git_cmd(start, "rev-parse", "--show-toplevel", capture_bytes=8192)
    return Path(result.stdout) if result.code == 0 and result.stdout else None


def git_cmd(root: Path, *args: str, capture_bytes: int = 65536) -> CmdResult:
    return run(
        [
            "git",
            "--no-pager",
            "-c",
            "core.pager=cat",
            "-c",
            "pager.status=false",
            "-c",
            "pager.diff=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            *args,
        ],
        root,
        capture_bytes,
    )


def limit_output(text: str, line_limit: int, byte_limit: int) -> list[ProbeLine]:
    truncated_bytes = False
    if byte_limit > 0:
        raw = text.encode("utf-8", "replace")
        if len(raw) > byte_limit:
            text = raw[:byte_limit].decode("utf-8", "ignore")
            truncated_bytes = True

    lines = [ProbeLine(line.rstrip()) for line in text.splitlines() if line.rstrip()]
    omitted_lines = 0
    if line_limit > 0 and len(lines) > line_limit:
        omitted_lines = len(lines) - line_limit
        lines = lines[:line_limit]

    if omitted_lines:
        lines.append(ProbeLine(f"{omitted_lines} more lines omitted", synthetic=True))
    if truncated_bytes:
        lines.append(ProbeLine(f"output truncated at {byte_limit} bytes", synthetic=True))
    return lines


def is_sensitive_path(value: str) -> bool:
    normalized = value.replace("\\", "/")
    lower = normalized.lower()
    return any(hint in lower for hint in SENSITIVE_HINTS) or any(p.search(normalized) for p in SENSITIVE_PATTERNS)


def redacted_path_label(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:12]
    return f"[SENSITIVE-PATH:{digest}]"


def code_span(value: str) -> str:
    return sanitize_display(value, 1000)


def display_path_like(value: str) -> tuple[str, bool]:
    if is_sensitive_path(value):
        return redacted_path_label(value), True
    return sanitize_display(value, 1000), False


def print_block(title: str, lines: Iterable[str | ProbeLine], empty: str = "none") -> None:
    print(f"### {title}")
    material = list(lines)
    if not material:
        print(f"- {empty}")
        return
    for item in material:
        line = item.value if isinstance(item, ProbeLine) else item
        if isinstance(item, ProbeLine) and item.synthetic:
            print(f"- [probe note: {sanitize_display(line)}]")
            continue
        shown, redacted = display_path_like(line)
        suffix = " [sensitive-looking path redacted; contents not inspected]" if redacted else ""
        print(f"- `{shown}`{suffix}")


def git_lines(root: Path, args: tuple[str, ...], line_limit: int, byte_limit: int) -> list[ProbeLine]:
    result = git_cmd(root, *args, capture_bytes=max(1024, byte_limit if byte_limit > 0 else 65536))
    if result.code != 0:
        return [ProbeLine(f"git {' '.join(args)} failed (exit {result.code}); output omitted", synthetic=True)]
    lines = limit_output(result.stdout, line_limit, byte_limit)
    if result.stdout_truncated:
        lines.append(ProbeLine("git output exceeded the execution capture cap", synthetic=True))
    return lines


INDEX_ENTRY_RE = re.compile(
    rb"(?P<mode>[0-7]+) [0-9a-f]+ (?P<stage>[0-3])\t(?P<path>[^\0]+)\0"
    rb"  ctime: (?P<ctime_s>\d+):(?P<ctime_ns>\d+)\n"
    rb"  mtime: (?P<mtime_s>\d+):(?P<mtime_ns>\d+)\n"
    rb"  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n"
    rb"  size: (?P<size>\d+)\tflags: [0-9a-f]+\n"
)


def worktree_metadata(root: Path) -> tuple[list[ProbeLine], list[str], bool]:
    """Compare index stat metadata only; never ask Git to hash worktree files.

    Even `ls-files --modified` may enter content comparison on some paths.
    The debug format is intentionally parsed strictly: an unfamiliar/truncated
    record makes the probe incomplete, not falsely clean.
    """
    index = git_cmd(root, "ls-files", "--stage", "--debug", "-z", capture_bytes=1024 * 1024)
    untracked = git_cmd(root, "ls-files", "--others", "--exclude-standard", "-z", capture_bytes=1024 * 1024)
    lines: list[ProbeLine] = []
    recent: list[tuple[int, str]] = []
    incomplete = index.code != 0 or untracked.code != 0 or index.stdout_truncated or untracked.stdout_truncated
    if index.code == 0:
        offset = 0
        while offset < len(index.stdout_bytes):
            match = INDEX_ENTRY_RE.match(index.stdout_bytes, offset)
            if match is None:
                incomplete = True
                break
            offset = match.end()
            raw_path = match.group("path")
            rel = Path(os.fsdecode(raw_path))
            label = raw_path.decode("utf-8", "replace")
            if rel.is_absolute() or ".." in rel.parts:
                incomplete = True
                continue
            if match.group("stage") != b"0":
                lines.append(ProbeLine(f"unmerged index entry: {label}"))
                continue
            if match.group("mode") == b"160000":
                lines.append(ProbeLine(f"submodule content not inspected: {label}"))
                incomplete = True
                continue
            try:
                # A tracked parent replaced by a symlink must not redirect even
                # this metadata-only inspection outside the physical repo.
                with open_directory_handle(root, root / rel.parent) as handle:
                    info = os.stat(rel.name, dir_fd=handle.fd, follow_symlinks=False)
                    handle.verify()
                recent.append((info.st_mtime_ns, label))
                expected = (
                    int(match.group("ctime_s")) * 1_000_000_000 + int(match.group("ctime_ns")),
                    int(match.group("mtime_s")) * 1_000_000_000 + int(match.group("mtime_ns")),
                    int(match.group("size")),
                )
                actual = (info.st_ctime_ns, info.st_mtime_ns, info.st_size)
                expected_kind = stat.S_IFLNK if match.group("mode") == b"120000" else stat.S_IFREG
                if actual != expected or stat.S_IFMT(info.st_mode) != expected_kind:
                    lines.append(ProbeLine(f"stat differs (not content-verified): {label}"))
            except FileNotFoundError:
                lines.append(ProbeLine(f"missing working entry: {label}"))
            except (OSError, SnapshotError):
                lines.append(ProbeLine(f"working entry unavailable or unsafe: {label}"))
                incomplete = True
    if untracked.code == 0:
        raw = untracked.stdout_bytes
        if raw and not raw.endswith(b"\0"):
            incomplete = True
            raw = raw[: raw.rfind(b"\0") + 1]
        for item in raw.split(b"\0"):
            if item:
                label = item.decode("utf-8", "replace")
                lines.append(ProbeLine(f"untracked: {label}"))
    if incomplete:
        lines.append(ProbeLine("worktree metadata incomplete (command, format, path, or capture limit); state unknown", synthetic=True))
    return lines, [label for _, label in sorted(recent, reverse=True)], incomplete


def fs_recent_files(root: Path, limit: int, max_files: int, max_depth: int) -> tuple[list[str], bool]:
    rows: list[tuple[float, str]] = []
    seen = 0
    truncated = False
    root_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        base = Path(dirpath)
        depth = len(base.parts) - root_depth
        if max_depth >= 0 and depth >= max_depth:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            seen += 1
            if max_files > 0 and seen > max_files:
                truncated = True
                return [rel for _, rel in sorted(rows, reverse=True)[:limit]], truncated
            path = base / name
            try:
                rel = path.relative_to(root).as_posix()
                rows.append((path.lstat().st_mtime, rel))
            except OSError:
                continue
    rows.sort(reverse=True)
    return [rel for _, rel in rows[:limit]], truncated


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit compact Markdown repo state for handoff snapshots.")
    parser.add_argument("--root", default=".", help="Repo root or working directory to inspect")
    parser.add_argument("--limit", type=int, default=80, help="Maximum lines per git output block; <=0 disables line limiting")
    parser.add_argument("--max-bytes", type=int, default=32768, help="Maximum UTF-8 bytes per git output block; <=0 disables byte limiting")
    parser.add_argument("--recent-limit", type=int, default=20, help="Maximum recent files to list")
    parser.add_argument("--max-files", type=int, default=5000, help="Maximum files to scan in non-git fallback; <=0 disables cap")
    parser.add_argument("--max-depth", type=int, default=6, help="Maximum directory depth for non-git fallback; <0 disables cap")
    args = parser.parse_args()

    start = Path(args.root).expanduser().resolve()
    found_root = git_root(start)
    root = found_root or start
    is_git = found_root is not None
    version = load_version()

    print("## Repo State Probe")
    print(f"- Schema Version: {SCHEMA_VERSION}")
    print(f"- Probe script version: {version}")
    print(f"- Generated at: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
    print(f"- Root: `{redact_label('REPO-ROOT', str(root))}`")
    print(f"- Git repo: {'yes' if is_git else 'no'}")

    if is_git:
        branch_result = git_cmd(root, "branch", "--show-current", capture_bytes=4096)
        commit_result = git_cmd(root, "rev-parse", "--short", "HEAD", capture_bytes=1024)
        metadata_lines, recent, _ = worktree_metadata(root)
        super_result = git_cmd(root, "rev-parse", "--show-superproject-working-tree", capture_bytes=8192)
        branch = branch_result.stdout if branch_result.code == 0 and branch_result.stdout else "Unknown"
        commit = commit_result.stdout if commit_result.code == 0 and commit_result.stdout else "Unknown"
        if is_sensitive_path(branch):
            branch_display = redact_label("SENSITIVE-BRANCH", branch)
        else:
            branch_display = sanitize_display(branch, 160)
        print(f"- Branch: `{branch_display}`")
        print(f"- Commit: `{code_span(commit)}`")
        print("- Git dirty: unknown (metadata-only probe; worktree contents are not compared)")
        if super_result.code == 0 and super_result.stdout:
            print(f"- Git submodule: yes; superproject root: `{redact_label('SUPERPROJECT-ROOT', super_result.stdout)}`")
        else:
            print("- Git submodule: no/unknown")
        print()
        # Limit after metadata collection without converting synthetic notes
        # into path data. The execution-time index/untracked caps still apply.
        visible: list[ProbeLine] = []
        shown_bytes = 0
        for line in metadata_lines:
            line_bytes = len(line.value.encode("utf-8", "replace"))
            if (args.limit > 0 and len(visible) >= args.limit) or (args.max_bytes > 0 and shown_bytes + line_bytes > args.max_bytes):
                break
            visible.append(line)
            shown_bytes += line_bytes
        if len(visible) < len(metadata_lines):
            visible = [*visible, ProbeLine("additional metadata hints omitted", synthetic=True)]
        print_block("Worktree Metadata Hints", visible, empty="no stat differences observed; content state remains unknown")
        print()
        print_block("Diff Stat", [ProbeLine("line-count stats omitted: worktree hashing can execute clean/process filters", synthetic=True)])
        print()
        print_block("Staged Changed Files", git_lines(root, ("diff", "--cached", "--no-renames", "--ignore-submodules=all", "--no-ext-diff", "--no-textconv", "--name-status"), args.limit, args.max_bytes))
        print()
        print_block("Recent Indexed Files (metadata only, may be unchanged)", recent[:max(0, args.recent_limit)])
    else:
        print("- Branch: `Unknown`")
        print("- Commit: `Unknown`")
        print("- Git dirty: `unknown`")
        print(f"- Non-git scan caps: max files={args.max_files}, max depth={args.max_depth}")
        print()
        recent, truncated = fs_recent_files(root, args.recent_limit, args.max_files, args.max_depth)
        print_block("Recent Files", recent, empty="no files found")
        if truncated:
            print(f"- ... (non-git scan stopped after {args.max_files} files)")
        print()
        print("### Non-Git Notes")
        print("- Filesystem metadata only; no git status/diff is available.")
        print("- Large/private non-git trees are scanned only up to the configured caps.")

    print()
    print("### Safety Notes")
    print("- Raw file contents and raw diff hunks were not inspected or emitted.")
    print("- Sensitive-looking paths are redacted and values are not read or printed.")
    print("- If a raw diff is required later, redact it before adding it to a handoff snapshot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
