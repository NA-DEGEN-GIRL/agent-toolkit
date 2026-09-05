#!/usr/bin/env python3
"""Shared, fail-closed primitives for handoff snapshot scripts.

This module intentionally uses bounded reads and lexical lane checks.  Callers
must never read a snapshot first and validate it afterwards.
"""
from __future__ import annotations

import sys

# Helper invocation must not mutate the installed/source package via imports.
sys.dont_write_bytecode = True

import hashlib
import os
import re
import stat
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

MAX_DEFAULT_BYTES = 1024 * 1024
REQUIRED_HEADING = "# Handoff Snapshot"
SCOPES_DIRNAME = "scopes"
SCOPE_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
RESERVED_SCOPES = {"default", "latest", "scopes"}
METADATA_RE = re.compile(r"^-\s*([^:]+):\s*(.*)$")
BACKUP_RE = re.compile(
    r"^(?P<stamp>\d{4}-\d{2}-\d{2}-\d{6})-(?P<agent>[a-z0-9][a-z0-9-]{0,31})\.md$"
)

_TOKEN_PATTERNS = (
    re.compile(r"(?i)\b(?:bearer\s+)[A-Za-z0-9._~+/-]{8,}"),
    re.compile(r"(?i)\b(?:basic\s+)[A-Za-z0-9+/=]{8,}"),
    re.compile(r"\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b", re.IGNORECASE),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{8,}\b"),
    re.compile(r"\bya29\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+"
    ),
    re.compile(r"(?i)https?://[^\s/@:]+:[^\s/@]+@"),
)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_URL_RE = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s<>()`]+")
_HOME_RE = re.compile(r"(?<![A-Za-z0-9])/(?:home|Users)/[^/\s]+")
_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_SENSITIVE_PATH_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:[~./A-Za-z0-9_-]+/)*(?:\.env(?:\.[A-Za-z0-9_-]+)?|\.ssh|id_(?:rsa|dsa|ed25519)|credentials?(?:\.[A-Za-z0-9_-]+)?|secrets?(?:\.[A-Za-z0-9_-]+)?|kubeconfig|auth\.json)(?![A-Za-z0-9])"
)


class SnapshotError(ValueError):
    """A snapshot or lane failed a safety/format check."""


def require_dirfd_support(*functions: object, list_fd: bool = False) -> None:
    if not all(function in os.supports_dir_fd for function in functions):
        raise SnapshotError("required secure dir_fd operations are unavailable; refusing operation")
    if list_fd and os.listdir not in os.supports_fd:
        raise SnapshotError("secure fd-based directory listing is unavailable; refusing operation")


@dataclass(frozen=True)
class Snapshot:
    path: Path | None
    data: bytes
    text: str
    metadata: dict[str, str]

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass(frozen=True)
class Lane:
    scope: str | None
    directory: Path
    root: Path | None = None

    @property
    def label(self) -> str:
        return self.scope or "(default)"


class DirectoryHandle(AbstractContextManager["DirectoryHandle"]):
    """Stable openat-style directory chain anchored at a trusted root fd."""

    def __init__(
        self,
        root: Path,
        directory: Path,
        fds: list[int],
        edges: list[tuple[int, str, int, tuple[int, int]]],
        root_identity: tuple[int, int],
    ) -> None:
        self.root = root
        self.directory = directory
        self.fds = fds
        self.edges = edges
        self.root_identity = root_identity

    @property
    def fd(self) -> int:
        return self.fds[-1]

    def verify(self) -> None:
        try:
            root_info = self.root.lstat()
        except OSError as exc:
            raise SnapshotError(f"root path changed during operation: {exc}") from exc
        if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
            raise SnapshotError("root path became unsafe during operation")
        if (root_info.st_dev, root_info.st_ino) != self.root_identity:
            raise SnapshotError("root path identity changed during operation")
        for parent_fd, name, child_fd, identity in self.edges:
            try:
                named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                opened = os.fstat(child_fd)
            except OSError as exc:
                raise SnapshotError(f"directory chain changed at {name}: {exc}") from exc
            if stat.S_ISLNK(named.st_mode) or not stat.S_ISDIR(named.st_mode):
                raise SnapshotError(f"directory chain became unsafe at {name}")
            if (named.st_dev, named.st_ino) != identity or (opened.st_dev, opened.st_ino) != identity:
                raise SnapshotError(f"directory chain identity changed at {name}")

    def close(self) -> None:
        while self.fds:
            try:
                os.close(self.fds.pop())
            except OSError:
                pass

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


def open_directory_handle(root: Path, directory: Path, create: bool = False) -> DirectoryHandle:
    """Open a stable no-follow fd chain from root to directory."""
    require_dirfd_support(os.open, os.stat, os.mkdir)
    root = absolute_lexical(root)
    directory = absolute_lexical(directory)
    if not is_relative_to(directory, root):
        raise SnapshotError(f"directory is outside root: {directory}")
    assert_no_symlink_components(root)
    try:
        root_before = root.lstat()
    except OSError as exc:
        raise SnapshotError(f"root is unavailable: {exc}") from exc
    if stat.S_ISLNK(root_before.st_mode) or not stat.S_ISDIR(root_before.st_mode):
        raise SnapshotError("root must be a real directory")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        root_fd = os.open(root, flags)
    except OSError as exc:
        raise SnapshotError(f"cannot safely open root: {exc}") from exc
    fds = [root_fd]
    edges: list[tuple[int, str, int, tuple[int, int]]] = []
    root_opened = os.fstat(root_fd)
    root_identity = (root_opened.st_dev, root_opened.st_ino)
    if root_identity != (root_before.st_dev, root_before.st_ino):
        os.close(root_fd)
        raise SnapshotError("root changed during safe open")
    try:
        current_fd = root_fd
        for component in directory.relative_to(root).parts:
            if component in {"", ".", ".."}:
                raise SnapshotError("unsafe directory component")
            try:
                child_fd = os.open(component, flags, dir_fd=current_fd)
            except FileNotFoundError:
                if not create:
                    raise SnapshotError(f"directory not found: {component}")
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current_fd)
                except FileExistsError:
                    pass
                child_fd = os.open(component, flags, dir_fd=current_fd)
            child = os.fstat(child_fd)
            named = os.stat(component, dir_fd=current_fd, follow_symlinks=False)
            if stat.S_ISLNK(named.st_mode) or not stat.S_ISDIR(named.st_mode):
                os.close(child_fd)
                raise SnapshotError(f"real directory required: {component}")
            identity = (child.st_dev, child.st_ino)
            if identity != (named.st_dev, named.st_ino):
                os.close(child_fd)
                raise SnapshotError(f"directory changed during safe open: {component}")
            edges.append((current_fd, component, child_fd, identity))
            fds.append(child_fd)
            current_fd = child_fd
        handle = DirectoryHandle(root, directory, fds, edges, root_identity)
        handle.verify()
        return handle
    except SnapshotError:
        for fd in reversed(fds):
            try:
                os.close(fd)
            except OSError:
                pass
        raise
    except (OSError, NotImplementedError, TypeError) as exc:
        for fd in reversed(fds):
            try:
                os.close(fd)
            except OSError:
                pass
        raise SnapshotError(f"secure directory traversal failed: {exc}") from exc


def absolute_lexical(path: Path) -> Path:
    """Return an absolute path without resolving symlinks."""
    return Path(os.path.abspath(os.fspath(path)))


def is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def valid_scope(scope: str) -> bool:
    return bool(SCOPE_RE.fullmatch(scope)) and scope not in RESERVED_SCOPES


def valid_agent(agent: str) -> bool:
    return bool(AGENT_RE.fullmatch(agent))


def parse_backup_name(name: str) -> tuple[str, str] | None:
    match = BACKUP_RE.fullmatch(name)
    if not match:
        return None
    stamp = match.group("stamp")
    try:
        datetime.strptime(stamp, "%Y-%m-%d-%H%M%S")
    except ValueError:
        return None
    return stamp, match.group("agent")


def sanitize_display(value: str, max_chars: int = 160) -> str:
    """Make untrusted metadata safe for one-line terminal/Markdown output."""
    clean = _CONTROL_RE.sub(" ", value)
    clean = " ".join(clean.split())
    clean = _HOME_RE.sub("~", clean)

    # Lane summaries never need clickable URLs.  Redact all schemes instead
    # of guessing whether a host/path/query is private.
    clean = _URL_RE.sub("[REDACTED-URL]", clean)
    for pattern in _TOKEN_PATTERNS:
        clean = pattern.sub("[REDACTED]", clean)
    clean = _SENSITIVE_PATH_RE.sub("[SENSITIVE-PATH]", clean)
    clean = _EMAIL_RE.sub("[REDACTED-EMAIL]", clean)
    clean = clean.replace("![", "!［").replace("](", "］(").replace("<", "‹").replace(">", "›")
    clean = clean.replace("`", "ˋ")
    if max_chars > 0 and len(clean) > max_chars:
        clean = clean[: max_chars - 1] + "…"
    return clean or "Unknown"


def redact_snapshot_content(text: str) -> str:
    """Redact a validated snapshot for reading, preserving its line structure.

    This is a best-effort disclosure guard, not authority or a promise to
    recognize arbitrary credentials. Snapshots must already exclude secrets.
    """
    clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", text)
    clean = _HOME_RE.sub("~", clean)
    clean = _URL_RE.sub("[REDACTED-URL]", clean)
    for pattern in _TOKEN_PATTERNS:
        clean = pattern.sub("[REDACTED]", clean)
    clean = _SENSITIVE_PATH_RE.sub("[SENSITIVE-PATH]", clean)
    clean = _EMAIL_RE.sub("[REDACTED-EMAIL]", clean)
    return clean.replace("![", "!［").replace("](", "］(").replace("<", "‹").replace(">", "›")


def redact_label(kind: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:12]
    return f"[{kind}:{digest}]"


def path_display(path: Path, root: Path) -> str:
    path = absolute_lexical(path)
    root = absolute_lexical(root)
    if not is_relative_to(path, root):
        return "[OUTSIDE-ROOT]"
    return sanitize_display(path.relative_to(root).as_posix(), 240)


def assert_no_symlink_components(path: Path) -> None:
    """Reject a symlink or non-directory in every existing parent component."""
    absolute = absolute_lexical(path)
    parts = absolute.parts
    current = Path(parts[0])
    for part in parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode):
            raise SnapshotError(f"symlinked path component refused: {current}")
        if current != absolute and not stat.S_ISDIR(info.st_mode):
            raise SnapshotError(f"non-directory path component refused: {current}")


def ensure_real_directory(path: Path, create: bool = False) -> Path:
    """Return a lexical absolute real directory, optionally creating it safely."""
    absolute = absolute_lexical(path)
    assert_no_symlink_components(absolute)
    if create:
        # Create one component at a time and re-check each result.  The final
        # file opens also use O_NOFOLLOW where the platform provides it.
        missing: list[Path] = []
        cursor = absolute
        while not cursor.exists():
            missing.append(cursor)
            cursor = cursor.parent
        assert_no_symlink_components(cursor)
        if not cursor.is_dir():
            raise SnapshotError(f"directory parent is not a directory: {cursor}")
        for item in reversed(missing):
            try:
                item.mkdir(mode=0o700)
            except FileExistsError:
                pass
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise SnapshotError(f"real directory required: {item}")
    try:
        info = absolute.lstat()
    except FileNotFoundError as exc:
        raise SnapshotError(f"directory not found: {absolute}") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SnapshotError(f"real directory required: {absolute}")
    return absolute


def handoff_location(root_arg: Path, dir_arg: Path) -> tuple[Path, Path]:
    root = ensure_real_directory(root_arg, create=False)
    raw = absolute_lexical(dir_arg if dir_arg.is_absolute() else root / dir_arg)
    if raw.name != ".handoff":
        raise SnapshotError(f"handoff directory must be named .handoff: {raw}")
    if not is_relative_to(raw, root):
        raise SnapshotError(f"handoff directory is outside root: {raw}")
    return root, raw


def resolve_handoff(root_arg: Path, dir_arg: Path, create: bool = False) -> tuple[Path, Path]:
    root, raw = handoff_location(root_arg, dir_arg)
    handoff = ensure_real_directory(raw, create=create)
    return root, handoff


def lane_for(handoff: Path, scope: str | None, create: bool = False) -> Lane:
    handoff = ensure_real_directory(handoff, create=False)
    if scope is None:
        return Lane(None, handoff)
    if not valid_scope(scope):
        raise SnapshotError(
            f"invalid scope '{scope}': use lowercase letters, digits, and hyphens; "
            f"reserved names: {sorted(RESERVED_SCOPES)}"
        )
    lane = handoff / SCOPES_DIRNAME / scope
    return Lane(scope, ensure_real_directory(lane, create=create))


def _open_regular_nofollow(path: Path) -> int:
    try:
        before = path.lstat()
    except FileNotFoundError as exc:
        raise SnapshotError("snapshot file not found") from exc
    if stat.S_ISLNK(before.st_mode):
        raise SnapshotError("symlinked snapshot refused")
    if not stat.S_ISREG(before.st_mode):
        raise SnapshotError("snapshot is not a regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise SnapshotError(f"snapshot is unreadable: {exc}") from exc
    after = os.fstat(fd)
    if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        os.close(fd)
        raise SnapshotError("snapshot changed during safe open")
    return fd


def _open_regular_at(handle: DirectoryHandle, name: str) -> int:
    if Path(name).name != name or name in {"", ".", ".."}:
        raise SnapshotError("snapshot filename must be one safe path component")
    handle.verify()
    try:
        before = os.stat(name, dir_fd=handle.fd, follow_symlinks=False)
    except FileNotFoundError as exc:
        raise SnapshotError("snapshot file not found") from exc
    if stat.S_ISLNK(before.st_mode):
        raise SnapshotError("symlinked snapshot refused")
    if not stat.S_ISREG(before.st_mode):
        raise SnapshotError("snapshot is not a regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, dir_fd=handle.fd)
    except OSError as exc:
        raise SnapshotError(f"snapshot is unreadable: {exc}") from exc
    after = os.fstat(fd)
    if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        os.close(fd)
        raise SnapshotError("snapshot changed during safe open")
    return fd


def read_regular_bounded_at(handle: DirectoryHandle, name: str, max_bytes: int) -> bytes:
    if max_bytes < 1:
        raise SnapshotError("max bytes must be >= 1")
    fd = _open_regular_at(handle, name)
    try:
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
    finally:
        os.close(fd)
    handle.verify()
    if len(data) > max_bytes:
        raise SnapshotError(f"snapshot exceeds max bytes (> {max_bytes})")
    return data


def read_regular_bounded(path: Path, max_bytes: int) -> bytes:
    """Read at most max+1 bytes from a real regular file."""
    if max_bytes < 1:
        raise SnapshotError("max bytes must be >= 1")
    path = absolute_lexical(path)
    assert_no_symlink_components(path.parent)
    fd = _open_regular_nofollow(path)
    try:
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
    finally:
        os.close(fd)
    if len(data) > max_bytes:
        raise SnapshotError(f"snapshot exceeds max bytes (> {max_bytes})")
    return data


def read_stream_bounded(stream: object, max_bytes: int) -> bytes:
    if max_bytes < 1:
        raise SnapshotError("max bytes must be >= 1")
    data = stream.read(max_bytes + 1)  # type: ignore[attr-defined]
    if len(data) > max_bytes:
        raise SnapshotError(f"snapshot exceeds max bytes (> {max_bytes})")
    return data


def parse_metadata(text: str) -> tuple[dict[str, str], list[str]]:
    metadata: dict[str, str] = {}
    duplicates: list[str] = []
    in_metadata = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "## Metadata":
            in_metadata = True
            continue
        if in_metadata and stripped.startswith("## "):
            break
        if in_metadata:
            match = METADATA_RE.fullmatch(stripped)
            if match:
                key = match.group(1).strip()
                value = match.group(2).strip() or "Unknown"
                if key in metadata:
                    duplicates.append(key)
                else:
                    metadata[key] = value
    return metadata, duplicates


def validate_snapshot_bytes(
    data: bytes,
    *,
    max_bytes: int,
    expected_scope: str | None,
    expected_agent: str | None = None,
    path: Path | None = None,
) -> Snapshot:
    if max_bytes < 1:
        raise SnapshotError("max bytes must be >= 1")
    if len(data) > max_bytes:
        raise SnapshotError(f"snapshot exceeds max bytes (> {max_bytes})")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SnapshotError("snapshot is not valid UTF-8") from exc
    if "\x00" in text:
        raise SnapshotError("snapshot contains NUL bytes")
    first_nonempty = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if first_nonempty != REQUIRED_HEADING:
        raise SnapshotError(f"first heading is not `{REQUIRED_HEADING}`")
    metadata, duplicates = parse_metadata(text)
    if duplicates:
        raise SnapshotError(f"duplicate metadata fields refused: {', '.join(sorted(set(duplicates)))}")
    scope_field = metadata.get("Scope")
    if expected_scope is None:
        if scope_field is not None:
            raise SnapshotError("default-lane snapshot must omit Scope metadata")
    elif scope_field != expected_scope:
        raise SnapshotError(
            f"Scope metadata/path mismatch: expected '{expected_scope}', got '{scope_field or 'missing'}'"
        )
    if expected_agent is not None and metadata.get("Agent") != expected_agent:
        raise SnapshotError(
            f"Agent metadata mismatch: expected '{expected_agent}', got '{metadata.get('Agent', 'missing')}'"
        )
    return Snapshot(path, data, text, metadata)


def validate_snapshot_path(
    path: Path,
    lane: Lane,
    max_bytes: int = MAX_DEFAULT_BYTES,
    expected_agent: str | None = None,
) -> Snapshot:
    path = absolute_lexical(path)
    lane_dir = absolute_lexical(lane.directory)
    if path.parent != lane_dir:
        raise SnapshotError(f"snapshot path is outside selected lane: {path}")
    if path.name != "latest.md" and parse_backup_name(path.name) is None:
        raise SnapshotError(f"snapshot filename is not latest.md or a valid dated backup: {path.name}")
    root = absolute_lexical(lane.root or _infer_lane_root(lane))
    with open_directory_handle(root, lane_dir) as handle:
        return validate_snapshot_at(path.name, lane, handle, max_bytes, expected_agent, path)


def validate_snapshot_at(
    name: str,
    lane: Lane,
    handle: DirectoryHandle,
    max_bytes: int = MAX_DEFAULT_BYTES,
    expected_agent: str | None = None,
    display_path: Path | None = None,
) -> Snapshot:
    if name != "latest.md" and parse_backup_name(name) is None:
        raise SnapshotError(f"snapshot filename is not latest.md or a valid dated backup: {name}")
    data = read_regular_bounded_at(handle, name, max_bytes)
    return validate_snapshot_bytes(
        data,
        max_bytes=max_bytes,
        expected_scope=lane.scope,
        expected_agent=expected_agent,
        path=display_path or lane.directory / name,
    )


def _infer_lane_root(lane: Lane) -> Path:
    cursor = absolute_lexical(lane.directory)
    while cursor != cursor.parent:
        if cursor.name == ".handoff":
            return cursor.parent
        cursor = cursor.parent
    raise SnapshotError("cannot infer repo root from lane path")


def first_section_line(text: str, heading: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != heading:
            continue
        for following in lines[index + 1 :]:
            token = following.strip()
            if token.startswith("## "):
                return ""
            if token:
                return token.lstrip("- ").strip()
    return ""


def backup_paths(lane: Lane, agent: str | None = None) -> list[Path]:
    if agent is not None and not valid_agent(agent):
        raise SnapshotError(f"invalid agent: {agent}")
    try:
        entries = list(lane.directory.iterdir())
    except FileNotFoundError:
        return []
    paths: list[Path] = []
    for entry in entries:
        parsed = parse_backup_name(entry.name)
        if parsed is None or (agent is not None and parsed[1] != agent):
            continue
        paths.append(entry)
    return sorted(paths, key=lambda item: item.name, reverse=True)


def lane_has_candidates(lane: Lane) -> bool:
    latest = lane.directory / "latest.md"
    try:
        latest.lstat()
        return True
    except OSError:
        pass
    try:
        return any(parse_backup_name(entry.name) is not None for entry in lane.directory.iterdir())
    except OSError:
        return False


def discover_lanes(handoff: Path, root: Path | None = None) -> tuple[list[Lane], list[str]]:
    """Discover default and scoped lanes, including backup-only lanes."""
    handoff = absolute_lexical(handoff)
    root = absolute_lexical(root or handoff.parent)
    lanes: list[Lane] = []
    warnings: list[str] = []
    require_dirfd_support(os.open, os.stat, os.mkdir, list_fd=True)
    with open_directory_handle(root, handoff) as handoff_handle:
        try:
            handoff_names = os.listdir(handoff_handle.fd)
        except OSError as exc:
            raise SnapshotError(f"cannot list handoff directory: {exc}") from exc
        if "latest.md" in handoff_names or any(parse_backup_name(name) is not None for name in handoff_names):
            lanes.append(Lane(None, handoff, root))
        if SCOPES_DIRNAME not in handoff_names:
            return lanes, warnings
        try:
            scopes_info = os.stat(SCOPES_DIRNAME, dir_fd=handoff_handle.fd, follow_symlinks=False)
        except OSError as exc:
            raise SnapshotError(f"cannot inspect scopes directory: {exc}") from exc
        if stat.S_ISLNK(scopes_info.st_mode) or not stat.S_ISDIR(scopes_info.st_mode):
            warnings.append("unsafe scopes path refused")
            return lanes, warnings
        scopes = handoff / SCOPES_DIRNAME
        with open_directory_handle(root, scopes) as scopes_handle:
            try:
                scope_names = sorted(os.listdir(scopes_handle.fd))
            except OSError as exc:
                raise SnapshotError(f"cannot list scopes directory: {exc}") from exc
            for name in scope_names:
                if not valid_scope(name):
                    continue
                try:
                    entry_info = os.stat(name, dir_fd=scopes_handle.fd, follow_symlinks=False)
                except OSError as exc:
                    warnings.append(f"unreadable scoped lane refused: {sanitize_display(name)} ({sanitize_display(str(exc))})")
                    continue
                if stat.S_ISLNK(entry_info.st_mode) or not stat.S_ISDIR(entry_info.st_mode):
                    warnings.append(f"unsafe scoped lane refused: {sanitize_display(name)}")
                    continue
                lane_path = scopes / name
                try:
                    with open_directory_handle(root, lane_path) as lane_handle:
                        lane_names = os.listdir(lane_handle.fd)
                except (OSError, SnapshotError) as exc:
                    warnings.append(f"unreadable scoped lane refused: {sanitize_display(name)} ({sanitize_display(str(exc))})")
                    continue
                if "latest.md" in lane_names or any(parse_backup_name(item) is not None for item in lane_names):
                    lanes.append(Lane(name, lane_path, root))
    return lanes, warnings


def select_valid_snapshot(lane: Lane, max_bytes: int = MAX_DEFAULT_BYTES) -> tuple[Snapshot | None, list[str]]:
    """Select valid latest first, then newest valid same-lane dated backup."""
    errors: list[str] = []
    root = absolute_lexical(lane.root or _infer_lane_root(lane))
    try:
        require_dirfd_support(os.open, os.stat, os.mkdir, list_fd=True)
        with open_directory_handle(root, lane.directory) as handle:
            names = os.listdir(handle.fd)
            backups = sorted((name for name in names if parse_backup_name(name) is not None), reverse=True)
            candidates = ["latest.md", *backups]
            for name in candidates:
                try:
                    return validate_snapshot_at(name, lane, handle, max_bytes), errors
                except SnapshotError as exc:
                    errors.append(f"{name}: {sanitize_display(str(exc), 240)}")
    except (OSError, SnapshotError) as exc:
        errors.append(sanitize_display(str(exc), 240))
    return None, errors
