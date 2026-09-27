from __future__ import annotations

import json
from dataclasses import replace

import pytest

from easytest.cases.loader import load_cases
from easytest.reports.results import CaseReport, RunReport, StepReport, safe_difference, safe_value
from easytest.runtime.runner import CaseRunner
from easytest.snapshots.comparison import Difference, SnapshotMismatchError, compare
from easytest.snapshots.manager import SnapshotManager
from easytest.starter import init_project


@pytest.mark.parametrize("backend", ["file", "sqlite"])
def test_snapshot_report_keeps_differences_source_and_unexecuted_steps(tmp_path, backend):
    root = init_project(tmp_path / "project")
    (root / "config/runtime.json").write_text(json.dumps({
        "default_profile": "offline-strict", "snapshot_backend": backend,
    }))
    (root / "config/snapshots.json").write_text(json.dumps({
        "profiles": {"default": {"response_default": {}}},
    }))
    original = load_cases(root / "cases/demo.json")[0]
    step = replace(original.steps[0], snapshot={"select": "$.body"}, expect=None)
    case = replace(original, steps=(step, replace(step, id="later", order=2)))
    with CaseRunner(root, run_mode="write") as runner:
        runner.run(case)
    changed = replace(step, mock={"response": {
        "status_code": 200, "body": {"ok": 1, "count": 20},
    }})
    with CaseRunner(root, run_mode="read") as runner:
        with pytest.raises(SnapshotMismatchError) as caught:
            runner.run(replace(case, steps=(changed, case.steps[1])))
        assert isinstance(caught.value, AssertionError)
        report = runner.last_report
        assert report.status == "failed"
        assert [step.status for step in report.steps] == ["failed", "not_run"]
        assert report.steps[0].source_row == 2
        assert report.steps[0].phase == "snapshot"
        assert {d["category"] for d in report.steps[0].differences} == {
            "type_changed", "added",
        }
        assert report.steps[0].response["body"]["ok"] == 1
        assert report.source.endswith("demo.xlsx")
        assert runner.case_reports == [report]


@pytest.mark.parametrize(("suffix", "before", "after", "category"), [
    (".json", b'{"n":1}', b'{"n":2}', "number_changed"),
    (".json", b'{"n":1}', b'{ "n": 1 }\n', "format_changed"),
    (".png", b"image one", b"image two", "binary_changed"),
])
def test_file_write_retains_byte_comparison_with_structured_failure(
    tmp_path, suffix, before, after, category,
):
    target = tmp_path / ("baseline" + suffix)
    target.write_bytes(before)
    with pytest.raises(SnapshotMismatchError) as caught:
        SnapshotManager._assert_or_write(target, after, "write")
    assert caught.value.differences[0].category == category
    assert target.read_bytes() == before


def test_missing_baseline_has_its_own_category(tmp_path):
    with pytest.raises(SnapshotMismatchError) as caught:
        SnapshotManager._assert_or_write(tmp_path / "new.json", b'{"n":1}', "read")
    assert caught.value.differences[0].category == "baseline_missing"


def test_report_redacts_diff_ancestors_and_does_not_copy_unknown_errors():
    secrets = ("unique-old-secret", "unique-new-secret")
    for path in ("$.password", "$.Authorization.inner", "$.items[0].access_token"):
        difference = safe_difference(Difference(path, "changed", *secrets), "baseline")
        assert all(secret not in json.dumps(difference) for secret in secrets)
        assert difference["category"] == "text_changed"
    report = RunReport()
    report.add_error(RuntimeError("unlabeled-secret-token"), "setup")
    assert "unlabeled-secret-token" not in json.dumps(report.as_dict())
    recursive = {}
    recursive["self"] = recursive
    assert safe_value(recursive) == "[REDACTED_DUE_TO_ERROR]"


def test_statistics_count_every_diff_and_group_array_paths_across_cases():
    report = RunReport()
    for _ in range(2):
        differences = compare(
            {"rows": [{"n": 0} for _ in range(60)]},
            {"rows": [{"n": 1} for _ in range(60)]},
        ).differences
        report.cases.append(CaseReport(
            id="same-id", status="failed",
            steps=[StepReport(
                id="step", operation="op", executor="http", status="failed",
                differences=[safe_difference(d, "baseline") for d in differences],
            )],
        ))
    data = report.as_dict()
    assert data["summary"]["diff_count"] == 120
    assert data["summary"]["failed"] == 2
    assert data["groups"] == [{
        "category": "number_changed", "path": "$.rows[*].n",
        "count": 120, "case_indexes": [0, 1],
    }]
    assert RunReport().as_dict()["summary"]["pass_rate"] is None


@pytest.mark.parametrize("error", [OSError("secret"), KeyboardInterrupt()])
def test_snapshot_finish_failure_is_not_reported_as_passed(tmp_path, monkeypatch, error):
    root = init_project(tmp_path / "project")
    case = load_cases(root / "cases/demo.json")[0]
    with CaseRunner(root) as runner:
        def finish(*_args, **_kwargs):
            raise error
        monkeypatch.setattr(runner.snapshots, "finish_case", finish)
        with pytest.raises(type(error)) as caught:
            runner.run(case)
        assert caught.value is error
        assert runner.last_report.status == (
            "failed" if isinstance(error, Exception) else "interrupted"
        )
        assert runner.last_report.steps[0].status == "passed"
        assert runner.last_report.errors[0]["phase"] == "snapshot_finish"
