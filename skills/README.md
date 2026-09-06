# Skills Index

This directory contains installable skill packages grouped by skill family. `catalog.json` is the machine-readable registry for package names, source folders, and supported target agents.

## Available Families

| Family | Purpose | Variants | Version | Docs |
|---|---|---|---|---|
| `idea-shaping` | Distill raw thoughts into idea seeds, then shape them into user-confirmed Design Briefs before planning | `distill-ramble`, `shape-idea` | `0.1.11` | [`idea-shaping/README.md`](idea-shaping/README.md), [`idea-shaping/USAGE.md`](idea-shaping/USAGE.md) |
| `repo-bootstrap` | Bootstrap deterministic, LLM-debuggable repo quality gates before feature work | `codex-init-gate`, `claude-init-gate` | `0.1.11` | [`repo-bootstrap/README.md`](repo-bootstrap/README.md), [`repo-bootstrap/USAGE.md`](repo-bootstrap/USAGE.md) |
| `handoff` | Requested repo-local checkpoints and file handoffs; independent of native compaction/session resume | `codex-handoff`, `claude-handoff` | `0.1.11` | [`handoff/README.md`](handoff/README.md), [`handoff/USAGE.md`](handoff/USAGE.md) |
| `subagents` | Design and operate repo-specific Codex subagent delegation plans | `design-repo-subagents` | `0.1.11` | [`subagents/README.md`](subagents/README.md), [`subagents/USAGE.md`](subagents/USAGE.md) |
| `repo-instructions` | Draft/review repo-local AGENTS.md instructions from repo facts | `write-agents-md` | `0.1.11` | [`repo-instructions/README.md`](repo-instructions/README.md), [`repo-instructions/USAGE.md`](repo-instructions/USAGE.md) |
| `repo-orientation` | Produce a read-only orientation report including quality gates, decision docs, and selected handoff context | `orient-repo` | `0.1.11` | [`repo-orientation/README.md`](repo-orientation/README.md), [`repo-orientation/USAGE.md`](repo-orientation/USAGE.md) |

## Layout Convention

```text
skills/<family>/
├── README.md          # family overview
├── USAGE.md           # prompt examples when useful
├── scripts/           # optional family-level maintenance checks
├── <agent-skill>/     # installable skill package
│   ├── SKILL.md
│   ├── VERSION
│   ├── agents/openai.yaml
│   ├── references/
│   └── scripts/
└── ...
```

Discovery and documentation rules for adding future skills:

1. Put each new family under `skills/<family>/`.
2. Put each installable package under `skills/<family>/<skill-name>/` where folder name equals `SKILL.md` frontmatter `name`.
3. Register the package and target agents in `skills/catalog.json`, then update this index and root `README.md` / `INSTALL.md`.
4. A package is discovered by `make all` only at the exact `skills/<family>/<skill-name>/SKILL.md` depth.
5. Use `README.md` for family overview and `USAGE.md` for concrete prompt/install/operation examples when needed.
6. Add tests or validation commands when the skill ships scripts.
7. Put family-only sync checks under `skills/<family>/scripts/check_*_sync.py`.
8. Run `make all` before committing.
