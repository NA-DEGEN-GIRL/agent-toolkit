# Skill Behavior Scenarios

`scenarios.json` is a small forward-testing contract for high-risk routing and safety behavior. It is not an automated claim that an LLM will comply: `make all` validates scenario registration and structure, while maintainers should run selected cases in fresh agent threads after substantive SKILL.md changes.

Forward tests should give the agent the named skill and raw request/setup only. Do not leak the `expected` or `forbidden` assertions into the test prompt. Review the resulting chat, files, commands, and tool trace against those assertions.

Add or update a case when changing a trigger, approval boundary, file-write protocol, runner contract, handoff schema, or runtime delegation rule.

## Reproducible forward tests

Cases with a `fixture` field have inert input files under `fixtures/`. Prepare a
fresh temporary workspace and an assertion-free evaluator prompt:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/prepare_skill_eval.py \
  --case handoff-reference-boundaries --skill codex-handoff
```

The returned `prompt` contains only the selected skill, target repository, and
raw user request. Give **only that prompt** to a fresh agent thread without the
review conversation or the scenario assertions. Fixtures contain no real
credentials; any outside-repo link remains inside the enclosing temporary
fixture directory. Preparation never installs skills or runs fixture commands.

After the run, independently compare the answer, actual commands/file reads,
and before/after filesystem state with `expected` and `forbidden`. Record case,
variant, date/runtime, skill-file hash, observations, and pass/fail/unknown in a
reviewed result summary. Unknown or self-reported behavior is not a pass. Remove
the exact returned `fixture_root` after inspection; never commit generated
workspaces or raw traces with local paths/sensitive content. Use separate
workspaces for the Codex and Claude variants; testing a Claude skill under
Codex does not establish native Claude runtime compatibility.

`make check` runs fixture validation/materialization tests and deterministic
regressions (including executable Go gate examples). It does **not** launch
models, score agent behavior, or turn a historical manual result into a current
behavioral guarantee.

See [RESULTS.md](RESULTS.md) for reviewed observations and explicit coverage
limits from manual forward runs.
