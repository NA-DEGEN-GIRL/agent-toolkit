#!/usr/bin/env python3
"""Validate behavior-scenario structure and package coverage."""
from __future__ import annotations

import json
import re
import argparse
from pathlib import Path

from prepare_skill_eval import validate_fixture


ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = ROOT / "evals" / "scenarios.json"
CATALOG = ROOT / "skills" / "catalog.json"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def check(condition: bool, message: str) -> bool:
    print(("OK " if condition else "FAIL ") + message)
    return not condition


def validate(scenarios_path: Path, catalog_path: Path) -> int:
    failed = False
    try:
        scenarios = json.loads(scenarios_path.read_text(encoding="utf-8"))
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"FAIL cannot load eval/catalog JSON: {exc}")
        return 1

    if not isinstance(scenarios, dict) or not isinstance(catalog, dict):
        print("FAIL eval and catalog JSON must be objects")
        return 1

    failed |= check(scenarios.get("schema_version") == 1, "eval schema_version is 1")
    cases = scenarios.get("cases")
    if not isinstance(cases, list):
        print("FAIL eval cases must be a list")
        return 1

    raw_packages = catalog.get("packages", []) if isinstance(catalog, dict) else []
    known = {
        item["name"]
        for item in raw_packages
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    covered: set[str] = set()
    ids: list[str] = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            failed |= check(False, f"case #{index} is an object")
            continue
        case_id = case.get("id", "")
        id_valid = isinstance(case_id, str) and bool(ID_RE.fullmatch(case_id))
        if isinstance(case_id, str):
            ids.append(case_id)
        skills = case.get("skills", [])
        expected = case.get("expected", [])
        forbidden = case.get("forbidden", [])
        skills_valid = (
            isinstance(skills, list)
            and bool(skills)
            and all(isinstance(value, str) and bool(value.strip()) for value in skills)
        )
        expected_valid = (
            isinstance(expected, list)
            and bool(expected)
            and all(isinstance(value, str) and bool(value.strip()) for value in expected)
        )
        forbidden_valid = (
            isinstance(forbidden, list)
            and bool(forbidden)
            and all(isinstance(value, str) and bool(value.strip()) for value in forbidden)
        )
        failed |= check(id_valid, f"eval id {case_id!r}")
        failed |= check(skills_valid, f"{case_id!r} names non-empty string skills")
        failed |= check(skills_valid and set(skills).issubset(known), f"{case_id!r} uses catalog skills")
        failed |= check(isinstance(case.get("request"), str) and bool(case["request"].strip()), f"{case_id} has a request")
        failed |= check(expected_valid, f"{case_id!r} has non-empty string expected assertions")
        failed |= check(forbidden_valid, f"{case_id!r} has non-empty string forbidden assertions")
        if "fixture" in case:
            fixture_name = case["fixture"]
            if not id_valid or fixture_name != f"{case_id}.json":
                failed |= check(False, f"{case_id!r} fixture filename matches case id")
            else:
                try:
                    fixture_path = scenarios_path.parent / "fixtures" / fixture_name
                    validate_fixture(json.loads(fixture_path.read_text(encoding="utf-8")))
                    failed |= check(True, f"{case_id!r} has a safe inert fixture")
                except (OSError, UnicodeError, ValueError) as exc:
                    failed |= check(False, f"{case_id!r} invalid fixture: {exc}")
        if skills_valid:
            covered.update(skills)

    failed |= check(len(ids) == len(set(ids)), "eval ids are unique")
    missing = sorted(known - covered)
    failed |= check(not missing, "every catalog package has a behavior scenario")
    if missing:
        print(f"  MISSING {missing}")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenarios", type=Path, default=SCENARIOS)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    args = parser.parse_args()
    return validate(args.scenarios, args.catalog)


if __name__ == "__main__":
    raise SystemExit(main())
