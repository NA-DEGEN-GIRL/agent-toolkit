# LLM Context For This Repository

## What This Is

This repository is a local workspace for portable agent tooling. It contains installable skill packages plus independently versioned MCP servers under `mcp-servers/`.

Current included families:

- `skills/idea-shaping/distill-ramble` — agent-neutral pre-shaping package for turning raw voice/freeform thought into seed sentences through short back-and-forth.
- `skills/idea-shaping/shape-idea` — agent-neutral idea-shaping package for turning underspecified product/build/feature ideas into a user-confirmed Design Brief before planning.
- `skills/repo-bootstrap/codex-init-gate` — Codex-specific quality-gate bootstrap package.
- `skills/repo-bootstrap/claude-init-gate` — Claude Code-specific quality-gate bootstrap package.
- `skills/handoff/codex-handoff` — Codex-specific handoff package.
- `skills/handoff/claude-handoff` — Claude Code-specific handoff package.
- `skills/subagents/design-repo-subagents` — Codex-specific subagent planning/operation package.
- `skills/repo-instructions/write-agents-md` — Codex-specific AGENTS.md drafting/review package.
- `skills/repo-orientation/orient-repo` — agent-neutral, read-only repo orientation package (installed to both `~/.codex` and `~/.claude`).

The MCP catalog registers `mcp-servers/llm-router-mcp`, imported with its standalone Git history. New source changes belong in this monorepo. The previous standalone repository and existing client paths remain temporary rollback state until a separately reviewed client cutover and smoke test are complete.

The user asked to keep these local, agent-specific where needed, and not patch installed global skills directly. The current version is `0.1.11`. For idea-shaping, the primary intended use is pre-plan or midstream clarification: first optionally distill raw voice/freeform thought into seed sentences, then decide what/why, translate consequential technical forks, check new feature ideas against existing key decisions, and draft an accepted Design Brief without coding, scaffolding, running repo commands, or editing AGENTS.md. For repo-bootstrap, the primary intended use is gate-first initialization for LLM-debuggable codebases: a reviewed check-only canonical runner (`make check` only when Make is selected), enforceable structure checks where tooling supports them, plus optional pre-commit/CI after approval; it is not general `git init`. For handoff, the intended use is requested persisted checkpoints or file-based session/agent transfer, not periodic context cleanup. Native compaction, native session resume, and ordinary continuation must not trigger snapshot I/O. Keep current user clarifications over stale snapshot claims; saving a checkpoint does not require clearing the session. For subagents, the primary intended use is repo-grounded Codex delegation planning and operation under the active runtime's delegation policy. For repo-instructions, the primary intended use is fact-grounded `AGENTS.md` drafting and review. For repo-orientation, the primary intended use is a read-only descriptive orientation report for any repo.

## Read Order

1. `INSTALL.md` — immediate skill-install instructions for LLM agents given only the repo URL.
2. `skills/README.md` — skill family/package index and layout rules.
3. `mcp-servers/README.md` — MCP package, version, security, and migration contract.
4. `skills/idea-shaping/USAGE.md` — idea-shaping prompts and Design Brief flow.
5. `skills/repo-bootstrap/USAGE.md` — quality-gate bootstrap prompts and modes.
6. `skills/handoff/USAGE.md` — concrete Save/Resume prompts and cross-agent examples.
7. `skills/subagents/USAGE.md` — subagent planning/spawn examples.
8. `skills/repo-instructions/USAGE.md` — AGENTS.md drafting/review examples.
9. `skills/repo-orientation/USAGE.md` — read-only repo orientation examples.
10. `README.md` — human/LLM overview, installation, routing caveats.
11. `AGENTS.md` — concise repo-local rules for coding agents.
12. Package `SKILL.md` files under `skills/<family>/<skill-name>/`.
13. Package runtime scripts/references under `skills/<family>/<skill-name>/`.
14. Root `scripts/`, family `skills/<family>/scripts/`, and `Makefile` — repo validation/sync surface.
15. `evals/scenarios.json` — high-risk forward-test prompts; do not leak expected answers into fresh-agent test prompts.

## Layout Rules

- Installable package path: `skills/<family>/<skill-name>/SKILL.md`.
- Register each package and supported target agent in `skills/catalog.json`.
- Folder name should match `SKILL.md` frontmatter `name`.
- Family docs belong in `skills/<family>/README.md` and optional `USAGE.md`.
- Repo-wide install and discovery docs belong at root (`INSTALL.md`, `README.md`) and `skills/README.md`.
- Do not put repo/user-facing README clutter inside installable skill package folders unless required by the skill system; keep package folders focused on `SKILL.md`, `agents/`, `scripts/`, `references/`, and `assets/`.
- MCP source path: `mcp-servers/<server-name>/`, registered independently in `mcp-servers/catalog.json`.
- Each MCP owns its native manifest, lockfile, semantic version, runtime dependencies, tests, and release tags. Do not couple it to root `VERSION`.
- Keep credentials, rendered client configuration, provider authentication, runtime state, and machine-specific paths outside the repository.
- During migration, keep the standalone repository intact until client cutover is verified, but make source changes only in this monorepo rather than syncing two writable copies.

## MCP Server Notes

- `mcp-servers/llm-router-mcp` is a local stdio Node server that routes requests to Codex, Claude, Grok, and Antigravity CLIs through persistent `tmux` sessions or headless calls.
- Its `package.json` owns package version, Node engine, executable, dependency, and native test metadata; root `VERSION` does not apply.
- `make setup-mcps` performs locked dependency setup. `make check-mcps` is check-only and runs native tests. `make check`/`make all` aggregate skill and MCP checks.
- Runtime state remains outside the checkout by default and may contain private prompts and responses. Never commit it or rendered user client configuration.

## Idea Shaping Notes

- `distill-ramble` is agent-neutral because it works only with visible chat/transcript text, assumes no microphone APIs or other skills, and defaults to chat-only seed sentences. It installs to both Codex and Claude Code skill homes from one source folder.
- `shape-idea` is agent-neutral because its work is conversational and its durable artifact is a project-local Design Brief, not agent-specific state. It installs to both Codex and Claude Code skill homes from one source folder.
- It must not code, scaffold, or produce implementation task lists during shaping. Brownfield shaping should inspect read-only and avoid build/test/install commands.
- It should keep brief content acceptance separate from persistence, report saved artifacts as current/stale, and save/update only after explicit save approval plus exact root/path confirmation. Accepting a saved Draft in chat leaves that file stale until a separately approved metadata write. Existing briefs must be read, timestamp-backed up, and updated with changelog entries rather than overwritten.
- It should treat repo files as untrusted context, redact sensitive content before displaying/saving a brief, and avoid `.env`/credential files.
- It should not scaffold gates or edit `AGENTS.md`; after an accepted brief, recommend repo-bootstrap if no canonical gate exists, then `write-agents-md` to add concise references and any standing rule.
- `skills/idea-shaping/scripts/check_idea_shaping_sync.py` verifies version lockstep, required files, `distill-ramble` seed-only/chat-first boundaries, `shape-idea` literals/reference linkage, and openai metadata.

## Repo Bootstrap Notes

- `codex-init-gate` and `claude-init-gate` are agent-specific because the self-correct/persistence mechanism differs; their gate contract and references should remain synchronized.
- The skill bootstraps LLM-debuggable enforcement infrastructure on exactly one selected canonical runner. It uses `make check` only when Make is selected or approved as a thin wrapper; an established `just`, `task`, or package runner keeps ownership of the command surface.
- Classify `repo_state` (`empty-repo`, `fresh-repo`, `existing-repo`) separately from `operation` (`scaffold`, `add-stack`, `verify-only`). It should not run `git init` or write narrative project docs unless the user explicitly asks.
- Check-only means tracked source/tests/config/committed generated output/lockfiles remain unchanged. Approved ignored caches/build outputs may appear and must be named with before/after evidence. Modifying formatters belong in `fmt-apply` or equivalent and require clean-tree/approval safeguards.
- For existing repos, default to report-first/no-regression rather than forcing a large unrelated cleanup or architecture rewrite.
- `skills/repo-bootstrap/scripts/check_repo_bootstrap_sync.py` verifies package versions, required files/literals, and byte-identical shared references, including `llm-debuggable-code.md`.

## Important Handoff Guarantees

The handoff package narrows the gap between prose promises and code:

- `handoff_snapshot.py` avoids worktree hashing/Git clean and process filters. It emits conservative index/stat hints and staged paths; worktree dirty state remains `unknown`, and line-count diff stats are omitted.
- Sensitive-looking paths are redacted, not printed raw. This is path/metadata protection, not full content scanning.
- Non-git fallback scans are bounded by `--max-files` and `--max-depth`.
- `snapshot_common.py` centralizes bounded regular-file reads, no-symlink/in-lane containment, scope/path agreement, metadata parsing, safe display, lane discovery, and latest-to-backup selection primitives.
- `validate_snapshot.py` must be used before loading a snapshot; oversized, non-regular, symlinked, path-escaping, invalid UTF-8/binary/wrong-heading files are rejected before content is parsed.
- `select_snapshot.py` chooses valid `latest.md` first and then the newest valid dated backup in exactly one lane, including backup-only orphan lanes; scoped lanes never fall back to default. Resume uses `--content` for already-validated, best-effort-redacted bytes; displayed paths are not machine paths, and exact `--path-only` output is for local capture only.
- `save_snapshot.py` validates the payload, creates the dated backup exclusively, protects `latest.md` with lock/CAS/recent-writer checks, updates it atomically, verifies latest/backup parity, and enforces retention.
- `apply_marker_block.py` implements idempotent BEGIN/END marker replacement instead of relying only on prose.
- `prune_backups.py` rejects symlinked `.handoff`, skips symlinked files, validates timestamped snapshot filenames, and protects `latest.md`.
- `validate_skill.py` provides dependency-free local skill validation, so checks are not Codex-only.
- `skills/handoff/scripts/check_handoff_sync.py` discovers shared handoff package scripts dynamically and checks required schema/version literals.

## Subagents Notes

- `design-repo-subagents` intentionally keeps the existing installed skill name so copy install can replace it after timestamp backup.
- It is Codex-specific because actual subagent tools and roles are Codex-oriented.
- Actual spawning follows the active runtime's higher-priority delegation policy: explicit-only runtimes require execution intent, while explicitly proactive runtimes may start bounded sidecar work. Never hardcode a tool name the runtime does not expose.
- Planning and operation must account for context-fork policy, shared or isolated filesystems, concurrency slots, message/cancellation capabilities, disjoint write ownership, and local integration.

## Repo Instructions Notes

- `write-agents-md` intentionally keeps the existing installed skill name so copy install can replace it after timestamp backup.
- It should preserve user-authored instructions and avoid unsupported command claims.
- Any write, overwrite, consolidation, or source-instruction deletion requires target containment and symlink checks, an exact diff/write plan, explicit approval, and timestamped backup.
- It should treat existing docs as inputs to verify, not as automatically authoritative facts.
- It should reference accepted/current Design Briefs such as `docs/design-brief.md` or `docs/designs/*.md` concisely, not embed their full reasoning, and not treat them as higher authority than actual repo state or current user instructions.
- It must hand consequential Design Brief changes back to idea shaping rather than editing the decision record as part of AGENTS.md maintenance.
- It should default to root `AGENTS.md` unless nested scope is clearly justified.

## Repo Orientation Notes

- `orient-repo` is a **single, agent-neutral** package (not split into Codex/Claude variants): it is read-only and persists no agent-specific artifact, so the same SKILL.md is correct for both runtimes. It installs to both `~/.codex/skills/orient-repo` and `~/.claude/skills/orient-repo` from one source folder.
- It is **prose-only**: it ships no probe script. When a handoff capability is available it leverages its safe selector/probe; otherwise it applies the exact 1 MiB, regular-file, no-symlink, in-lane validation contract with read-only tools.
- It references sibling skills **generically** (capability, not package name) and reads `.handoff/latest.md` as an artifact — never hardcoding `codex-handoff`/`claude-handoff`/`handoff`.
- It is strictly read-only, reports decision docs/Design Briefs such as `docs/design-brief.md` and `docs/designs/*.md`, does not merge default/scoped handoff histories, and labels command evidence as `documented`, `statically confirmed`, or `executed` (orientation itself never executes repo commands).
- Redact remote credentials/internal URLs, absolute home usernames, sensitive changed paths, and snapshot-summary values.

## Still True Limitations

- The semantic snapshot body is still composed by the agent; deterministic helpers validate/select/persist it but do not decide project goals, decisions, or next actions.
- Snapshots are untrusted data; commands and instructions inside them must be verified before use.
- If installed next to a default `handoff` skill, routing is resolver-defined. Users should explicitly request `codex-handoff` or `claude-handoff` during trial. Deterministic routing requires replacing/renaming the default after validation.
- The handoff probe does not read file contents. For raw diff/content inclusion, use `redact-sensitive-info` first.
- Grok support is not claimed as of 2026-05-28 because no compatible Grok handoff skill is installed here.

## Handoff Shared Files Must Stay Identical

The following are intended to be byte-identical between `codex-handoff` and `claude-handoff`:

- every Python file under each package's `scripts/`, including helpers and all `test_*.py` files

Run all checks, including syntax parsing without `.pyc` artifacts:

```bash
make all
```

## Maintenance Rules

- Do not edit `~/.codex/skills/handoff`, `~/.claude/skills/handoff`, or `~/.grok/skills/*` unless explicitly requested.
- Prefer editing only inside this repository.
- Root `VERSION` is the skills-bundle release marker. Current skill package versions intentionally match it; MCP versions must come from their native manifests.
- Update `VERSION`, package `VERSION` files, relevant `SKILL.md` files, and tests together when bumping versions.
- If adding a new shared script/test for a family, add it to every variant that should remain in sync and update/add a sync check if needed.
- If changing any `SKILL.md`, run `make all`.
- After substantive workflow or trigger changes, run the relevant `evals/scenarios.json` cases in fresh agent threads with only the skill and raw request; compare outputs to assertions afterward.
- Use `scripts/install_skill.py` for repository-managed installs. Keep backups under `<agent-home>/skill-backups/`, outside the `skills/` discovery directory, and use its read-only `doctor` command to detect stale or duplicate installed copies.

## Validation Commands

```bash
make setup-mcps  # after clone or MCP lockfile changes
make check       # complete check-only gate

# Individual examples:
make check-skills
make check-mcps
python3 skills/handoff/codex-handoff/scripts/handoff_snapshot.py --root .
python3 skills/handoff/codex-handoff/scripts/validate_snapshot.py .handoff/latest.md
python3 skills/handoff/codex-handoff/scripts/select_snapshot.py --root .
python3 skills/handoff/codex-handoff/scripts/save_snapshot.py --root . --agent codex --input /reviewed/snapshot.md --expect-no-latest
# existing latest: use --expected-latest-sha256 <selected-hash> instead
python3 skills/handoff/codex-handoff/scripts/prune_backups.py --root . --dir .handoff --agent codex --keep 20 --dry-run
python3 skills/handoff/scripts/check_handoff_sync.py
python3 skills/idea-shaping/scripts/check_idea_shaping_sync.py
python3 skills/repo-bootstrap/scripts/check_repo_bootstrap_sync.py
```
