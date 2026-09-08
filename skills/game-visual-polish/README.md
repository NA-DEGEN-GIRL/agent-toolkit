# Game Visual Polish Skill Family

The game-visual-polish family improves the visual presentation of an **existing game** without turning a scoped art request into a gameplay rewrite. It can handle broad game art-direction polish, a single scene, selected assets/items, or UI-only work.

## Variants

| Variant | Target | Use when |
|---|---|---|
| `game-visual-polish` | Codex | Improve existing game graphics, atmosphere, UI, or selected assets while preserving gameplay and the requested scope |

The package is currently registered for Codex only. It is instruction-only: image generation, Blender, runtime capture, and subagents are optional host capabilities rather than bundled dependencies.

## Install

Read the root [`INSTALL.md`](../../INSTALL.md). Source folder:

```text
skills/game-visual-polish/game-visual-polish
```

## Usage

Read [`USAGE.md`](USAGE.md) for whole-game, item-only, UI-only, and design-only examples.

## Provenance

This is an unofficial adaptation of Anshu Chimala's MIT-licensed [`achimala/dream-loop`](https://github.com/achimala/dream-loop). The original implementation/visual-target/review-loop idea is retained, while the workflow is rewritten around genre-sensitive art direction, bounded changes to existing games, actual gameplay-size review, and gameplay-preservation rules. Upstream license and provenance are included in the installable package.
