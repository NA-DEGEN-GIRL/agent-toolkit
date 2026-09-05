# Changelog

This file summarizes repository releases. Installable package folders remain focused on runtime assets; release history stays at the repository root.

## Unreleased

### Review hardening

- Corrected MCP session-start ownership, subprocess cancellation/timeout cleanup,
  startup deadline handling, and nested-wrapper verification; added fake-provider regressions.
- Hardened handoff probing against Git filter execution, concurrent marker writes,
  and lossy selector paths; clarified snapshot trust and referenced-file boundaries
  and prevented helper imports from generating package bytecode.
- Made skill installation cancellation-recoverable and Go formatting examples
  fail closed, with isolated interruption and executable-example tests.
- Refreshed vulnerable MCP transitive dependencies and added a separate weekly
  lockfile audit without adding network access to the canonical check gate.
- Added inert forward-eval fixtures and assertion-free prompt preparation, kept
  distinct from deterministic tests and actual behavioral evaluation evidence.

### Repository structure

- Expanded the repository contract from skills-only packaging to a broader local-agent toolkit while preserving the existing `skills/` layout and installer behavior.
- Added a separate `mcp-servers/` catalog and nested maintenance rules so MCP manifests, versions, tests, credentials, and runtime state remain isolated from the skills bundle.
- Imported the standalone `llm-router-mcp` Git history under `mcp-servers/llm-router-mcp`, registered it in the MCP catalog, and made this monorepo its source of truth while retaining the old checkout temporarily for client rollback.
- Added MCP catalog/manifest validation, locked dependency setup, native Node/tmux tests, and pinned Node CI alongside the existing skill gate.
- Updated `llm-router-mcp` to `0.1.1` with monorepo metadata, manifest-derived server versioning, cwd-independent tests, explicit tmux preflight, clearer trusted-local security guidance, and a compatible transitive Hono security patch.

## 0.1.11 — 2026-07-09

### Safety and installation

- Added the dry-run-first `scripts/install_skill.py` installer, external backup storage, installed-state `doctor`, metadata-validated rollback, duplicate detection, source-tree link/special-file rejection, fixed per-skill mutation locks, and isolated smoke tests.
- Added `skills/catalog.json` as the package/target registry and exact-layout/catalog validation.
- Hardened handoff snapshot selection, validation, saving, path containment, concurrency checks, output redaction, and helper edge cases.
- Extended idea distillation redaction to inline output and made all idea-shaping writes require an explicit root/path confirmation.

### Workflow contracts

- Separated Design Brief content acceptance from persistence state.
- Applied repo-bootstrap gate contracts to the selected canonical runner instead of requiring Make in every repository.
- Split bootstrap repository state from requested operation and clarified allowed ignored cache/build outputs.
- Made subagent behavior follow active runtime capabilities and delegation policy.
- Added safe consolidation/write boundaries for `write-agents-md` and scoped handoff/confidence reporting for `orient-repo`.

### Quality

- Added pinned, least-permission GitHub Actions checks on Python 3.10 and 3.14.
- Added high-risk behavior scenarios under `evals/` and validation that every package is covered.
- Added `make check` as an alias for the historical `make all` gate.

## 0.1.10 — 2026-07-01

- Added `distill-ramble` and tightened `write-agents-md` guardrails while keeping all package versions aligned with the monorepo release marker.
