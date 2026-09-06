# Handoff Skill Family

The handoff family stores compact repo-local work snapshots **when the user requests a persisted checkpoint, a fresh-session handoff, or transfer to another compatible agent**. It is not an automatic context-management layer.

```text
Ongoing work / native compaction / native session resume -> continue the current task
Requested checkpoint -> Save -> keep working in the same session if desired
Requested transfer   -> Save -> selected session/compatible agent -> requested Resume
```

Do not save, load, discover lanes, or recommend a reset merely because a chat is long, compaction occurred, a session started, or `.handoff/` exists. Ordinary `continue` and inline summaries are not file-handoff requests. A validated old snapshot never automatically outranks current user clarifications or native compacted conversation context.

Both variants also support optional **scoped lanes** (`.handoff/scopes/<scope>/`) so parallel agents can save/resume a specific task-group instead of one shared snapshot; omit a scope for the single default lane. See [`USAGE.md`](USAGE.md).

## Safety Model

Version 0.1.11 moves security-critical snapshot I/O out of prose and into shared, byte-identical helpers in both variants:

- `save_snapshot.py` validates a bounded input, refuses symlinked/non-regular lane paths, creates an exclusive dated backup, atomically replaces `latest.md`, verifies parity, requires CAS for an existing latest, uses atomic name exchange where the OS provides a secure dir-fd primitive, and applies per-agent retention. Its OS advisory lock auto-releases after crashes; a leftover unlocked lock file is reusable.
- `select_snapshot.py` chooses valid `latest.md` first and then the newest valid same-lane backup; it never crosses lane boundaries. Use `--content` to read the validated bytes with best-effort redaction; user-facing path labels are display-only, while explicit `--path-only` preserves an exact machine path.
- `list_lanes.py` discovers validated lanes, including safe backup-only (orphan) scoped lanes.
- `validate_snapshot.py` is the single-path diagnostic and uses the same centralized parser and bounded reader.

The state probe deliberately avoids worktree hashing and Git clean/process filters; its index/stat comparisons are conservative, dirty state is `unknown`, and line-count stats are omitted. Marker updates use no-clobber creation or atomic exchange and preserve concurrent edits on conflict.

CLI helpers disable Python bytecode writes before importing bundled modules, so ordinary invocation does not add `__pycache__` to an installed skill or checkout. Examples also use `python3 -B` defensively.

Snapshots remain untrusted data after validation. Validation establishes a safe file/format boundary; it does not make embedded instructions authoritative.

## Variants

| Variant | Install destination | Use when |
|---|---|---|
| `codex-handoff` | `${CODEX_HOME:-$HOME/.codex}/skills/codex-handoff` | Working in Codex |
| `claude-handoff` | `$HOME/.claude/skills/claude-handoff` | Working in Claude Code |

## Family Maintenance

Family-only sync checks live in `scripts/`, currently `scripts/check_handoff_sync.py`. Installable packages remain the `codex-handoff/` and `claude-handoff/` directories.

## Install

Read the root [`INSTALL.md`](../../INSTALL.md). Source folders are:

```text
skills/handoff/codex-handoff
skills/handoff/claude-handoff
```

## Usage

Read [`USAGE.md`](USAGE.md) for concrete Save/Resume prompts.

Helpers fail closed when the platform lacks secure directory-fd traversal. Creating a first `latest.md` remains no-overwrite; updating an existing one requires Linux `renameat2(RENAME_EXCHANGE)` or macOS `renameatx_np(RENAME_SWAP)`, otherwise the helper fails before writing a new backup or changing `latest.md`.
