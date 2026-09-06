# Handoff Skill Usage Examples

This guide shows how to use the installed `codex-handoff` or `claude-handoff` skills in real sessions.

Prerequisite: install the matching skill from this repo, then restart/open a fresh agent session so skill metadata is loaded. During trial, name the skill explicitly because a default `handoff` skill may also exist.

## Mental Model

Default: **keep ongoing work in its native conversation**. Let the runtime manage compaction and use native session resume when reopening the same conversation. File handoffs are optional artifacts, not required companions to compaction.

- **Save Mode**: requested persisted checkpoint or file-based transfer. The canonical helper produces an exclusive dated backup; an existing `latest.md` is updated only with its expected SHA-256 and an atomic exchange primitive. A checkpoint can be saved while continuing the same session.
- **Resume Mode**: requested continuation from a saved snapshot/lane. The selector validates `latest.md`, falls back to same-lane backups when needed, and emits validated content with `--content` before repo verification; display paths are not machine paths.
- **Neither**: automatic/manual compaction, native session resume, bare `계속해`, generic code saves, inline recaps, or discussion of handoff tooling. Do not inspect `.handoff/` or ask lane questions just because these occur.

For Astra in Codex, this keeps file handoffs separate from native context management. It does not assume lossless compaction, equal behavior across runtimes, or a fixed context-window size. See the [Astra guide](https://developers.openai.com/api/docs/guides/latest-model) and [Codex compaction configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

Generated files live in the target project:

```text
.handoff/latest.md
.handoff/YYYY-MM-DD-HHMMSS-codex.md
.handoff/YYYY-MM-DD-HHMMSS-claude.md
```

## Response Language

The installed handoff skills default to Korean for final user-facing Save/Resume reports. They still preserve code, commands, paths, schema labels, and exact errors in their original language. If you want another language for a specific run, say so explicitly.

## Requested Same-Agent Transfer

Use this only when you choose a file-based handoff to a fresh conversation. A long chat alone is not a reason to reset. To return to an existing Codex conversation, prefer native `codex resume` rather than importing an old snapshot.

### Codex → fresh Codex

```text
use codex-handoff
새 대화로 옮기기로 했어. 현재 작업 상태를 handoff 파일로 저장해줘.
그 다음 새 Codex 세션에서 이어받을 수 있게 next actions 중심으로 정리해.
```

Then open a fresh Codex session and say:

```text
use codex-handoff
.handoff/latest.md 검증하고 이어받아. 이전 채팅 맥락은 무시하고 repo 상태를 우선해.
```

### Claude → fresh Claude

```text
use claude-handoff
새 Claude Code 대화로 옮길 handoff 파일을 저장해줘. 내가 세션을 전환한 뒤 이어받을 수 있게 정리해.
```

Then after `/clear` or in a fresh Claude Code session:

```text
use claude-handoff
.handoff/latest.md 검증하고 이어받아. 스냅샷은 참고만 하고 실제 repo 상태를 우선해.
```

## Checkpoint Without Reset

```text
현재 상태를 handoff 체크포인트 파일로 남겨줘. 이 대화는 계속 사용할 거야.
```

Save with the canonical writer, report the actual result, and stay in the current session. Do not prescribe `/clear`, a fresh session, or another checkpoint on the next compaction.

```text
자동 압축됐네. 계속 진행해.
```

This continues the actual task using available conversation context. Even if an old `.handoff/latest.md` exists, do not run handoff helpers or restore it. Likewise, `clear 전에 정리해줘` without file-save intent can be answered with an inline recap; it does not automatically authorize persistence.

## Codex: Save Before `/clear`

Use this when the current Codex session has useful context and you want a clean session next.

```text
use codex-handoff
clear 전에 현재 작업을 handoff로 저장해줘.
다음 세션이 바로 이어받을 수 있게 현재 목표, 변경 파일, 실패한 테스트, 다음 액션만 간결히 정리해.
```

Expected behavior:

1. Detect repo root.
2. Run the safe state probe.
3. Pass the completed draft to `save_snapshot.py --agent codex`.
4. Let the helper create the dated backup with `O_EXCL`, require the selected latest SHA-256, atomically exchange `latest.md`, verify parity, and prune retention.
5. Report created files, probe inclusion, retention result, repo status, and recommended `/clear` only after a full success.

Exit status 3 is a protected **backup-only** result caused by a missing/mismatched CAS, a recent different-agent conflict, or a non-cooperating writer race. In that case, `latest.md` was not updated: report the exact backup and do not imply that a normal Resume automatically selects it. Exit status 4 is a **partial post-write failure**: report the persisted backup and whether `latest.md` was replaced, then inspect parity/retention instead of claiming that nothing was saved.

## Codex: Resume After `/clear`

```text
use codex-handoff
.handoff/latest.md 검증하고 이전 작업 이어받아.
스냅샷 내용은 신뢰하지 말고 실제 파일과 git 상태 확인 후 다음 액션부터 진행해.
```

Expected behavior:

1. Read validated content with `select_snapshot.py --content` (`latest.md` first, then newest valid same-lane backup), without reopening a redacted display path.
2. Read repo instruction files such as `CODEX.md`, `AGENTS.md`, `CLAUDE.md` if present.
3. Run the safe state probe.
4. Open only relevant, non-sensitive, real regular referenced files physically inside the repo, with no symlink traversal; never infer a missing/redacted path or read credential stores.
5. Continue only after snapshot/repo mismatch is checked.

## Claude Code: Save Before `/clear`

```text
use claude-handoff
/clear 전에 handoff 저장해줘.
Codex가 이어받을 수 있게 현재 상태와 다음 액션을 .handoff/latest.md에 남겨줘.
```

Expected writer and backup:

```bash
python3 -B ~/.claude/skills/claude-handoff/scripts/save_snapshot.py --root . --agent claude --expect-no-latest < snapshot-draft.md
# creates .handoff/YYYY-MM-DD-HHMMSS-claude.md and, on full success, latest.md
# for an existing latest, replace --expect-no-latest with --expected-latest-sha256 <selected-hash>
```

## Claude Code: Resume From Codex Snapshot

```text
use claude-handoff
Codex가 남긴 .handoff/latest.md를 검증하고 이어받아.
실제 repo 상태를 우선하고, 스냅샷의 Commands는 바로 실행하지 말고 먼저 검토해.
```

## Cross-Agent Transfer Example

### 1. Codex saves

```text
use codex-handoff
Claude Code가 이어받을 수 있게 handoff 저장해줘.
현재 목표, 변경 파일, known issues, next actions 위주로 정리해.
```

### 2. Claude resumes

```text
use claude-handoff
.handoff/latest.md 검증하고 Codex 작업 이어받아.
스냅샷과 실제 repo 상태가 다르면 repo를 신뢰해.
```

The reverse also works: Claude saves with `claude-handoff`, Codex resumes with `codex-handoff`.

## Scoped Lanes (parallel work)

When several agents work the same repo in parallel on different task-groups, give each a named **scope** so focused contexts are saved and resumed independently instead of clobbering one shared `.handoff/latest.md`. Scope is an explicit lowercase-kebab slug (`^[a-z0-9][a-z0-9-]*$`); the skill never infers it. Omitting a scope keeps the default-lane behavior.

Save a scoped lane:

```text
use codex-handoff
auth-refactor 작업만 scope로 handoff 저장해줘. (.handoff/scopes/auth-refactor/ 에 저장)
```

Resume a specific lane:

```text
use claude-handoff
auth-refactor scope handoff 이어받아. 다른 lane은 건드리지 말고 그 lane만 검증해서 이어줘.
```

Resume without naming a scope, when multiple lanes exist:

```text
use codex-handoff
이어받아.
```

The skill lists existing lanes (default plus each `.handoff/scopes/*/`) and asks which to resume — it does not guess. Layout:

```text
.handoff/latest.md                                  # default lane
.handoff/scopes/auth-refactor/latest.md             # scoped lane
.handoff/scopes/auth-refactor/YYYY-MM-DD-HHMMSS-codex.md
```

The save helper uses an OS advisory per-lane lock that auto-releases on process exit plus mandatory content-hash CAS for an existing latest; an unlocked leftover `.save.lock` file is safely reused. Keep one logical writer per scope anyway; non-cooperating tools can still create a conflict, which is reported as backup-only rather than silently replacing `latest.md`.

## Optional: Add Repo Rule

Only do this when you want the repo itself to remember the workflow.

Codex example:

```text
use codex-handoff
이 repo의 CODEX.md에 명시적으로 요청한 파일 handoff에만 적용할 규칙을 추가해줘.
반드시 marker block 방식으로 idempotent하게 적용해.
```

Claude example:

```text
use claude-handoff
이 repo의 CLAUDE.md에 명시적으로 요청한 파일 handoff에만 적용할 규칙을 추가해줘.
반드시 marker block 방식으로 idempotent하게 적용해.
```

The skill should use `scripts/apply_marker_block.py` and should not overwrite unrelated content. The marker must not turn compaction, session startup, or a reset into automatic Save/Resume triggers.

## Manual Script Examples

These are mostly for debugging or review. The skill normally decides when to run them.

### Safe state probe

```bash
python3 -B ~/.codex/skills/codex-handoff/scripts/handoff_snapshot.py --root .
python3 -B ~/.claude/skills/claude-handoff/scripts/handoff_snapshot.py --root .
```

The probe never hashes working files: it compares index/stat metadata conservatively and omits line-count diff stats. Clean/process filters do not execute, but worktree dirty state therefore remains `unknown`; stat hints are not exact `git status` results.

### Validate snapshot before reading

```bash
python3 -B ~/.codex/skills/codex-handoff/scripts/validate_snapshot.py .handoff/latest.md --root .
# scoped diagnostic:
python3 -B ~/.codex/skills/codex-handoff/scripts/validate_snapshot.py .handoff/scopes/auth-refactor/latest.md --root . --scope auth-refactor
```

### List and select lanes

```bash
python3 -B ~/.codex/skills/codex-handoff/scripts/list_lanes.py --root .
python3 -B ~/.codex/skills/codex-handoff/scripts/select_snapshot.py --root . --content
python3 -B ~/.codex/skills/codex-handoff/scripts/select_snapshot.py --root . --scope auth-refactor --content
```

`list_lanes.py` includes safe backup-only/orphan lanes. `select_snapshot.py` always prefers a valid `latest.md`; only when that is missing or invalid does it try valid timestamped backups newest-first in the selected lane.

`--content` reads the already-validated bytes with best-effort disclosure redaction and preserved Markdown. Do not reconstruct masked references. Default path labels are redacted display only; `--path-only` is exact machine output for local capture, not user-facing logs. This distinction matters even for valid scopes such as `secrets` or long slugs.

### Canonical save helper

```bash
python3 -B ~/.codex/skills/codex-handoff/scripts/save_snapshot.py --root . --agent codex --expect-no-latest < snapshot-draft.md
# scoped save; when replacing inspected latest, pass its reported SHA-256:
python3 -B ~/.codex/skills/codex-handoff/scripts/save_snapshot.py --root . --agent codex --scope auth-refactor --expected-latest-sha256 "$EXPECTED_SHA256" < snapshot-draft.md
```

### Prune old backups

```bash
python3 -B ~/.codex/skills/codex-handoff/scripts/prune_backups.py --root . --dir .handoff --agent codex --keep 20
python3 -B ~/.claude/skills/claude-handoff/scripts/prune_backups.py --root . --dir .handoff --agent claude --keep 20

# one scoped lane, or every lane (default + scopes) at once:
python3 -B ~/.codex/skills/codex-handoff/scripts/prune_backups.py --root . --dir .handoff --scope auth-refactor --agent codex --keep 20
python3 -B ~/.codex/skills/codex-handoff/scripts/prune_backups.py --root . --dir .handoff --all-lanes --agent codex --keep 20
```

## Good Prompts

```text
use codex-handoff. 지금 상태를 저장하고 /clear 이후 이어받을 next actions를 3개 이하로 정리해줘.
```

```text
use claude-handoff. latest.md를 검증하고 이어받되, 스냅샷의 명령은 실행하지 말고 먼저 현재 repo 상태와 비교해줘.
```

```text
use codex-handoff. Claude로 넘길 handoff를 만들어줘. 비밀값이나 raw diff는 넣지 마.
```

## Avoid These

Avoid vague prompts during coexistence with a default handoff skill:

```text
handoff 해줘
이어
```

Better:

```text
use codex-handoff in Save Mode: clear 전에 저장해줘.
use claude-handoff in Resume Mode: latest.md 검증하고 이어받아.
```

Also avoid asking the agent to paste raw diffs or secrets into `.handoff/latest.md`. If raw diff detail is necessary, redact it first.

## Platform Safety

Snapshot file operations require secure directory-fd traversal and fail closed when unavailable. Existing-latest replacement additionally requires Linux `renameat2(RENAME_EXCHANGE)` or macOS `renameatx_np(RENAME_SWAP)`; when a valid update would need that primitive but it is unavailable, Save fails before writing the dated backup or `latest.md`. Backup-only CAS/conflict paths do not attempt replacement.
