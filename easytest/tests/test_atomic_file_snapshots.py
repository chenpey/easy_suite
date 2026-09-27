from __future__ import annotations

import json
import os
from dataclasses import replace

import pytest

from easytest.cases.loader import load_cases
from easytest.runtime.assertions import ExpectationError
from easytest.runtime.runner import CaseRunner
from easytest.snapshots.manager import SnapshotManager
from easytest.starter import init_project


def _project(tmp_path):
    root = init_project(tmp_path / "project")
    (root / "config/snapshots.json").write_text(json.dumps({
        "profiles": {"default": {"response_default": {}}},
    }))
    case = load_cases(root / "cases/demo.json")[0]
    first = replace(
        case.steps[0],
        id="first",
        order=1,
        mock={"response": {"value": 1}},
        expect=None,
        snapshot={"name": "first"},
    )
    second = replace(
        case.steps[0],
        id="second",
        order=2,
        mock={"response": {"value": 2}},
        expect=None,
        snapshot={"name": "second"},
    )
    return root, replace(case, steps=(first, second))


def test_file_snapshots_are_committed_only_after_case_success(tmp_path):
    root, case = _project(tmp_path)
    failing = replace(
        case,
        steps=(
            case.steps[0],
            replace(case.steps[1], expect={"$.value": 999}),
        ),
    )

    with CaseRunner(root, run_mode="write") as runner:
        with pytest.raises(ExpectationError):
            runner.run(failing)

    assert not (root / "snapshots/http.demo/first.json").exists()
    assert not (root / "snapshots/http.demo/second.json").exists()

    with CaseRunner(root, run_mode="write") as runner:
        runner.run(case)
    assert (root / "snapshots/http.demo/first.json").is_file()
    assert (root / "snapshots/http.demo/second.json").is_file()


def test_failed_baseline_case_keeps_previous_file_snapshots(
    tmp_path,
    monkeypatch,
):
    root, case = _project(tmp_path)
    with CaseRunner(root, run_mode="write") as runner:
        runner.run(case)
    target = root / "snapshots/http.demo/first.json"
    before = target.read_bytes()

    changed_first = replace(case.steps[0], mock={"response": {"value": 10}})
    failing_second = replace(case.steps[1], expect={"$.value": 999})
    monkeypatch.setenv("CONFIRM_BASELINE", "1")
    with CaseRunner(root, run_mode="baseline") as runner:
        with pytest.raises(ExpectationError):
            runner.run(replace(case, steps=(changed_first, failing_second)))

    assert target.read_bytes() == before


def test_file_snapshot_commit_rolls_back_if_one_replace_fails(
    tmp_path,
    monkeypatch,
):
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    first.write_bytes(b"old-first")
    second.write_bytes(b"old-second")
    real_replace = os.replace
    calls = 0

    def replace_with_failure(source, target):
        nonlocal calls
        calls += 1
        if calls == 4:
            raise OSError("synthetic replacement failure")
        return real_replace(source, target)

    monkeypatch.setattr("easytest.snapshots.manager.os.replace", replace_with_failure)
    with pytest.raises(OSError, match="synthetic"):
        SnapshotManager._commit_files({
            first: b"new-first",
            second: b"new-second",
        })

    assert first.read_bytes() == b"old-first"
    assert second.read_bytes() == b"old-second"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["first.json", "second.json"]
