#!/usr/bin/env python3
"""Stand-in for ``venv/bin/python -m pytest ...`` used by the CLI tests.

``EASYDEV_PYTEST_PLAN`` points at a JSON file ``{"statuses": {nodeid: status}}``
or ``{"sequence": [{"statuses": {...}}, ...], "counter_file": path}`` to change
statuses between invocations (for calibrate baseline then gold).
Selected arguments that are node ids are reported directly; a selected file
path expands to every planned node id in that file.  Node ids without a planned
status are reported ``FAILED``.  The stub writes the requested JUnit XML and
exits 1 when any reported test failed.

The stub never imports the modules under test.
"""

from __future__ import annotations

import json
import os
import sys
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from typing import Dict, List, Optional


FLAGS_WITH_VALUE = {"-m", "-p", "-o", "--rootdir", "--confcutdir", "-k", "-c"}


def parse_args(argv: List[str]) -> tuple[List[str], Optional[Path]]:
    junit: Optional[Path] = None
    selected: List[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token.startswith("--junitxml="):
            junit = Path(token.split("=", 1)[1])
        elif token in FLAGS_WITH_VALUE:
            index += 1
        elif token.startswith("-"):
            pass
        else:
            selected.append(token)
        index += 1
    return selected, junit


def load_statuses() -> Dict[str, str]:
    plan_path = os.environ.get("EASYDEV_PYTEST_PLAN")
    if not plan_path:
        return {}
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    sequence = plan.get("sequence")
    if sequence:
        counter = Path(str(plan["counter_file"]))
        try:
            index = int(counter.read_text(encoding="utf-8").strip() or "0")
        except (OSError, ValueError):
            index = 0
        counter.write_text(f"{index + 1}\n", encoding="utf-8")
        entry = sequence[min(index, len(sequence) - 1)]
        return dict(entry.get("statuses") or {})
    if isinstance(plan.get("statuses"), dict):
        return dict(plan["statuses"])
    # Also accept the documented flat {nodeid: status} form.
    return {
        nodeid: status
        for nodeid, status in plan.items()
        if isinstance(status, str)
    }


def expand(selected: List[str], statuses: Dict[str, str]) -> List[str]:
    nodeids: List[str] = []
    for item in selected:
        if "::" in item:
            nodeids.append(item)
            continue
        matches = sorted(
            nodeid
            for nodeid in statuses
            if nodeid.split("::", 1)[0] == item
        )
        nodeids.extend(matches or [item])
    return nodeids


def write_junit(path: Path, results: List[tuple[str, str]]) -> None:
    suite = ElementTree.Element(
        "testsuite",
        {
            "name": "pytest",
            "tests": str(len(results)),
            "failures": str(sum(status == "FAILED" for _, status in results)),
        },
    )
    for nodeid, status in results:
        classname, _, name = nodeid.rpartition("::")
        case = ElementTree.SubElement(
            suite,
            "testcase",
            {"classname": classname or nodeid, "name": name or nodeid},
        )
        if status == "FAILED":
            ElementTree.SubElement(case, "failure", {"message": "stub failure"})
        elif status == "SKIPPED":
            ElementTree.SubElement(case, "skipped", {"message": "stub skip"})
    path.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.ElementTree(suite).write(path, encoding="utf-8", xml_declaration=True)


def main(argv: List[str]) -> int:
    selected, junit = parse_args(argv)
    statuses = load_statuses()
    nodeids = expand(selected, statuses)
    results = [(nodeid, statuses.get(nodeid, "FAILED")) for nodeid in nodeids]
    for nodeid, status in results:
        print(f"{nodeid} {status}", flush=True)
    failed = [nodeid for nodeid, status in results if status == "FAILED"]
    print(
        f"===== {len(results) - len(failed)} passed, {len(failed)} failed "
        f"in 0.01s =====",
        flush=True,
    )
    if junit is not None:
        write_junit(junit, results)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
