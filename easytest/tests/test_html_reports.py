from __future__ import annotations

import copy
import json
import re
import subprocess
import sys

import pytest

from easytest.cli import main
from easytest.cases.compiler import compile_workbook
from easytest.models import ContractError
from easytest.notebook import NotebookSession
from easytest.reports.html import write_html
from easytest.reports.results import CaseReport, RunReport
from easytest.starter import init_project


def read_report(path):
    text = path.read_text(encoding="utf-8")
    match = re.search(r'<script type="application/json" id="report-data">(.*?)</script>', text, re.S)
    assert match is not None
    return json.loads(match[1])


def test_html_embeds_hostile_text_as_data_and_writes_complete_file(tmp_path):
    hostile = '</script><script>window.injected=1</script><img src=x onerror=alert(1)>'
    path = write_html(RunReport(cases=[CaseReport(id=hostile)]), tmp_path / "out/report.html")
    assert read_report(path)["cases"][0]["id"] == hostile
    assert hostile not in path.read_text()
    assert not list(path.parent.glob(".report-*"))
    assert read_report(write_html(RunReport(), path))["summary"]["total"] == 0


def _mixed_project(tmp_path):
    root = init_project(tmp_path / "project")
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    passing = copy.deepcopy(document["cases"][0])
    passing["id"] = "http.passing"
    document["cases"][0]["steps"][0]["expect"] = {"$.status_code": 500}
    document["cases"].append(passing)
    path.write_text(json.dumps(document))
    return root


def test_cli_continues_after_case_failure_and_writes_custom_report(tmp_path):
    root = _mixed_project(tmp_path)
    with pytest.raises(AssertionError):
        main(["run", "cases/demo.json", "--root", str(root), "--report", "out/run.html"])
    data = read_report(root / "out/run.html")
    assert [case["status"] for case in data["cases"]] == ["failed", "passed"]
    assert data["summary"]["pass_rate"] == 50
    assert data["cases"][0]["steps"][0]["errors"][0]["kind"] == "assertion"


def test_cli_success_stdout_and_no_report_option(tmp_path, capsys):
    root = init_project(tmp_path / "project")
    main(["run", "--root", str(root)])
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert result["data"]["cases"][0]["steps"][0]["mocked"] is True
    assert result["artifacts"]["pdf"] is None
    assert "EasyTest report:" in captured.err
    assert read_report(root / "artifacts/report.html")["summary"]["passed"] == 1
    main(["run", "--root", str(root), "--no-report"])
    assert "EasyTest report:" not in capsys.readouterr().err


def test_cli_generates_pdf_only_when_explicitly_requested(tmp_path, capsys):
    root = init_project(tmp_path / "project")

    main([
        "run",
        "--root",
        str(root),
        "--no-report",
        "--pdf-report",
        "artifacts/report.pdf",
    ])

    result = json.loads(capsys.readouterr().out)
    target = root / "artifacts/report.pdf"
    assert result["artifacts"] == {
        "html": None,
        "pdf": str(target),
        "result": None,
    }
    assert target.read_bytes().startswith(b"%PDF")


def test_cli_collection_error_still_writes_failed_report(tmp_path):
    root = init_project(tmp_path / "project")
    with pytest.raises(ContractError):
        main(["run", "cases/missing.json", "--root", str(root)])
    data = read_report(root / "artifacts/report.html")
    assert data["summary"]["failed"] == 1
    assert data["cases"][0]["errors"][0]["phase"] == "collection"


def test_cli_interrupt_preserves_pending_cases_and_overrides_earlier_failure(tmp_path, monkeypatch):
    root = _mixed_project(tmp_path)
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    pending = copy.deepcopy(document["cases"][-1])
    pending["id"] = "http.pending"
    document["cases"].append(pending)
    path.write_text(json.dumps(document))
    interruption = KeyboardInterrupt()
    calls = []
    def run(_runner, case):
        calls.append(case.id)
        if len(calls) == 1:
            raise AssertionError("first failure")
        raise interruption
    monkeypatch.setattr("easytest.cli.CaseRunner.run", run)
    with pytest.raises(KeyboardInterrupt) as caught:
        main(["run", "cases/demo.json", "--root", str(root)])
    assert caught.value is interruption
    assert [case["status"] for case in read_report(root / "artifacts/report.html")["cases"]] == [
        "failed", "interrupted", "not_run",
    ]
    assert len(calls) == 2


def test_report_write_error_preserves_existing_failure(tmp_path, monkeypatch):
    root = _mixed_project(tmp_path)
    def cannot_write(*_args):
        raise OSError("a secret from filesystem")
    monkeypatch.setattr("easytest.cli.write_html", cannot_write)
    with pytest.raises(AssertionError) as caught:
        main(["run", "cases/demo.json", "--root", str(root)])
    assert "OSError" in str(caught.value.__notes__)
    assert "a secret from filesystem" not in str(caught.value.__notes__)
    compile_workbook(root / "cases/demo.xlsx")
    with pytest.raises(OSError):
        main(["run", "cases/demo.xlsx", "--root", str(root)])


def test_notebook_report_contains_multiple_runs_and_failed_attempt(tmp_path):
    root = init_project(tmp_path / "project")
    with NotebookSession(root) as session:
        session.run_case()
        with pytest.raises(AssertionError):
            session.run_step(
                executor="http", operation="http.ping", expect={"$.status_code": 500},
            )
        path = session.write_report("artifacts/notebook.html")
    assert [case["status"] for case in read_report(path)["cases"]] == ["passed", "failed"]


def _pytest(root, *args):
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *args],
        cwd=root, text=True, capture_output=True, timeout=30,
    )


def test_pytest_report_uses_final_status_and_collects_all_runner_calls(tmp_path):
    root = init_project(tmp_path / "project")
    (root / "test_cases.py").write_text('''
import pytest
from dataclasses import replace
from easytest.cases.loader import load_cases

@pytest.fixture
def broken_setup():
    raise RuntimeError("sensitive-setup-message")

@pytest.fixture
def broken_teardown():
    yield
    raise RuntimeError("sensitive-teardown-message")

def test_pass(table_case, case_runner):
    case_runner.run(table_case)

def test_expected_failure(case_runner):
    case = load_cases(case_runner.root / "cases/demo.json")[0]
    bad = replace(case, steps=(replace(case.steps[0], expect={"$.status_code": 500}),))
    with pytest.raises(AssertionError):
        case_runner.run(bad)
    case_runner.run(case)

def test_failure():
    assert False, "sensitive-assertion-message"

def test_setup(broken_setup):
    pass

def test_teardown(broken_teardown):
    pass

@pytest.mark.skip(reason="sensitive-skip-message")
def test_skip():
    pass

@pytest.mark.xfail(reason="expected assertion")
def test_xfail():
    assert False
''')
    result = _pytest(root, "--easytest-report", "out/pytest.html")
    assert result.returncode == 1, result.stdout + result.stderr
    path = root / "out/pytest.html"
    data = read_report(path)
    assert data["summary"]["total"] == 7
    assert data["summary"]["passed"] == 2
    assert data["summary"]["failed"] == 3
    assert data["summary"]["skipped"] == 2
    records = {case["id"].split("::")[-1]: case for case in data["cases"]}
    expected = records["test_expected_failure"]
    assert expected["status"] == "passed"
    assert [step["status"] for step in expected["steps"]] == ["failed", "passed"]
    assert records["test_setup"]["errors"][0]["phase"] == "setup"
    assert records["test_teardown"]["errors"][0]["phase"] == "teardown"
    assert "sensitive-" not in path.read_text()
    result = _pytest(root, "--easytest-report", "out/selected.html", "-k", "expected_failure")
    assert result.returncode == 0, result.stdout + result.stderr
    assert read_report(root / "out/selected.html")["summary"]["total"] == 1


def test_pytest_collection_error_default_report_and_unrelated_project_opt_out(tmp_path):
    root = init_project(tmp_path / "project")
    for path in (root / "cases").iterdir():
        path.unlink()
    result = _pytest(root)
    assert result.returncode != 0
    data = read_report(root / "artifacts/report.html")
    assert data["summary"]["failed"] >= 1
    assert data["summary"]["interrupted"] == 0
    assert any(error["phase"] == "collection" for case in data["cases"] for error in case["errors"])
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    (unrelated / "test_plain.py").write_text("def test_ok():\n    assert 1 == 1\n")
    result = _pytest(unrelated)
    assert result.returncode == 0, result.stdout + result.stderr
    assert not (unrelated / "artifacts/report.html").exists()


def test_pytest_report_write_failure_makes_successful_run_nonzero(tmp_path):
    root = init_project(tmp_path / "project")
    (root / "blocked").write_text("not a directory")
    result = _pytest(root, "--easytest-report", "blocked/report.html")
    assert result.returncode != 0
    assert "HTML report could not be written" in result.stdout + result.stderr
