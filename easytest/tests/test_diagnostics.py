import json
from dataclasses import replace

import pytest

from easytest import CaseRunner, load_project_cases
from easytest.cli import main
from easytest.models import ConfigurationError, ContractError
from easytest.reports.results import error_info
from easytest.runtime.assertions import ExpectationError, assert_expectations
from easytest.starter import init_project


@pytest.mark.parametrize("path", ["$.password", "$.auth.token.value"])
def test_assertion_diagnostics_redact_ancestors_and_do_not_copy_exception_text(path):
    error = ExpectationError(path, "equals", "expected-secret", "actual-secret")
    error.add_note("notes-secret")
    info = error_info(error, "assertion")
    assert info["code"] == "ASSERTION_FAILED"
    assert info["path"] == path
    assert info["operator"] == "equals"
    assert "secret" not in json.dumps(info)
    assert info["expected"] == info["actual"]


def test_missing_path_and_plain_values_have_distinct_diagnostics():
    with pytest.raises(ExpectationError) as caught:
        assert_expectations({}, {"$.items": [1]})
    info = error_info(caught.value, "assertion")
    assert info["code"] == "ASSERTION_PATH_MISSING"
    assert info["actual"] is None
    assert info["expected"] == [1]
    info = error_info(ExpectationError("$.ok", "equals", True, 1), "assertion")
    assert info["expected"] is True
    assert type(info["actual"]) is int
    assert "arbitrary-secret" not in json.dumps(error_info(ValueError("arbitrary-secret"), "execute"))
    assert error_info(ValueError("arbitrary-secret"), "execute")["code"] == "EXECUTION_FAILED"


@pytest.mark.parametrize("phase", ["collection", "preflight", "assertion"])
def test_cli_diagnostics_include_fields_and_source_coordinates(tmp_path, capsys, phase):
    root = init_project(tmp_path / "project")
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    step = document["cases"][0]["steps"][0]
    if phase == "collection":
        step["expect"] = {"path": "$.body.ok", "equal": True}
        expected_code, field = "UNKNOWN_FIELD", "expect.equal"
    elif phase == "preflight":
        step["operation"] = "missing"
        expected_code, field = "UNKNOWN_OPERATION", "operation"
    else:
        step["expect"] = {"$.body.ok": 1}
        expected_code, field = "ASSERTION_FAILED", "expect"
    path.write_text(json.dumps(document))
    with pytest.raises((ContractError, ConfigurationError, ExpectationError)):
        main(["run", str(path), "--root", str(root), "--no-report"])
    result = json.loads(capsys.readouterr().out)
    error = result["errors"][0]
    assert (error["code"], error["field"], error["phase"]) == (expected_code, field, phase)
    assert error["case_id"] == "http.demo"
    assert error["step_id"] == "ping"
    assert error["source"].endswith("demo.xlsx")
    assert error["source_row"] == "2"


def test_runtime_report_redacts_both_step_and_case_assertion_errors(tmp_path):
    root = init_project(tmp_path / "project")
    case = load_project_cases(root / "cases")[0]
    step = replace(
        case.steps[0], mock={"response": {"token": {"value": "actual-secret"}}},
        expect={"$.token.value": "expected-secret"},
    )
    with CaseRunner(root) as runner:
        with pytest.raises(ExpectationError):
            runner.run(replace(case, steps=(step,)))
        report = runner.last_report
    assert "secret" not in json.dumps(report.errors)
    assert "secret" not in json.dumps(report.steps[0].errors)
    assert report.errors[0]["operation"] == "http.ping"
