# Gate Contract

Use this contract when creating or reviewing a repo-bootstrap gate.

## Canonical Runner

Put this contract on exactly one selected canonical runner. Prefer `make check` as a portable interface when Make fits the repo. If the repo already standardizes on `just`, `task`, package-manager scripts, or a Windows-first workflow, use that runner's equivalent targets directly. Create a `Makefile` only when Make is selected, or when the user approves a thin wrapper that delegates to the established runner; do **not** create a divergent command surface merely to match the examples below. Record the mapping, such as `make check`, `just check`, `task check`, or `pnpm check`.

## Empty Repos And Unknown Stacks

If no language, manifest, package manager, or runner is detectable, classify `repo_state` as `empty-repo`; this is independent from the requested `operation`. Do not treat fail-closed placeholder targets as a completed gate. Ask the user which stack/runner to target, or explicitly label any placeholder-only output as incomplete and awaiting stack selection. Do not create source/test skeletons just to make the gate pass.

## Required Gate Capabilities

The semantic capabilities are the stable contract: setup (separate from checking), formatting check, formatting apply (separate and modifying), lint, type/static check, tests, and one aggregate check path. Prefer the names `setup`, `fmt`, `fmt-apply`, `lint`, `typecheck`, `test`, and `check` where the runner supports named targets/scripts. Do not copy empty no-op targets; placeholder targets must fail closed until replaced with stack-specific commands.

The following is a **Make-only template**. Use it only when Make is the selected runner or approved thin wrapper. Translate the same fail-closed semantics into the established runner otherwise.

```makefile
.DEFAULT_GOAL := check
.PHONY: help setup fmt fmt-apply lint typecheck test check
.NOTPARALLEL: check

help:
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "%-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## install or prepare local tools only after explicit approval
	@echo "ERROR: setup is not configured" >&2; exit 1

fmt: ## check formatting; must not modify tracked files
	@echo "ERROR: fmt check is not configured" >&2; exit 1

fmt-apply: ## apply formatting; must require explicit user intent
	@echo "ERROR: fmt-apply is not configured" >&2; exit 1

lint: ## fail on approved lint, complexity, file-length, or import-boundary violations
	@echo "ERROR: lint is not configured" >&2; exit 1

typecheck: ## run the strictest practical type/static check
	@echo "ERROR: typecheck is not configured" >&2; exit 1

test: ## run the test suite
	@echo "ERROR: test is not configured" >&2; exit 1

check: fmt lint typecheck test ## full tracked-state-preserving gate
	@echo "✓ all checks passed"
```

`setup` may install or prepare local tools only when explicitly documented and approved. `check` must be deterministic, non-interactive, and check-only. `.NOTPARALLEL: check` avoids surprising parallel prerequisite output when users run `make -j check`.

## Check-Only State Contract

“Check-only” means the canonical check must not change tracked source, tests, configuration, generated files committed to git, or lockfiles. It may create only expected, approved ignored caches or build outputs required by the toolchain (for example `.pytest_cache/` or `target/`), and those outputs must be named in the plan/report. It must not run format-apply, code generation that rewrites tracked output, dependency updates, migrations, or interactive setup.

Verify this with before/after evidence rather than assuming a tool's `check` label is honest:

- capture tracked status/diff and relevant config/lockfile hashes before execution;
- run only the reviewed canonical path after approval;
- compare the same evidence afterward, and when practical run twice to expose nondeterminism;
- report approved ignored caches/build outputs separately; a tracked change is a gate-contract failure even if tests pass.

Prefer frozen/locked dependency resolution and offline/no-network modes where supported. A check must not refresh or rewrite a lockfile. If dependencies are not already available and a network fetch is unavoidable, disclose it and obtain execution/install approval rather than silently relaxing frozen/offline behavior.

## Check-Only Formatting

Do not put modifying formatters in `fmt` or `check`:

- Good simple examples: `cargo fmt --check`, `ruff format --check`, `prettier --check .`.
- Safe Go Makefile recipe for tracked `.go` files, including spaces and leading dashes:

```makefile
fmt-go: ## check Go formatting
	@tmp="$$(mktemp -d)" || exit 1; trap 'rm -rf "$$tmp"' EXIT; \
	git ls-files -z -- '*.go' > "$$tmp/files" || exit "$$?"; \
	if test -s "$$tmp/files"; then \
		xargs -0 gofmt -l -- < "$$tmp/files" > "$$tmp/output" || exit "$$?"; \
		test ! -s "$$tmp/output" || { cat "$$tmp/output"; exit 1; }; \
	fi
```

- In Makefile recipes, shell command substitution must use `$$`, e.g. `$$(...)`; plain `$(...)` is consumed by Make and can turn a check into an always-pass command.
- Check file-list and formatter exit status independently; missing tools or parse errors may leave stdout empty. The Go example checks tracked files only and skips the formatter when that set is empty.
- Do not expand NUL-delimited file lists into unquoted shell words. Use `git ls-files -z` with `xargs -0` (and `--` when the tool accepts it) or an equivalent script.
- Apply commands belong in `fmt-apply`, e.g. `cargo fmt`, `ruff format`, `prettier --write .`, or `gofmt -w` on selected files.
- Before running `fmt-apply` or any tree-wide formatter/codegen, require a clean working tree or explicit user approval plus a rollback plan.

## Existing Targets And Monorepos

- If `Makefile` or another runner already has `test`, `lint`, or `check` with project-specific meaning, do not overwrite silently. Preserve existing targets, wrap them, or add clearly named subtargets such as `test-python`, `lint-web`, `check-go`.
- For polyglot/monorepo projects, define per-stack subtargets and aggregate them in the canonical `check`. State whether the chosen gate is fail-fast (default) or report-all.
- Generated/vendor/build-output directories must be excluded through the stack's normal ignore mechanism before the gate is considered ready.

## Fail-Closed Rules

- Empty targets must fail with a clear message, not pass silently.
- If a stack cannot support a target, use the closest approved equivalent or print an actionable error and exit non-zero.
- Lint should fail, not warn, for configured violations.
- Type checking should use strict mode where practical, but fresh repos may use an explicitly named ramp-up profile if strict mode blocks initial exploration.
- Tests should be real tests; placeholder tests should fail or be clearly reported as missing. A green suite with trivial assertions is not proof of correctness.

## LLM-Debuggable Checks

Connect LLM-friendly structure to the gate only where tooling can enforce it reliably and the user approves required tools/config:

- file length limits
- function length limits
- cyclomatic or cognitive complexity
- import/dependency boundaries
- strict type/static checks
- coverage or test-quality thresholds when the stack has a real test suite

If a rule is valuable but not reliably enforceable in the stack, keep it in the plan/report as advisory instead of creating a brittle failing check.

## Existing Repositories, Baselines, And Self-Correction

For mature repos, default to a no-regression or report-first plan if strict enforcement would create a large unrelated cleanup. A baseline/ramp-up profile is valid only when it has a stable capture command, a stored or documented baseline, and a clear rule such as "no new violations in touched files". When `repo_state` is `existing-repo`, the self-correct loop may fix only the approved owned scope; if legacy violations outside that scope keep the gate red, stop and report instead of attempting broad cleanup.

## Verification Report

After approved execution, report enough structure for another LLM to continue without rereading the whole session: `repo_state`, `operation`, runner/mapping, files changed and backups, commands reviewed/run, gate result, before/after and idempotency evidence, approved ignored outputs, enforceable-now versus advisory rules, reproduction path, edit boundary, and deferred approvals or risks. When practical, run the canonical check twice and compare tracked state before/after to catch mutating or nondeterministic targets.
