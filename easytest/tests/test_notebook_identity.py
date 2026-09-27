import json

import pytest

from easytest.notebook import NotebookSession
from easytest.snapshots.comparison import SnapshotMismatchError
from easytest.starter import init_project


@pytest.fixture(params=["file", "sqlite"])
def project(tmp_path, request):
    root = init_project(tmp_path / "project")
    (root / "config/runtime.json").write_text(json.dumps({"snapshot_backend": request.param}))
    (root / "config/operations.json").write_text(json.dumps({"operations": {
        name: {"executor": "scenario", "builtin": "get", "path": "value"}
        for name in ("first", "second")
    }}))
    (root / "config/snapshots.json").write_text(json.dumps({
        "profiles": {"default": {"response_default": {}}},
    }))
    return root


def test_notebook_default_snapshot_identity_is_stable_per_operation(project):
    with NotebookSession(project, run_mode="write") as session:
        for operation, value in (("first", 1), ("second", 2), ("first", 1)):
            session.run_step(executor="scenario", operation=operation,
                             mock={"response": {"a": value}}, snapshot={})
        ids = [case.id for case in session.runner.case_reports]
        assert ids[0] != ids[1]
        assert ids[0] == ids[2]
        with pytest.raises(SnapshotMismatchError):
            session.run_step(executor="scenario", operation="first",
                             mock={"response": {"a": 3}}, snapshot={})


def test_notebook_explicit_identity_reuses_baseline_across_sessions(project):
    options = dict(executor="scenario", operation="first", snapshot={},
                   case_id="customer.active", step_id="check")
    with NotebookSession(project, run_mode="write") as session:
        session.run_step(**options, mock={"response": {"a": 1}})
    with NotebookSession(project, run_mode="read") as session:
        session.run_step(**options, mock={"response": {"a": 1}})
        with pytest.raises(SnapshotMismatchError):
            session.run_step(**options, mock={"response": {"a": 2}})
