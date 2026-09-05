.DEFAULT_GOAL := all
.PHONY: all check check-skills setup-mcps check-mcps audit-mcps validate syntax-check test sync-check
.NOTPARALLEL: all check check-skills setup-mcps check-mcps

LOCAL_VALIDATOR ?= ./scripts/validate_skill.py
EXTERNAL_VALIDATOR ?= $(HOME)/.codex/skills/.system/skill-creator/scripts/quick_validate.py
PYTHON ?= python3
NPM ?= npm
ENV := PYTHONDONTWRITEBYTECODE=1
SKILL_DIRS := $(shell find skills -mindepth 3 -maxdepth 3 -name SKILL.md -exec dirname {} \; | sort)
MCP_NODE_DIRS := $(shell find mcp-servers -mindepth 2 -maxdepth 2 -type f -name package.json -exec dirname {} \; | sort)
# A skill package is exactly skills/<family>/<name>/SKILL.md.
# Family-specific maintenance checks live under skills/<family>/scripts/check_*_sync.py.
PY_FILES := $(shell find skills scripts -name '*.py' -type f | sort)
TEST_FILES := $(shell { find scripts -maxdepth 1 -name 'test_*.py' -type f; find skills -path '*/scripts/test_*.py' -type f; } | sort)
SYNC_CHECKS := $(shell { find scripts -maxdepth 1 -name 'check_*.py' -type f; find skills -path '*/scripts/check_*_sync.py' -type f; } | sort)

all: check

# Keep dependency setup separate so the canonical gate remains check-only.
check: check-skills check-mcps

# Preserve a Node-free gate for skill-only work and the Python catalog checks.
check-skills: validate syntax-check test sync-check

setup-mcps:
	@if [ -z "$(MCP_NODE_DIRS)" ]; then \
		echo "INFO: no Node MCP packages found"; \
	else \
		for mcp_dir in $(MCP_NODE_DIRS); do \
			echo "$(NPM) --prefix $$mcp_dir ci --ignore-scripts"; \
			$(NPM) --prefix "$$mcp_dir" ci --ignore-scripts || exit 1; \
		done; \
	fi

check-mcps:
	@if [ -z "$(MCP_NODE_DIRS)" ]; then \
		echo "INFO: no Node MCP packages found"; \
	else \
		for mcp_dir in $(MCP_NODE_DIRS); do \
			if [ ! -d "$$mcp_dir/node_modules" ]; then \
				echo "ERROR: missing dependencies for $$mcp_dir; run 'make setup-mcps' first" >&2; \
				exit 1; \
			fi; \
			echo "$(NPM) --prefix $$mcp_dir test"; \
			$(NPM) --prefix "$$mcp_dir" test || exit 1; \
		done; \
	fi

# Registry-backed security checks are deliberately separate from make check.
# This needs network access, but neither installs nor modifies locked packages.
audit-mcps:
	@for mcp_dir in $(MCP_NODE_DIRS); do \
		echo "$(NPM) --prefix $$mcp_dir audit --package-lock-only --ignore-scripts --audit-level=low"; \
		$(NPM) --prefix "$$mcp_dir" audit --package-lock-only --ignore-scripts --audit-level=low || exit 1; \
	done

validate:
	$(ENV) $(PYTHON) $(LOCAL_VALIDATOR) $(SKILL_DIRS)
	@if [ -f "$(EXTERNAL_VALIDATOR)" ]; then \
		for skill_dir in $(SKILL_DIRS); do \
			$(ENV) $(PYTHON) $(EXTERNAL_VALIDATOR) $$skill_dir || exit 1; \
		done; \
	else \
		echo "INFO: external validator not found at $(EXTERNAL_VALIDATOR); local validator already ran"; \
	fi

syntax-check:
	$(ENV) $(PYTHON) ./scripts/syntax_check.py $(PY_FILES)

test:
	@for test_file in $(TEST_FILES); do \
		echo "$(ENV) $(PYTHON) $$test_file"; \
		$(ENV) $(PYTHON) $$test_file || exit 1; \
	done

sync-check:
	@if [ -z "$(SYNC_CHECKS)" ]; then \
		echo "INFO: no family sync checks found"; \
	else \
		for check in $(SYNC_CHECKS); do \
			echo "$(ENV) $(PYTHON) $$check"; \
			$(ENV) $(PYTHON) $$check || exit 1; \
		done; \
	fi
