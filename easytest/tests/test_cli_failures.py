import json

import pytest

from easytest.cli import main
from easytest.runtime.mocks import MockEngine
from easytest.starter import init_project


@pytest.mark.parametrize(
    "options,expected",
    [
        ([], ["failed", "failed", "passed"]),
        (["--fail-fast"], ["failed", "not_run", "not_run"]),
        (["--max-failures", "2"], ["failed", "failed", "not_run"]),
        (["--max-failures", "3"], ["failed", "failed", "passed"]),
    ],
)
def test_failure_limits_stop_execution_and_preserve_machine_result(tmp_path, capsys, monkeypatch, options, expected):
    root = init_project(tmp_path / "project")
    cases = []
    for index in range(3):
        cases.append({
            "id": f"case.{index}", "type": "http",
            "steps": [{"id": "ping", "order": 1, "executor": "http", "operation": "http.ping",
                       "expect": {"$.status_code": 201 if index < 2 else 200}}],
        })
    (root / "batch.json").write_text(json.dumps({"schema_version": 1, "source_mode": "json", "cases": cases}))
    invoked = []
    original = MockEngine.apply

    def track(self, **kwargs):
        invoked.append(kwargs["context"].case.id)
        return original(self, **kwargs)

    monkeypatch.setattr(MockEngine, "apply", track)
    with pytest.raises(AssertionError):
        main(["run", "batch.json", "--root", str(root), "--no-report",
              "--result", "artifacts/result.json", *options])
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "failed"
    assert [case["status"] for case in result["data"]["cases"]] == expected
    assert len(invoked) == sum(status != "not_run" for status in expected)
    assert result["data"]["summary"]["not_run"] == expected.count("not_run")
    assert json.loads((root / "artifacts/result.json").read_text()) == result
    for case in result["data"]["cases"]:
        if case["status"] == "not_run":
            assert all(step["status"] == "not_run" for step in case["steps"])


@pytest.mark.parametrize("value", ["0", "-1", "1.5", "abc"])
def test_invalid_max_failures_rejected_before_initialization(value, capsys):
    with pytest.raises(SystemExit) as caught:
        main(["run", "--max-failures", value])
    assert caught.value.code == 2
    assert "positive integer" in capsys.readouterr().err
