import json
from dataclasses import replace

import pytest

from easytest.cases.loader import load_project_cases
from easytest.reports.results import safe_value
from easytest.runtime.observability import REDACTED, redact, redaction_scope
from easytest.runtime.runner import CaseRunner
from easytest.starter import init_project


def test_custom_keys_apply_to_nested_values_paths_text_and_urls():
    value = {
        "access_code": "credential-value",
        "customer_code": "customer-value",
        "url": "https://alice:password-value@example.invalid/?access_code=query-value&to%6ben=encoded-value#fragment-value",
        "message": "Authorization: Bearer header-value",
        "note": "access_code=text-value",
    }
    with redaction_scope({"secret_keys": ["access_code"], "pii_keys": ["customer_code"]}):
        result = safe_value(value)
        difference = safe_value("difference-value", path="$.nested.access_code")
    serialized = json.dumps(result)
    for secret in ["credential-value", "customer-value", "password-value", "query-value",
                   "encoded-value", "fragment-value", "header-value", "text-value", "alice"]:
        assert secret not in serialized
    assert result["access_code"] == REDACTED
    assert result["customer_code"].startswith("<redacted:sha256:")
    assert difference == REDACTED


def test_redaction_scope_is_restored_after_failure_and_nested_execution():
    with pytest.raises(RuntimeError):
        with redaction_scope({"secret_keys": ["private_field"]}):
            assert redact({"private_field": "one"})["private_field"] == REDACTED
            with redaction_scope({"secret_keys": ["different_field"]}):
                assert redact({"private_field": "two"})["private_field"] == "two"
                assert redact({"token": "built-in"})["token"] == REDACTED
            assert redact({"private_field": "three"})["private_field"] == REDACTED
            raise RuntimeError("stop")
    assert redact({"private_field": "outside"})["private_field"] == "outside"


def test_runner_redacts_report_events_and_assertion_differences(tmp_path, caplog):
    root = init_project(tmp_path / "project")
    path = root / "config/runtime.json"
    runtime = json.loads(path.read_text())
    runtime["redaction"] = {"secret_keys": ["access_code"], "pii_keys": ["customer_code"]}
    path.write_text(json.dumps(runtime))
    case = load_project_cases(root / "cases", write_compiled=False)[0]
    step = replace(
        case.steps[0], mock={"kind": "response", "response": {"access_code": "actual-private"}},
        expect={"$.access_code": "expected-private"},
    )
    with CaseRunner(root) as runner, pytest.raises(AssertionError):
        runner.run(replace(case, steps=(step,)))
    report = runner.last_report
    serialized = str(report) + json.dumps(runner.last_events) + caplog.text
    assert "actual-private" not in serialized
    assert "expected-private" not in serialized
    assert report.steps[0].response["access_code"] == REDACTED
    assert report.steps[0].errors[0]["actual"] == REDACTED
    assert redact({"access_code": "outside"})["access_code"] == "outside"
