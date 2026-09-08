# Skill Install Guide For LLM Agents

Use this file when a user gives you this repository and asks to install one or more matching skills. Install only the packages matching the requested capability and target agent. This guide and `scripts/install_skill.py` are intentionally skill-specific; MCP servers use the independent contract in [`mcp-servers/README.md`](mcp-servers/README.md). For repository maintenance, also read `AGENTS.md` and `LLM_CONTEXT.md`.

`skills/catalog.json` is the machine-readable package registry. This document explains the user-facing policy; `scripts/install_skill.py` implements the safe install, doctor, and rollback operations.

Repository validation and installer scripts require Python 3.10 or newer. The automated release baseline is Linux/POSIX (Ubuntu CI with GNU Make); native Windows execution of the full repo and handoff script suite is not currently release-gated, so do not claim end-to-end Windows support from this repository.

## Current Packages

| Capability | Target agent | Package | Source folder | Destination |
|---|---|---|---|---|
| idea-shaping | Codex + Claude Code | `distill-ramble` | `skills/idea-shaping/distill-ramble/` | `<agent-home>/skills/distill-ramble` |
| idea-shaping | Codex + Claude Code | `shape-idea` | `skills/idea-shaping/shape-idea/` | `<agent-home>/skills/shape-idea` |
| repo-bootstrap | Codex | `codex-init-gate` | `skills/repo-bootstrap/codex-init-gate/` | `${CODEX_HOME:-$HOME/.codex}/skills/codex-init-gate` |
| repo-bootstrap | Claude Code | `claude-init-gate` | `skills/repo-bootstrap/claude-init-gate/` | `$HOME/.claude/skills/claude-init-gate` |
| handoff | Codex | `codex-handoff` | `skills/handoff/codex-handoff/` | `${CODEX_HOME:-$HOME/.codex}/skills/codex-handoff` |
| handoff | Claude Code | `claude-handoff` | `skills/handoff/claude-handoff/` | `$HOME/.claude/skills/claude-handoff` |
| subagents | Codex | `design-repo-subagents` | `skills/subagents/design-repo-subagents/` | `${CODEX_HOME:-$HOME/.codex}/skills/design-repo-subagents` |
| repo-instructions | Codex | `write-agents-md` | `skills/repo-instructions/write-agents-md/` | `${CODEX_HOME:-$HOME/.codex}/skills/write-agents-md` |
| repo-orientation | Codex + Claude Code | `orient-repo` | `skills/repo-orientation/orient-repo/` | `<agent-home>/skills/orient-repo` |
| game-visual-polish | Codex | `game-visual-polish` | `skills/game-visual-polish/game-visual-polish/` | `${CODEX_HOME:-$HOME/.codex}/skills/game-visual-polish` |

For the shared packages, `<agent-home>` is `${CODEX_HOME:-$HOME/.codex}` for Codex and `$HOME/.claude` for Claude Code.

## Safety Policy

- Validate the skills surface before installing: `make check-skills`.
- The installer is **dry-run by default**. Mutation requires `--apply`.
- Existing same-name packages are moved to `<agent-home>/skill-backups/<name>/<timestamp>/payload`, outside the `skills/` discovery tree. Do not put backups beside live packages: resolvers may rediscover their `SKILL.md` and create duplicate routing.
- Package trees containing symlinks or special files are rejected; installable payloads must contain only real directories and regular files.
- Mutating install/rollback operations take a fixed per-agent/per-skill advisory lock under `<agent-home>/skill-locks/`, independent of any backup-root override.
- Installs prepare and validate the staged package before moving the live destination. Handled cancellation (Ctrl-C/SIGTERM) attempts recovery using mutation state registered before each move. SIGKILL/power loss cannot be caught; an interrupted cross-filesystem backup may require manual recovery from the reported preserved entries.
- Do not replace a default package named `handoff`. Install these variants as `codex-handoff` or `claude-handoff` unless the user explicitly requests a different migration.
- `design-repo-subagents` and `write-agents-md` intentionally use common existing names. Replace them only when the user explicitly requested that package; the installer backs up the old destination first.
- Do not edit installed global skills merely because this repository was opened. Installation must match the user's explicit target agent and package request.
- Use symlink mode only when the clone path is persistent and the user wants installed behavior to track this working copy.

## Quick Clone And Validate

If the repository is not already present:

```bash
tmpdir=$(mktemp -d)
git clone --depth 1 https://github.com/NA-DEGEN-GIRL/agent-toolkit.git "$tmpdir/agent-toolkit"
cd "$tmpdir/agent-toolkit"
```

Inspect the package registry and run the complete gate:

```bash
cat skills/catalog.json
make check-skills
```

`make check-skills` runs the local and optional external skill validators, Python syntax checks, smoke tests, catalog checks, and family sync checks without requiring MCP dependencies or writing `.pyc` files.

## Choose Packages

1. Identify the target agent: Codex, Claude Code, or both.
2. Identify the requested capability/package.
3. Select only catalog entries whose `targets` include that agent.
4. If the target is unclear, ask: `Codex용, Claude용, 둘 다 중 무엇을 설치할까요?`
5. If the capability is unclear, show the package table instead of installing everything.

Typical selections:

- Raw thoughts/voice cleanup: `distill-ramble`
- Idea shaping and Design Briefs: `shape-idea`
- Quality gate setup: `codex-init-gate` or `claude-init-gate`
- Session handoff: `codex-handoff` or `claude-handoff`
- Codex subagent planning/operation: `design-repo-subagents`
- Codex AGENTS.md drafting/review: `write-agents-md`
- Read-only repository tour: `orient-repo`
- Existing-game visual/art-direction polish or scoped item/UI redesign: `game-visual-polish`

## Canonical Installer

Preview a copy install:

```bash
python3 scripts/install_skill.py install \
  --agent codex \
  --skill orient-repo
```

Apply it after reviewing the source, destination, validation result, and backup root:

```bash
python3 scripts/install_skill.py install \
  --agent codex \
  --skill orient-repo \
  --apply
```

Game visual polish example:

```bash
python3 scripts/install_skill.py install \
  --agent codex \
  --skill game-visual-polish \
  --apply
```

Claude Code example:

```bash
python3 scripts/install_skill.py install \
  --agent claude \
  --skill shape-idea \
  --apply
```

Install for both agents by running one reviewed command per target:

```bash
python3 scripts/install_skill.py install --agent codex  --skill distill-ramble --apply
python3 scripts/install_skill.py install --agent claude --skill distill-ramble --apply
```

### Optional Symlink Mode

Preview first, then apply:

```bash
python3 scripts/install_skill.py install \
  --agent codex \
  --skill codex-handoff \
  --mode symlink

python3 scripts/install_skill.py install \
  --agent codex \
  --skill codex-handoff \
  --mode symlink \
  --apply
```

The installer replaces an existing destination as one entry; it does not use `ln -sfn`, which can accidentally create a nested link when the destination is already a directory.

### Non-Default Agent Home

For isolated tests or a custom home:

```bash
python3 scripts/install_skill.py install \
  --agent codex \
  --skill orient-repo \
  --agent-home /reviewed/custom/codex-home \
  --apply
```

## Read-Only Installed-State Doctor

Compare installed package versions with this checkout and report discoverable duplicates:

```bash
python3 scripts/install_skill.py doctor --agent codex
python3 scripts/install_skill.py doctor --agent claude
```

Limit the check to one package:

```bash
python3 scripts/install_skill.py doctor --agent codex --skill orient-repo
```

A non-zero result means at least one requested package is missing, stale, invalid, or duplicated. `doctor` does not modify installed files.

## Rollback

Preview restoration of the newest external backup:

```bash
python3 scripts/install_skill.py rollback \
  --agent codex \
  --skill design-repo-subagents
```

Apply after review:

```bash
python3 scripts/install_skill.py rollback \
  --agent codex \
  --skill design-repo-subagents \
  --apply
```

Use `--backup <timestamp-directory>` to select a specific backup. Backup metadata binds the record to the exact skill/destination and entry type, so rollback can restore the arbitrary directory, file, or symlink that existed before installation rather than requiring it to already be a valid skill. Before restoration, the installer backs up the current destination to a new external backup, so rollback remains reversible.

## Manual Fallback

Use this only when `scripts/install_skill.py` cannot run.

1. Confirm the package in `skills/catalog.json` targets the requested agent.
2. Run `make check-skills` or at minimum `python3 scripts/validate_skill.py <source-folder>`.
3. Choose the exact destination from the table.
4. Move any existing destination to an explicitly reviewed backup directory **outside** `<agent-home>/skills/`.
5. Copy the whole package directory with metadata preserved.
6. Confirm destination `SKILL.md` name and `VERSION` match the source.
7. Scan `<agent-home>/skills/` for other discoverable `SKILL.md` files with the same frontmatter `name`.

Do not use an adjacent `<dest>.bak.<timestamp>` directory and do not use raw `ln -sfn` over an existing directory.

## Future Skill Packages

When adding a package:

1. Put it at `skills/<family>/<skill-name>/SKILL.md`.
2. Add exactly one entry to `skills/catalog.json` with its supported targets.
3. Update human-facing indexes and examples.
4. Run `make check-skills`; `scripts/check_catalog.py` verifies discovery, versions, metadata, and root documentation registration.

Do not infer cross-agent compatibility from folder proximity. Only catalog targets and the package's own contract establish support.

## After Installing

Restart the target agent or open a fresh session so skill metadata is rediscovered. During trials, invoke the exact package name, for example:

```text
use distill-ramble
use shape-idea
use codex-init-gate
use claude-init-gate
use codex-handoff
use claude-handoff
use design-repo-subagents
use write-agents-md
use orient-repo
use game-visual-polish
```

If similarly named built-in or legacy skills remain, routing is resolver-defined. Run `doctor`, remove or relocate duplicate discoverable copies only with explicit approval, then restart the agent.
