import json

import pytest
from openpyxl.workbook.workbook import Workbook

from easytest.cases.editor import edit_workbook
from easytest.cases.loader import load_cases
from easytest.cli import main
from easytest.models import ConfigurationError
from easytest.starter import init_project


def patch_step(**values):
    return [{"entity": "step", "action": "update", "case_id": "http.demo",
             "step_id": "ping", "values": values}]


def test_project_validation_failure_preserves_both_files(tmp_path):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"
    compiled = source.with_suffix(".json")
    before = source.read_bytes(), compiled.read_bytes()
    with pytest.raises(ConfigurationError) as caught:
        edit_workbook(source, patch_step(operation="http.missing"), validate=True, root=root)
    assert caught.value.code == "UNKNOWN_OPERATION"
    assert (source.read_bytes(), compiled.read_bytes()) == before
    assert not list(source.parent.glob(".*.edit-*"))


def test_validated_edit_commits_and_cli_marks_preflight(tmp_path, capsys):
    root = init_project(tmp_path / "project")
    operation = patch_step(expect={"$.status_code": 200})[0]
    main(["edit", "cases/demo.xlsx", "--root", str(root), "--validate",
          "--operation", json.dumps(operation)])
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "edited"
    assert result["data"]["validated"] is True
    assert load_cases(root / "cases/demo.json")[0].steps[0].expect == {"$.status_code": 200}


def test_edit_policy_failure_happens_before_commit(tmp_path):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"
    before = source.read_bytes()
    with pytest.raises(ConfigurationError, match="policy"):
        edit_workbook(source, patch_step(expect={"$.status_code": 200}), root=root, validate=True,
                      execution_policy=root / "missing-policy.json")
    assert source.read_bytes() == before
    assert not list(source.parent.glob(".*.edit-*"))


@pytest.mark.parametrize("failure", [OSError("disk full"), KeyboardInterrupt()])
def test_save_failure_removes_temporary_files(tmp_path, monkeypatch, failure):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"
    before = source.read_bytes(), source.with_suffix(".json").read_bytes()

    def fail(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(Workbook, "save", fail)
    with pytest.raises(type(failure)):
        edit_workbook(source, patch_step(expect={}), root=root, validate=True)
    assert (source.read_bytes(), source.with_suffix(".json").read_bytes()) == before
    assert not list(source.parent.glob(".*.edit-*"))
