from __future__ import annotations

import json

import pytest
from openpyxl import load_workbook

from easytest.cases.editor import edit_workbook
from easytest.cases.loader import load_cases
from easytest.cli import main
from easytest.models import ContractError
from easytest.starter import init_project


def test_editor_updates_and_renames_by_stable_ids(tmp_path):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"

    result = edit_workbook(source, [
        {
            "entity": "case",
            "action": "update",
            "case_id": "http.demo",
            "values": {"variables": {"user_id": 7}, "tags": ["smoke", "ai"]},
        },
        {
            "entity": "step",
            "action": "update",
            "case_id": "http.demo",
            "step_id": "ping",
            "values": {"request": {"json": {"id": "${variables.user_id}"}}},
        },
        {
            "entity": "case",
            "action": "rename",
            "case_id": "http.demo",
            "new_id": "http.user",
        },
        {
            "entity": "step",
            "action": "rename",
            "case_id": "http.user",
            "step_id": "ping",
            "new_id": "get_user",
        },
    ])

    cases = load_cases(source.with_suffix(".json"))
    document = json.loads(source.with_suffix(".json").read_text())
    assert result["operation_count"] == 4
    assert result["source_sha256"] == document["source_sha256"]
    assert cases[0].id == "http.user"
    assert cases[0].tags == ("smoke", "ai")
    assert cases[0].variables == {"user_id": 7}
    assert cases[0].steps[0].id == "get_user"
    assert cases[0].steps[0].request == {"json": {"id": "${variables.user_id}"}}


def test_editor_adds_related_case_and_step_in_one_validated_batch(tmp_path):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"

    edit_workbook(source, [
        {
            "entity": "case",
            "action": "add",
            "case_id": "http.second",
            "values": {"case_name": "Second", "case_type": "http"},
        },
        {
            "entity": "step",
            "action": "add",
            "case_id": "http.second",
            "step_id": "ping",
            "values": {
                "order": 1,
                "executor": "http",
                "operation": "http.ping",
                "request": {},
                "expect": {"$.status_code": 200},
            },
        },
    ])

    cases = load_cases(source.with_suffix(".json"))
    assert [case.id for case in cases] == [
        "http.demo",
        "http.second",
        "sample.login",
    ]
    assert cases[1].steps[0].expect == {"$.status_code": 200}


def test_editor_rejects_invalid_final_workbook_without_writing(tmp_path):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"
    compiled = source.with_suffix(".json")
    before = source.read_bytes(), compiled.read_bytes()

    with pytest.raises(ContractError, match="order must be positive"):
        edit_workbook(source, [{
            "entity": "step",
            "action": "update",
            "case_id": "http.demo",
            "step_id": "ping",
            "values": {"order": 0},
        }])

    assert (source.read_bytes(), compiled.read_bytes()) == before


def test_cli_edit_outputs_json_and_recompiles(tmp_path, capsys):
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.xlsx"
    operation = json.dumps({
        "entity": "case",
        "action": "update",
        "case_id": "http.demo",
        "values": {"case_name": "Updated"},
    })

    main(["edit", str(source), "--operation", operation])
    result = json.loads(capsys.readouterr().out)

    assert result["status"] == "edited"
    assert result["data"]["source"] == str(source)
    assert load_cases(source.with_suffix(".json"))[0].name == "Updated"
    workbook = load_workbook(source, read_only=True)
    try:
        assert workbook["cases"]["B2"].value == "Updated"
    finally:
        workbook.close()
