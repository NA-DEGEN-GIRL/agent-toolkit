# Lightweight run templates

These are working-note formats, not a questionnaire for the user. Fill them from the request and project evidence. Omit irrelevant fields.

## scope.md

```text
Request:
Mode: game | scene | asset | ui | design-only
Targets: object IDs, asset paths, scenes/screens; confirmed from evidence
Allowed changes:
Protected behavior and visual identifiers:
Shared dependencies: permitted consumers; isolation strategy
External asset policy: existing project assets/original authoring by default
Capabilities: source, runtime, capture/vision, image generation, 3D, reviewer
Performance: project target or provisional baseline-relative guard
Budget: at most 3 total implementation/review rounds unless overridden
Acceptance: visible result, test coverage, and scope inventory
```

## art-direction.md

```text
Project/game identity and evidence:
Visible problems to solve:
Selected direction and distinctive motif:
Why it fits this game's play experience:
References actually inspected: source URL, observation, adaptation (not copying)
Palette roles and value hierarchy:
Shape language and density:
Material/texture/line treatment:
Lighting and atmosphere:
UI/type rules where relevant:
Keep recognizable:
Avoid:
Engine/platform limits:
Actual-size acceptance examples:
```

## Target-generation instruction

```text
Use the attached real game capture as the structural starting point.
Improve only: [targets and allowed visual dependencies].
Preserve: [camera, layout, object identity, functional UI, and protected regions].
Art direction: [selected brief, not a generic realism request].
Output: a plausible real-time in-engine view in that art style at [aspect/size].
Respect: [platform/rendering limits and gameplay readability].
At normal gameplay size, the key improvement should be: [observable result].
Avoid: [style drift, clutter, unreadable text, excessive effects, impossible detail].
This is a visual target, not evidence of implemented code or a validated game asset.
```

## evidence.md

```text
Environment: OS/device/GPU when known; engine/browser; renderer
Run/build/test commands actually executed:
Baseline: capture paths, scene/state, camera, viewport, scale/quality, seed
Candidate: capture paths and corresponding settings
Performance: workload, measurement method, median/p95 frame time, measured FPS when available
Checks: pass/fail/not run, with logs or evidence paths
Changed assets/files:
Untargeted control captures when shared dependencies changed:
Coverage: requested / completed / unverified / remaining
Review type: independent / self-review / unavailable
```

## final-report.md

```text
Direction and changes: one short paragraph
Before/after: actual captures or paths; distinguish concepts
Implementation: main changed files/assets
Verification: executed checks, measured performance/environment, known limits
Coverage: completed and remaining work
```
