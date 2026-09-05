# Stack Presets

Choose commands from actual repo manifests and lockfiles. Prefer existing repo-local scripts over these candidates. The table values are candidates, not automatic requirements. Put them on the selected canonical runner. If the repo already uses `just`, `task`, package scripts, or another runner, avoid creating a divergent command surface; use that runner directly or add an explicitly approved thin wrapper. The Make snippets below apply only when Make is selected.

If no stack is detectable, classify `repo_state` as `empty-repo` and stop to ask for the intended language/runner instead of emitting a finished placeholder gate.

| Stack | fmt check | fmt apply | lint | typecheck | test |
|---|---|---|---|---|---|
| Rust | `cargo fmt --check` | `cargo fmt` | `cargo clippy --all-targets --all-features -- -D warnings` after execution approval | `cargo check --all-targets --all-features` when useful; otherwise document clippy's compile coverage | `cargo test --all` after reviewing build scripts/proc macros |
| Python | repo script, `uv run ruff format --check .`, or `python -m ruff format --check .` when installed | matching `ruff format` apply command | repo script or approved Ruff/Pylint/import-linter config | repo script or approved `mypy --strict`/Pyright config | repo script or `python -m pytest` after reviewing test hooks |
| TS / JS | repo script or `prettier --check .` with ignore config | matching `prettier --write` apply command | repo script or approved ESLint config with `--max-warnings=0` | repo script or `tsc --noEmit` | repo script, `vitest`, or `jest` after reviewing lifecycle scripts |
| Go | use the safe Go recipe below | `gofmt -w` on selected tracked Go files | approved `golangci-lint run` or `go vet ./...` as lint | `go build ./...` | `go test ./...` after execution approval |
| Other | standard formatter in check mode | standard formatter apply command | strictest practical approved linter | strictest practical static check | standard test runner after review |

Where supported, add the ecosystem's frozen/locked and offline/no-network options without changing the command's intended coverage. Examples include Cargo `--locked` / `--offline` for commands that resolve dependencies and package-manager frozen-lockfile/offline modes. Do not guess flags: confirm them for the detected tool/version. A missing local dependency that requires download is a separately approved install/network step, not a reason for `check` to update a lockfile.

## Safe Go Formatting Recipe

Use NUL-delimited tracked files and `--` to avoid spaces, leading dashes, and shell word splitting:

```makefile
fmt-go: ## check Go formatting
	@tmp="$$(mktemp -d)" || exit 1; trap 'rm -rf "$$tmp"' EXIT; \
	git ls-files -z -- '*.go' > "$$tmp/files" || exit "$$?"; \
	if test -s "$$tmp/files"; then \
		xargs -0 gofmt -l -- < "$$tmp/files" > "$$tmp/output" || exit "$$?"; \
		test ! -s "$$tmp/output" || { cat "$$tmp/output"; exit 1; }; \
	fi
```

Do not use `gofmt -l $$(git ls-files '*.go')`; it splits filenames and can fail open.

Check both file-list generation and formatter exit status, not just formatter stdout: missing tools and invalid Go may report errors only on stderr. This recipe deliberately checks tracked files only; an empty tracked Go set succeeds without invoking the formatter. Include new files in the selected gate scope before relying on that result.

## Monorepo Pattern

For polyglot repos, prefer per-stack subtargets and aggregate them. This example is Make-specific; express the same mapping in the selected runner otherwise:

```makefile
fmt: fmt-python fmt-web fmt-go
lint: lint-python lint-web lint-go
typecheck: typecheck-python typecheck-web typecheck-go
test: test-python test-web test-go
check: fmt lint typecheck test
```

Default `make` behavior is fail-fast. If the user needs report-all behavior, create a separate explicitly named target such as `check-report` rather than changing `check` semantics silently.

## LLM-Debuggable Enforcement Hints

These are not automatic requirements. Enforce only after the user approves the tools/config needed to make them real:

- Python: Ruff can cover formatting and some complexity rules, but file length/import boundaries may require Pylint, import-linter, or custom dependency checks. Many strict rules are off by default.
- TS / JS: ESLint `complexity`, `max-lines`, `max-lines-per-function`, import boundary plugins, or dependency-cruiser must be explicitly configured; they are not built-in defaults.
- Rust: Clippy deny warnings is useful, but line-length or architecture boundaries may remain advisory unless configured with project-specific rules.
- Go: `golangci-lint` can enable `gocyclo`/`funlen`, while `go vet` is lint-like and `go build` is the closest type/static check.

## Caveats

- Do not install tools automatically; list exact installs and wait for approval.
- Prefer pinned dev dependencies, lockfiles, or toolchain files over floating latest installs.
- Check-only commands must preserve tracked source/config/lockfiles. Expected ignored caches or build outputs are allowed only when approved and reported with before/after evidence.
- If no tests exist, do not fake a passing `test` target. Create an actionable failing target or ask whether to scaffold a minimal test.
- File length, function length, complexity, and import-boundary thresholds are defaults, not sacred constants. If examples are needed, start discussion around small-review-unit limits such as roughly 300 lines per file, 50 lines per function, and moderate complexity caps, then adapt to the stack and team. If a project needs a temporary baseline, label it as temporary and keep the future strict gate visible.
- Fresh repos should not be paralyzed by every strict rule at once. Propose an explicit ramp-up profile only when full strict mode blocks exploration, and do not present that as equivalent to the final gate.
- For monorepos, prefer per-package commands aggregated by the canonical check path; do not let one stack's formatter rewrite unrelated generated/vendor directories.
- Treat architecture-quality guidance such as pure-core/IO-shell separation as advisory unless the repo already has tooling to enforce it safely.
