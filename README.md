# Agent Toolkit

This repository manages portable local-agent tooling in one place while keeping each tool type independently installable and testable. It ships skill packages for Codex and Claude Code plus the local `llm-router-mcp` server, without mixing MCP manifests, versions, dependencies, or runtime state into the skills bundle.

- Skills live under [`skills/`](skills/README.md) and use [`skills/catalog.json`](skills/catalog.json).
- MCP servers live under [`mcp-servers/`](mcp-servers/README.md) and use [`mcp-servers/catalog.json`](mcp-servers/catalog.json).
- The two catalogs are intentionally separate because their package, install, release, and runtime contracts differ.

## Skills at a glance

> 사람용 빠른 훑기 — 스킬별 자세한 사용법은 [`USER_GUIDE.md`](USER_GUIDE.md), 설치는 [`INSTALL.md`](INSTALL.md).

| 스킬 | 어느 agent | 무엇을 하나 | 이렇게 말하면 |
|---|---|---|---|
| `distill-ramble` | Codex + Claude | 마이크/대화로 떠든 raw thought를 seed 문장으로 압축 | "마이크로 떠드는 걸 정리해줘" · "seed 문장으로 만들어줘" |
| `shape-idea` | Codex + Claude | 모호한 만들기 아이디어를 질문·기술 fork 번역·Design Brief로 구체화 | "아이디어 구체화해줘" · "먼저 설계" |
| `codex-init-gate` | Codex | 선택된 runner에 LLM-debuggable check-only 품질 게이트 구성 | "게이트 깔아줘" · "scaffold checks" |
| `claude-init-gate` | Claude Code | 위와 동일 (Claude Code용) | "게이트 깔아줘" · "scaffold checks" |
| `codex-handoff` | Codex | 요청한 체크포인트·작업 인수인계 저장/재개 (`.handoff/`) | "handoff 저장해줘" · "handoff에서 이어받아" |
| `claude-handoff` | Claude Code | 위와 동일 (Claude Code용) | "handoff 저장해줘" · "handoff에서 이어받아" |
| `design-repo-subagents` | Codex | repo 기반 explorer·worker·검토 subagent 설계/운영 | "이 작업 subagent로 나눠줘" · "비판 agent" |
| `write-agents-md` | Codex | repo 사실 기반 `AGENTS.md` 작성·리뷰 | "AGENTS.md 만들어줘" |
| `orient-repo` | Codex + Claude | 읽기전용 repo 파악 리포트 (stack·명령·구조) | "이 repo 파악해줘" |
| `game-visual-polish` | Codex | 기존 게임의 아트 방향·UI·장면·특정 아이템/에셋을 범위 안에서 개선 | "게임 그래픽 개선해" · "이 검 디자인만 개선해" |

각 스킬은 `use <스킬이름>` 또는 위 트리거 문구로 부릅니다. `idea-shaping`은 raw voice or freeform thought를 seed 문장으로 정리한 뒤 계획 전 결정/이유를 Design Brief로 구체화하는 용도이고, `repo-bootstrap`은 LLM이 수정·디버깅하기 쉬운 품질 게이트 초기화가 주 용도이며, `handoff`는 명시적으로 요청한 체크포인트·세션/에이전트 인계가 주 용도입니다. `game-visual-polish`는 기존 게임의 시각 품질을 장르와 프로젝트 맥락에 맞게 개선하되 gameplay contract와 요청 범위를 보호하는 용도입니다. `distill-ramble`, `shape-idea`, `orient-repo`는 Codex·Claude 공용입니다.

## MCP servers at a glance

| 서버 | transport/runtime | 무엇을 하나 | 문서 |
|---|---|---|---|
| `llm-router-mcp` | stdio / Node.js | Codex, Claude, Grok, Antigravity CLI를 persistent `tmux` session 또는 headless one-shot으로 호출 | [`mcp-servers/llm-router-mcp/README.md`](mcp-servers/llm-router-mcp/README.md) |

Current repository version: `0.1.11` for the skills bundle. The root `VERSION` intentionally applies only to skill packages; each MCP server owns its version in its native package manifest.

**LLM installers:** read [`INSTALL.md`](INSTALL.md) first. It is the stable entrypoint for an agent that receives only this repo URL and is asked to install the matching skill(s).

**Humans/users:** start with [`USER_GUIDE.md`](USER_GUIDE.md) for a per-skill walkthrough, browse [`skills/README.md`](skills/README.md), and use [`CHANGELOG.md`](CHANGELOG.md) for release-level changes. For concrete usage examples, read [`skills/idea-shaping/USAGE.md`](skills/idea-shaping/USAGE.md), [`skills/repo-bootstrap/USAGE.md`](skills/repo-bootstrap/USAGE.md), [`skills/handoff/USAGE.md`](skills/handoff/USAGE.md), [`skills/subagents/USAGE.md`](skills/subagents/USAGE.md), [`skills/repo-instructions/USAGE.md`](skills/repo-instructions/USAGE.md), [`skills/repo-orientation/USAGE.md`](skills/repo-orientation/USAGE.md), or [`skills/game-visual-polish/USAGE.md`](skills/game-visual-polish/USAGE.md).

## Contents

```text
agent-toolkit/
├── VERSION
├── README.md
├── INSTALL.md              # LLM-first skill install entrypoint
├── CHANGELOG.md            # repository release notes
├── AGENTS.md               # repo-local agent instructions
├── LLM_CONTEXT.md          # maintainer context for future agents
├── Makefile
├── scripts/                # repo-level validators and skill installer/doctor
├── evals/                  # forward-test scenarios and assertions
├── mcp-servers/
│   ├── README.md           # MCP package and migration contract
│   ├── AGENTS.md           # nested MCP maintenance instructions
│   ├── catalog.json        # MCP package registry
│   └── llm-router-mcp/     # independently versioned Node stdio MCP server
└── skills/
    ├── README.md           # skills/family index
    ├── catalog.json        # package/target registry
    ├── idea-shaping/
        ├── README.md       # family overview
        ├── USAGE.md        # examples for shaping ideas
        ├── scripts/         # family-level sync check
        ├── distill-ramble/ # installable agent-neutral pre-shaping skill package
        └── shape-idea/      # installable agent-neutral skill package
    ├── repo-bootstrap/
        ├── README.md       # family overview
        ├── USAGE.md        # examples for gate setup
        ├── scripts/         # family-level sync check
        ├── codex-init-gate/  # installable Codex skill package
        └── claude-init-gate/ # installable Claude Code skill package
    ├── handoff/
        ├── README.md       # family overview
        ├── USAGE.md        # prompts and workflow examples
        ├── scripts/         # family-level maintenance checks
        ├── codex-handoff/  # installable Codex skill package
        └── claude-handoff/ # installable Claude Code skill package
    ├── subagents/
        ├── README.md       # family overview
        ├── USAGE.md        # examples for planning/spawning
        └── design-repo-subagents/ # installable Codex skill package
    ├── repo-instructions/
        ├── README.md       # family overview
        ├── USAGE.md        # examples for AGENTS.md workflows
        └── write-agents-md/ # installable Codex skill package
    ├── repo-orientation/
        ├── README.md       # family overview
        ├── USAGE.md        # examples for read-only orientation
        ├── scripts/         # family-level sync check
        └── orient-repo/    # installable agent-neutral skill package
    └── game-visual-polish/
        ├── README.md       # family overview and provenance
        ├── USAGE.md        # whole-game/item/UI/design-only examples
        └── game-visual-polish/ # installable Codex skill package
```

## Skills Layout Contract

Installable packages live under:

```text
skills/<family>/<skill-name>/SKILL.md
```

Rules:

1. `skills/<family>/` contains family-level docs only.
2. `skills/<family>/<skill-name>/` is the package copied/symlinked into an agent's skill home.
3. The package folder name must match `SKILL.md` frontmatter `name`.
4. Put shared repo tooling in root `scripts/`; put skill-runtime scripts inside the package `scripts/` folder.
5. Register every package and supported agent in `skills/catalog.json`.
6. A skill package is discovered only at `skills/<family>/<skill-name>/SKILL.md`. Run `make check-skills` before committing or recommending a skill installation.

## MCP Server Layout Contract

Locally managed MCP servers live under:

```text
mcp-servers/<server-name>/
```

Each server keeps its own manifest, lockfile, version, tests, and release lifecycle. `mcp-servers/catalog.json` currently registers `llm-router-mcp`; its package manifest is the version and executable source of truth. Do not commit client credentials, rendered user configuration, provider authentication, or runtime state. See [`mcp-servers/README.md`](mcp-servers/README.md) for the package and migration contract.

## Current Skill Families

### Idea Shaping

The idea-shaping family helps Codex or Claude Code move from raw voice or freeform thought to a user-confirmed **Design Brief** before planning or coding, including mid-project feature additions before implementation. `distill-ramble` first turns messy spoken/typed thinking into reusable seed sentences; `shape-idea` then clarifies what/why, translates consequential product-shaping technical forks into plain language with proper terms, stress-tests risky assumptions, and records testable acceptance criteria plus the alternatives rejected. The installable packages are `skills/idea-shaping/distill-ramble/` and `skills/idea-shaping/shape-idea/`.

These packages are intentionally **unified and agent-neutral**: the work is conversational, `distill-ramble` defaults to chat-only redacted seed material, and `shape-idea`'s durable artifact is a project-local Design Brief, not agent-specific state. They write no code, do not edit `AGENTS.md`, and require exact root/path confirmation before every file write. Brief content acceptance (`Draft` → `Accepted`) stays separate from persistence (`inline-only` / `saved`). After an accepted brief, run repo-bootstrap if no canonical gate exists, then `write-agents-md` can add concise references to the brief and gate. See [`skills/idea-shaping/USAGE.md`](skills/idea-shaping/USAGE.md).

## Recommended End-to-End Flow

1. **distill-ramble** — optional: turn raw voice/freeform thought into seed sentences.
2. **shape-idea** — decide what/why, consequential tradeoffs, risks, and testable acceptance criteria in an accepted Design Brief.
3. **repo-bootstrap** — if the repo lacks a canonical quality gate, install or map one before feature work.
4. **write-agents-md** — reference the accepted Design Brief and canonical gate from `AGENTS.md` without embedding full reasoning.
5. **plan/build** — sequence implementation against the brief and gate.

### Repo Bootstrap

The repo-bootstrap family helps Codex or Claude Code stand up a deterministic, LLM-debuggable quality gate before feature work. It applies the `fmt`/`lint`/`typecheck`/`test` contract to exactly one selected canonical runner—`make check` only when Make is selected or approved as a thin wrapper—and can wire pre-commit/CI after approval. It classifies repository state separately from the requested operation and verifies that checks preserve tracked source/config/lockfiles while reporting approved ignored caches/build outputs. It is a **quality-gate bootstrap**, not a general `git init` replacement.

- `codex-init-gate`: Codex package for planning, scaffolding, and verifying the gate with a Codex self-correct loop.
- `claude-init-gate`: Claude Code counterpart; hook/settings wiring must be confirmed against current Claude Code docs or user-provided config before writing.

Primary workflow: inspect stack, command bodies, existing runner, and code-structure signals → classify `repo_state` (`empty-repo`, `fresh-repo`, `existing-repo`) separately from `operation` (`scaffold`, `add-stack`, `verify-only`) → plan enforceable vs advisory LLM-debuggable rules → approve → apply → run the reviewed canonical check path. See [`skills/repo-bootstrap/USAGE.md`](skills/repo-bootstrap/USAGE.md).

### Handoff

Primary workflow: **requested file-based checkpoints and handoffs**. Ordinary continuation, native compaction, and native session resume do not trigger file handoffs. Save/import a snapshot only when requested; a checkpoint does not require a reset. Cross-agent transfer requires compatible receiving tooling.

- `codex-handoff`: Codex skill package for saving/resuming `.handoff/` snapshots, for requested checkpoints or session/compatible-agent transfer.
- `claude-handoff`: Claude Code counterpart, with the same requested-file boundary.

Snapshot files live in the target project, never in this skill repository:

```text
.handoff/latest.md
.handoff/YYYY-MM-DD-HHMMSS-codex.md
.handoff/YYYY-MM-DD-HHMMSS-claude.md
```

These packages are intentionally **agent-specific**. They share a file format, but they do not claim compatibility with an agent unless that agent actually has a compatible skill installed. As of 2026-05-28, Grok has no compatible local handoff skill here, so Grok support is not claimed.

For parallel multi-agent work, handoff also supports optional named **scopes** (lanes): save/resume a specific task-group at `.handoff/scopes/<scope>/` instead of the shared default lane. Omitting a scope keeps the single-lane behavior. See [`skills/handoff/USAGE.md`](skills/handoff/USAGE.md).

### Subagents

The subagents family helps Codex inspect a repository and decide how to use explorer, worker, and verification subagents safely. The installable package is `skills/subagents/design-repo-subagents/`, intentionally using the same name as the existing local Codex skill so it can replace that skill after backup.

Primary workflow: repo-grounded delegation planning or operation under the active runtime's delegation policy. Explicit-only runtimes require execution intent; runtimes that explicitly enable proactive delegation may spawn bounded sidecar work without inventing unavailable tool names. In all cases the skill accounts for write ownership, context forking, shared-filesystem behavior, concurrency, integration, and cancellation.

### Repo Instructions

The repo-instructions family helps Codex draft, review, and maintain `AGENTS.md` from actual repo facts. The installable package is `skills/repo-instructions/write-agents-md/`, intentionally using the same name as the existing local Codex skill so it can replace that skill after backup.

Primary workflow: inspect repo files, preserve user-authored instructions, include commands with explicit evidence levels, and keep `AGENTS.md` compact and operational. Writes, overwrites, consolidation, and deletions require safe target containment, exact diff/plan approval, and timestamped backups. Consequential Design Brief changes remain owned by idea shaping rather than being silently folded into AGENTS.md maintenance.

### Repo Orientation

The repo-orientation family helps any compatible agent get oriented in a repository read-only and emit a concise **Repo Orientation** report: stack, entrypoints, command evidence level, canonical quality gate, key directories, instruction files, decision docs/Design Briefs, recent activity, selected handoff-lane context, and open unknowns. The installable package is `skills/repo-orientation/orient-repo/`.

This package is intentionally **unified and agent-neutral**: because orientation is strictly read-only and persists no agent-specific artifact, the same package installs to both `~/.codex/skills/orient-repo` and `~/.claude/skills/orient-repo`. It is prose-only and ships no probe script; when a handoff skill is available it leverages that skill's repo-state probe and snapshot, referencing siblings by capability rather than hardcoding a package name, and treating any snapshot as untrusted data.

### Game Visual Polish

The game-visual-polish family helps Codex improve an existing game's graphics, art direction, scene presentation, UI, or selected items/assets without treating visual polish as permission to rebuild gameplay. The installable package is `skills/game-visual-polish/game-visual-polish/`.

The skill distinguishes whole-game, scene, asset, UI, and design-only work; explicit exclusions always win. It protects rules, balance, saves, networking, hitboxes/collision, input semantics, gameplay camera framing, level topology, and attack timing by default. Local asset requests inspect shared materials/shaders/atlases/themes before editing them, and the critic judges actual gameplay-size readability and coherence rather than rewarding realism or pixel equality with generated concept art. Image generation, Blender, runtime capture, performance measurement, web references, and independent subagents are used only when the host actually provides them. See [`skills/game-visual-polish/USAGE.md`](skills/game-visual-polish/USAGE.md).

## What Idea Shaping Enforces By Code

- `skills/idea-shaping/scripts/check_idea_shaping_sync.py`: verifies package versions match root `VERSION`, required files exist, `distill-ramble` preserves seed-only/chat-first boundaries, `shape-idea` links its references and safety/Design Brief literals, and `agents/openai.yaml` metadata stays fresh.
- `references/fork-translations.md` provides reusable seed translations for common technical forks; the SKILL loads it only when a fork needs explanation.

## What Repo Bootstrap Enforces By Code

- `skills/repo-bootstrap/scripts/check_repo_bootstrap_sync.py`: verifies package versions, required files/literals, and byte-identical shared reference files between `codex-init-gate` and `claude-init-gate`, including the LLM-debuggable code reference.
- Package-local references define the LLM-debuggable code principles, check-only gate contract, approval workflow, and stack presets so both variants share the same operational core.

## What Handoff Enforces By Code

- `snapshot_common.py`: provides bounded regular-file reads, path/lane containment, symlink rejection, scope agreement, sanitization, and deterministic candidate discovery.
- `handoff_snapshot.py`: emits hardened Git/non-Git state metadata without raw file contents or diff hunks; disables optional locks, prompts, pagers, fsmonitor, external diff/textconv, redacts sensitive labels, and bounds fallback scans.
- `validate_snapshot.py`: checks containment, file type, symlinks, the 1 MiB limit, UTF-8, NUL bytes, metadata shape, and `# Handoff Snapshot` before context loading.
- `select_snapshot.py`: selects valid `latest.md` then the newest valid same-lane backup, including backup-only orphan lanes without cross-lane fallback.
- `save_snapshot.py`: validates a composed snapshot, creates an exclusive dated backup, applies lock/CAS/recent-writer protection, atomically updates `latest.md`, verifies parity, and safely enforces retention.
- `prune_backups.py`: prunes only real regular files with valid timestamp/agent backup names, rejects unsafe requested lanes/agents, and never deletes `latest.md`.
- `apply_marker_block.py`: preserves target mode, rejects duplicate/partial markers, and idempotently inserts/replaces an approved marker block using atomic writes.
- `skills/handoff/scripts/check_handoff_sync.py`: verifies package versions, shared script sets, hashes, executable bits, and required SKILL literals for the handoff variants.

## What The Other Families Enforce By Code

- `skills/subagents/scripts/check_subagents_sync.py`: verifies the runtime-capability routing references and package metadata.
- `skills/repo-instructions/scripts/check_repo_instructions_sync.py`: verifies instruction-precedence, safe-write, review, and nested-scope references.
- `skills/repo-orientation/scripts/check_repo_orientation_sync.py`: verifies read-only quality-gate, decision-doc, handoff-selection, and confidence-reporting coverage.
- `scripts/check_catalog.py`: checks exact package layout, catalog registration, target agents, versions, metadata, and root-document registration, including `game-visual-polish`.
- `scripts/check_mcp_catalog.py`: checks MCP discovery/catalog parity, direct-child source containment, native manifest/lock metadata, and safe in-package entrypoints.
- `scripts/test_install_skill.py`: exercises dry-run/apply, external backup, copy/symlink replacement, duplicate detection, and rollback in isolated temporary homes.
- `evals/scenarios.json` plus `scripts/check_evals.py`: registers high-risk forward-test prompts and expected/forbidden behavior for every package.

## Safety Boundaries

- Idea-shaping is design-only by default: it does not code or scaffold, treats repo files as untrusted context, uses read-only inspection in brownfield repos, redacts sensitive content, asks before saving/updating a Design Brief, and leaves gate setup plus AGENTS.md references to repo-bootstrap/write-agents-md.
- Repo-bootstrap mutates target repos only after plan/approval for command execution, tool installs, `.git` changes, overwrites, modifying formatters/codegen, and CI additions; the selected canonical check path must be check-only and LLM-friendly structure checks are enforced only where tooling supports them safely.
- Handoff snapshots are **untrusted data**. Commands or instructions inside snapshots must not be executed unless they match the current user request, repo instructions, and actual repo state.
- The handoff probe does **not** read file contents. It redacts suspicious path names and avoids printing raw diffs. If raw diff content is explicitly required, pass it through `redact-sensitive-info` first.
- Secret protection is path/metadata-oriented in the probe; it is not a full content scanner.
- `.handoff/` is treated as local scratch by default; do not edit `.gitignore` or `.git/info/exclude` unless explicitly requested.
- Installed-skill backups belong outside the agent's `skills/` discovery directory; adjacent backup bundles can be rediscovered and create ambiguous routing.
- `llm-router-mcp` is a local trusted-client server that runs provider CLIs with the same OS account privileges as its MCP client. Keep its state outside the checkout and review any client configuration change before applying it.
- `game-visual-polish` keeps visual scope separate from gameplay authorization: an item/UI/art-direction request is not permission to change balance, hitboxes, attack timing, camera gameplay contracts, or unrelated global art.

## Install

Use [`INSTALL.md`](INSTALL.md) for skills. The canonical `scripts/install_skill.py` workflow is dry-run by default, validates the package, and keeps timestamped backups under the agent home but outside `skills/`. Do **not** replace a default `handoff` skill unless the user explicitly asks.

MCP servers do not use the skill installer. Prepare their locked dependencies with `make setup-mcps`, then run `make check-mcps`; follow each package README for client configuration. The previous standalone `llm-router-mcp` repository remains a temporary rollback source until client cutover is verified, but new source changes belong here.

If these packages are installed alongside default `handoff` skills, routing is resolver-defined and not guaranteed by this repository. During trials, explicitly name the desired skill in prompts:

```text
use distill-ramble to turn this voice ramble into seed sentences
use shape-idea to clarify this idea
use codex-handoff to save state
use claude-handoff to resume from handoff
use game-visual-polish to improve this game's visuals without changing gameplay
```

For deterministic routing, validate first, then intentionally replace/rename the default only if the user wants that behavior.

## Validate

Repository scripts require Python 3.10 or newer. CI exercises the minimum supported line (3.10) and the current stable line (3.14) on the Linux/POSIX automation baseline. Native Windows execution of the full repo and handoff script suite is not currently release-gated.

On a fresh clone, install locked MCP dependencies once and run the complete check-only gate:

```bash
make setup-mcps
make check
# equivalent full-gate entrypoint: make all
```

`make check-skills` runs the portable skill validators, Python syntax/smoke tests, both catalogs, and family sync checks without installing Node dependencies. `make check-mcps` runs each MCP package's native tests without changing dependencies. `make check` and `make all` aggregate both gates; setup remains separate so validation itself is check-only. `PYTHONDONTWRITEBYTECODE=1` avoids `__pycache__` pollution.

## Current MCP Entrypoint

```text
mcp-servers/llm-router-mcp/bin/llm-router-mcp.js
```

## Current Skill Entrypoints

```text
skills/idea-shaping/distill-ramble/SKILL.md
skills/idea-shaping/shape-idea/SKILL.md
skills/repo-bootstrap/codex-init-gate/SKILL.md
skills/repo-bootstrap/claude-init-gate/SKILL.md
skills/handoff/codex-handoff/SKILL.md
skills/handoff/claude-handoff/SKILL.md
skills/subagents/design-repo-subagents/SKILL.md
skills/repo-instructions/write-agents-md/SKILL.md
skills/repo-orientation/orient-repo/SKILL.md
skills/game-visual-polish/game-visual-polish/SKILL.md
```
