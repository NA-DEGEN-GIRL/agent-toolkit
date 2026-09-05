#!/usr/bin/env python3
"""Execute the published Go Make recipes in inert, isolated Git fixtures."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


FAMILY = Path(__file__).resolve().parents[1]
REFERENCES = [
    FAMILY / variant / "references" / reference
    for variant in ("codex-init-gate", "claude-init-gate")
    for reference in ("gate-contract.md", "stack-presets.md")
]


def extract_recipe(path: Path) -> str:
    blocks = re.findall(r"^[ ]*```makefile\n(.*?)^[ ]*```", path.read_text(), re.M | re.S)
    return next(textwrap.dedent(block) for block in blocks if "fmt-go:" in block)


class GoFormatRecipeTests(unittest.TestCase):
    def run_recipe(self, reference: Path, case: str) -> tuple[subprocess.CompletedProcess[str], list[str] | None]:
        with tempfile.TemporaryDirectory(prefix="go-format-recipe-") as raw:
            root = Path(raw)
            tools = root / "bin"
            tools.mkdir()
            # No inherited gofmt, Git config, hooks, or credential helpers. The
            # fake formatter intentionally needs no Go installation or network.
            for name in ("make", "git", "mktemp", "rm", "xargs", "cat"):
                executable = shutil.which(name)
                self.assertIsNotNone(executable, f"fixture requires {name}")
                (tools / name).symlink_to(executable)
            env = {
                **os.environ,
                "PATH": str(tools),
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_COUNT": "0",
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_OPTIONAL_LOCKS": "0",
            }
            for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
                env.pop(name, None)
            subprocess.run(["git", "-c", "init.templateDir=", "init", "-q", str(root)], env=env, check=True)
            (root / "Makefile").write_text(extract_recipe(reference))
            if case != "no-files":
                names = ["space name.go", "-leading.go"] if case == "names" else ["main.go"]
                for name in names:
                    (root / name).write_text("invalid Go\n" if case == "invalid" else "package main\n")
                subprocess.run(["git", "add", "--", *names], cwd=root, env=env, check=True)
            report = root / "formatter-args.json"
            if case != "missing-tool":
                fake = tools / "gofmt"
                fake.write_text(
                    f"#!{sys.executable}\n"
                    "import json, pathlib, sys\n"
                    f"pathlib.Path({str(report)!r}).write_text(json.dumps(sys.argv[1:]))\n"
                    "assert sys.argv[1:3] == ['-l', '--']\n"
                    f"case = {case!r}\n"
                    "if case == 'formatter-error':\n"
                    "    print('synthetic formatter failure', file=sys.stderr); sys.exit(2)\n"
                    "for name in sys.argv[3:]:\n"
                    "    content = pathlib.Path(name).read_text()\n"
                    "    if content.startswith('invalid'):\n"
                    "        print('synthetic Go parse error', file=sys.stderr); sys.exit(2)\n"
                    "    if case == 'unformatted': print(name)\n"
                )
                fake.chmod(0o755)
            if case == "git-error":
                shutil.rmtree(root / ".git")
            result = subprocess.run(["make", "fmt-go"], cwd=root, env=env, text=True, capture_output=True, timeout=10)
            return result, json.loads(report.read_text()) if report.exists() else None

    def test_published_recipes(self) -> None:
        for reference in REFERENCES:
            for case in ("missing-tool", "formatter-error", "invalid", "unformatted", "git-error", "no-files", "names"):
                with self.subTest(reference=str(reference.relative_to(FAMILY)), case=case):
                    result, arguments = self.run_recipe(reference, case)
                    if case in {"names", "no-files"}:
                        self.assertEqual(result.returncode, 0, result.stderr)
                    else:
                        self.assertNotEqual(result.returncode, 0, f"{case} passed incorrectly")
                    if case == "no-files":
                        self.assertIsNone(arguments, "formatter ran without tracked Go files")
                    elif case == "names":
                        self.assertEqual(arguments, ["-l", "--", "-leading.go", "space name.go"])


if __name__ == "__main__":
    unittest.main()
