#!/usr/bin/env python3
"""Verify repo-bootstrap packages stay aligned without overfitting wording."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FAMILY = Path(__file__).resolve().parents[1]
PACKAGES = {
    "codex-init-gate": (FAMILY / "codex-init-gate", "Codex"),
    "claude-init-gate": (FAMILY / "claude-init-gate", "Claude Code"),
}
REFS = [
    "references/llm-debuggable-code.md",
    "references/gate-contract.md",
    "references/safety-workflow.md",
    "references/stack-presets.md",
]
CRITICAL_REF_LITERALS = {
    "references/gate-contract.md": [
        ".DEFAULT_GOAL := check",
        "git ls-files -z -- '*.go'",
        "Empty Repos And Unknown Stacks",
        "exactly one selected canonical runner",
        "Make-only template",
        "Check-Only State Contract",
        "tracked source, tests, configuration",
        "frozen/locked dependency resolution",
        "Verification Report",
    ],
    "references/safety-workflow.md": [
        "Two Approval Gates",
        "No-write does not mean no-execute",
        "$(shell ...)",
        "before any related file write",
        "`repo_state` is `empty-repo`",
        "Check-Only Evidence",
        "offline/no-network flags",
        "pull_request_target",
        "Verification Reporting",
    ],
    "references/stack-presets.md": [
        "If no stack is detectable",
        "Do not use `gofmt -l $$(git ls-files '*.go')`",
        "Make snippets below apply only when Make is selected",
        "frozen/locked and offline/no-network options",
        "Monorepo Pattern",
        "roughly 300 lines per file",
    ],
    "references/llm-debuggable-code.md": [
        "The gate can strongly support question 3",
        "`repo_state` is `empty-repo`",
        "Potentially enforce only when",
        "tracked source/config/lockfiles must not change",
        "Advisory findings live in the bootstrap report by default",
        "do not create directories, source files, test skeletons",
    ],
}
READ_FAILURES: set[Path] = set()


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        if path not in READ_FAILURES:
            print(f"FAIL cannot read {path}: {exc.__class__.__name__}: {exc}")
            READ_FAILURES.add(path)
        return ""


def digest_bytes(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        if path not in READ_FAILURES:
            print(f"FAIL cannot read bytes {path}: {exc.__class__.__name__}: {exc}")
            READ_FAILURES.add(path)
        return ""


def normalize_skill(text: str) -> str:
    """Keep the two SKILL bodies equivalent except known agent-specific bits."""
    text = re.sub(r"^---\n.*?\n---\n", "---FRONTMATTER---\n", text, flags=re.S)
    replacements = {
        "codex-init-gate": "AGENT-init-gate",
        "claude-init-gate": "AGENT-init-gate",
        "Codex-specific": "AGENT-specific",
        "Claude Code-specific": "AGENT-specific",
        "Codex self-correct loop": "AGENT self-correct loop",
        "Claude Code self-correct loop": "AGENT self-correct loop",
        "Codex operating rule": "AGENT operating rule",
        "Claude Code operating rule": "AGENT operating rule",
        "`CLAUDE.md` or `AGENTS.md`": "`AGENTS.md`",
        "Codex": "AGENT",
        "Claude Code": "AGENT",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return re.sub(
        r"^6\. \*\*AGENT self-correct loop\.\*\* .*$",
        "6. **AGENT self-correct loop.** <agent-specific>",
        text,
        flags=re.M,
    ).strip() + "\n"


def parse_openai_prompt(path: Path) -> str:
    match = re.search(r'^  default_prompt: "([^"]+)"$', read(path), flags=re.M)
    return match.group(1) if match else ""


def require(condition: bool, message: str) -> bool:
    if condition:
        print(f"OK {message}")
        return False
    print(f"FAIL {message}")
    return True


def missing_literals(text: str, literals: list[str]) -> list[str]:
    return [literal for literal in literals if literal not in text]


def main() -> int:
    failed = False
    version = read(ROOT / "VERSION").strip()
    failed |= require(bool(re.fullmatch(r"\d+\.\d+\.\d+", version)), f"root VERSION {version}")

    family_files = [FAMILY / "README.md", FAMILY / "USAGE.md", FAMILY / "EVALS.md"]
    for path in family_files:
        failed |= require(path.is_file(), f"exists {path.relative_to(ROOT)}")

    skill_hashes: dict[str, str] = {}
    for skill_name, (package, agent) in PACKAGES.items():
        required = [package / "SKILL.md", package / "VERSION", package / "agents/openai.yaml"]
        required += [package / ref for ref in REFS]
        for path in required:
            failed |= require(path.is_file(), f"exists {path.relative_to(ROOT)}")
        if not (package / "SKILL.md").is_file():
            continue

        failed |= require(read(package / "VERSION").strip() == version, f"{skill_name} VERSION matches root")
        skill = read(package / "SKILL.md")
        missing = missing_literals(
            skill,
            [
                f"name: {skill_name}",
                f"# {skill_name}",
                f"**Skill Version:** {version}",
                agent,
                "empty-repo",
                "Classify two independent axes",
                "`repo_state`",
                "`operation`",
                "Create or update a `Makefile` only when Make was selected",
                "before any related write",
                "frozen/locked dependency resolution",
                "approved ignored caches or build outputs",
                "tracked source, config, and lockfiles",
                "separate, user-approved persistence handoff",
                "do not blanket-load all files",
                "idempotency evidence",
                "write-agents-md",
                *REFS,
            ],
        )
        failed |= require(not missing, f"{skill_name} SKILL core literals" + (f" missing {missing}" if missing else ""))
        forbidden = [
            "Classify the mode",
            "Create or update conventional config plus a fail-closed `Makefile`",
        ]
        present = [literal for literal in forbidden if literal in skill]
        failed |= require(not present, f"{skill_name} resolved old mode/Makefile contract" + (f" unexpected {present}" if present else ""))
        prompt = parse_openai_prompt(package / "agents/openai.yaml")
        failed |= require(
            f"${skill_name}" in prompt
            and "LLM-debuggable" in prompt
            and "selected canonical runner" in prompt
            and "approval" in prompt,
            f"{skill_name} openai default_prompt fresh",
        )
        skill_hashes[skill_name] = hashlib.sha256(normalize_skill(skill).encode()).hexdigest()

    failed |= require(len(set(skill_hashes.values())) <= 1, f"normalized SKILL parity {skill_hashes}")

    codex = PACKAGES["codex-init-gate"][0]
    claude = PACKAGES["claude-init-gate"][0]
    for rel in REFS:
        left, right = codex / rel, claude / rel
        if left.is_file() and right.is_file():
            failed |= require(digest_bytes(left) == digest_bytes(right), f"shared reference {rel}")
            missing = missing_literals(read(left), CRITICAL_REF_LITERALS[rel])
            failed |= require(not missing, f"critical literals {rel}" + (f" missing {missing}" if missing else ""))

    family_literals = {
        "README.md": [
            "one selected canonical check path",
            "`empty-repo`, `fresh-repo`, `existing-repo`",
            "A `Makefile` is created only when Make is selected",
            "Approved ignored caches/build outputs",
            "handoff to `write-agents-md`",
            "EVALS.md",
        ],
        "USAGE.md": [
            "`repo_state: empty-repo`",
            "`operation: verify-only`",
            "Keep an existing non-Make runner",
            "frozen/locked and offline/no-network",
        ],
        "EVALS.md": [
            "Empty directory + scaffold request",
            "Existing `just check`",
            "Check rewrites lockfile",
            "Claude hook/settings proposal",
        ],
    }
    for rel, literals in family_literals.items():
        missing = missing_literals(read(FAMILY / rel), literals)
        failed |= require(not missing, f"family contract {rel}" + (f" missing {missing}" if missing else ""))

    failed |= bool(READ_FAILURES)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
