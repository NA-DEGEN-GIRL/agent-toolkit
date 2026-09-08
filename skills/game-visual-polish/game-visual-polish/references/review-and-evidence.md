# Review and evidence contract

Read this when reviewing an implementation candidate. Scores below are workflow conventions, not externally validated benchmarks.

## Evidence packet

Give the reviewer the user's request, scope contract, selected art brief, actual baseline captures, target/reference, actual candidate captures, relevant runtime/test/performance results, and previous directives. Captures must identify scene/state, viewport, camera, render scale, and candidate revision. A filename without an inspected image is not visual evidence.

Use comparable states and settings. Do not change render scale, quality presets, resolution, or workload to make a comparison look better.

## Reviewer role

Act as a read-only game art director. Evaluate evidence, not the author's enthusiasm. Respect the chosen style; realism, glow, complexity, or added detail do not earn points by themselves. Do not edit files, expand scope, fetch production assets, or invent measurements. Missing evidence is UNKNOWN. If no independent reviewer exists, label the result SELF-REVIEW.

## Mandatory gates

| Gate | PASS requires |
| --- | --- |
| Scope | Only authorized targets/dependencies changed; protected contracts and unrelated art remain intact. |
| Integration | Relevant build/runtime checks work; assets load; checked controls/references are not broken. |
| Readability | Gameplay objects, item identities, and UI information remain legible in normal context. |
| Evidence | Real comparable runtime images were inspected; concepts are not presented as implementations. |
| Performance | Comparable measurements meet the agreed budget; missing measurements are not reported as measured. |

Return PASS, FAIL, or UNKNOWN for each gate. UNKNOWN blocks a fully verified completion claim. Design-only work is exempt from integration/performance completion gates but must stay labeled design-only.

## Quality dimensions, 0–10

Score baseline and candidate using the same applicable dimensions and one observable reason each:

- **Identity and fit:** serves this game's world, mood, visual grammar, and requested asset identity.
- **Shape and hierarchy:** silhouettes, proportions, grouping, focus, and gameplay-scale legibility.
- **Color and finish:** coherent palette/value relationships; intentional lighting, typography, line quality, and materials where applicable.
- **Craft and consistency:** style-appropriate detail, coherent families/states, and absence of visible production defects.

Anchors: 0–2 severely broken; 3–4 weak; 5–6 serviceable with substantial problems; 7 solid with gaps; 8 strong and deliberate; 9 exceptional for the intended context; 10 unusually compelling without a meaningful observed defect. A mean cannot average away a failed gate or blocking readability problem.

## Mode-specific checks

### Game or scene

Check normal and demanding play states. Verify player/enemy separation, routes/interactives, lighting readability, motion noise/occlusion, and whether claimed coverage is supported by multiple representative views.

### Asset

Review the target up close, at actual gameplay size, and in context. Check silhouette, role, material language, attachment/grip, pivot, scale, animation, clipping, and background contrast. For icons inspect real HUD/inventory size and neighboring icons. Verify shared materials/atlases did not unintentionally redesign other consumers.

### UI

Check real text, icons, spacing, hierarchy, focus/selection/disabled states, supported input modes, long labels, dense content, relevant screen sizes, safe areas, hit regions, clipping, and scroll behavior. A generated menu image is not a working menu.

## Review output

```text
REVIEW: INDEPENDENT | SELF-REVIEW
GATES: scope=... integration=... readability=... evidence=... performance=...
QUALITY: baseline -> candidate, by applicable dimension; one reason each
PREVIOUS DIRECTIVES: resolved | partly resolved | unresolved | out of scope
BLOCKERS: at most 3, each with location, visible problem, proposed fix, expected effect
UNINTENDED CHANGES: target/shared dependency; evidence
COVERAGE / UNKNOWN: tested states and missing evidence
VERDICT: accept | revise | blocked | budget reached
```

Keep actions implementable inside scope. Carry unresolved directives forward and reverse prior advice only when new evidence shows it made the result worse.
