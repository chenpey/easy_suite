import json
import subprocess
import sys

import pytest

from easytest.cli import main
from easytest.models import ConfigurationError, ContractError, MockMissError
from easytest.starter import init_project


def test_init_and_default_cli_run_from_another_directory(tmp_path, capsys):
    root = tmp_path / "my-tests"
    main(["init", str(root)])
    capsys.readouterr()
    main(["run", "--root", str(root)])
    summary = json.loads(capsys.readouterr().out)
    assert summary["status"] == "passed"
    assert summary["data"]["cases"][0]["id"] == "http.demo"
    step = summary["data"]["cases"][0]["steps"][0]
    assert (step["id"], step["executor"], step["operation"], step["mocked"]) == (
        "ping", "http", "http.ping", True,
    )
    assert not (root / "src").exists()
    original = (root / "cases/demo.xlsx").read_bytes()
    with pytest.raises(ConfigurationError, match="new or empty directory"):
        main(["init", str(root)])
    assert (root / "cases/demo.xlsx").read_bytes() == original


def test_cli_reports_disabled_cases_and_strict_profile_misses(tmp_path):
    root = init_project(tmp_path / "project")
    document_path = root / "cases/demo.json"
    document = json.loads(document_path.read_text())
    document["cases"][0]["steps"][0]["mock"] = False
    document_path.write_text(json.dumps(document))
    with pytest.raises(MockMissError, match="blocked real execution") as error:
        main(["run", "cases/demo.json", "--root", str(root), "--profile", "offline-strict"])
    assert "sheet=steps, row=2" in str(error.value.__notes__)
    document["cases"][0]["enabled"] = False
    document_path.write_text(json.dumps(document))
    with pytest.raises(ContractError, match="no enabled cases"):
        main(["run", "cases/demo.json", "--root", str(root)])


def test_pytest_discovers_business_cases_and_forwards_settings(tmp_path):
    root = init_project(tmp_path / "project")
    # Inspect the real fixture in the generated user's single entry point.
    with (root / "test_cases.py").open("a") as stream:
        stream.write(
            "\ndef test_settings(case_runner):\n"
            "    assert case_runner.settings['profile'] == 'offline-strict'\n"
            "    assert case_runner.settings['allow_db_write'] is False\n"
            "    assert case_runner.run_mode == 'write'\n"
        )
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--profile", "offline-strict",
         "--run-mode", "write", "--no-allow-db-write"],
        cwd=root, text=True, capture_output=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "2 passed" in result.stdout
    assert "skipped" not in result.stdout


def test_pytest_empty_project_fails_collection(tmp_path):
    root = init_project(tmp_path / "project")
    for path in (root / "cases").iterdir():
        path.unlink()
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q"],
        cwd=root, text=True, capture_output=True, timeout=30,
    )
    assert result.returncode != 0
    assert "no XLSX or JSON" in result.stdout + result.stderr


def _handler_project(tmp_path, action):
    root = init_project(tmp_path / "project")
    (root / "business_handler.py").write_text(
        "from pathlib import Path\n"
        "Path('handler-imported').touch()\n\n"
        "def run(**kwargs):\n"
        "    Path('handler-called').touch()\n"
        f"    {action}\n"
    )
    (root / "config/operations.json").write_text(json.dumps({"operations": {
        "scenario.check": {"executor": "scenario", "handler": "business_handler:run"},
    }}))
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    first = document["cases"][0]
    first["type"] = "scenario"
    first["steps"][0].update(executor="scenario", operation="scenario.check", expect=None)
    document["cases"].append({**first, "id": "later"})
    path.write_text(json.dumps(document))
    return root


def _run_cli(root, *options):
    return subprocess.run(
        [sys.executable, "-c", "from easytest.cli import main; main()",
         "run", "cases/demo.json", "--root", str(root), "--profile", "live", *options],
        cwd=root, text=True, capture_output=True, timeout=30,
    )


@pytest.mark.parametrize("exit_code", [None, 0, False, 256, -256, 7, "handler stopped"])
def test_cli_system_exit_from_real_handler_cannot_signal_success(tmp_path, exit_code):
    root = _handler_project(tmp_path, f"raise SystemExit({exit_code!r})")
    completed = _run_cli(root, "--result", "artifacts/result.json")
    result = json.loads(completed.stdout)
    assert (root / "handler-called").exists()
    assert completed.returncode == 1, completed.stderr
    assert result["status"] == "interrupted"
    assert result["errors"][0]["type"] == "SystemExit"
    assert [case["status"] for case in result["data"]["cases"]] == ["interrupted", "not_run"]
    assert json.loads((root / "artifacts/result.json").read_text()) == result
    assert "<html" in (root / "artifacts/report.html").read_text().lower()


@pytest.mark.parametrize("command", ["run", "validate"])
def test_cli_normalizes_system_exit_during_initialization(tmp_path, monkeypatch, capsys, command):
    root = init_project(tmp_path / "project")

    def stop(*_args, **_kwargs):
        raise SystemExit(0)

    monkeypatch.setattr(f"easytest.cli.{'CaseRunner' if command == 'run' else 'ProjectConfig'}", stop)
    with pytest.raises(SystemExit) as caught:
        main([command, "--root", str(root)])
    assert caught.value.code == 1
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "interrupted"
    assert result["errors"][0]["phase"] == "initialization"


@pytest.mark.parametrize("alias", [
    "same", "relative", "absolute", "file_symlink", "directory_symlink", "default_report",
])
@pytest.mark.parametrize("existing", [False, True])
def test_cli_rejects_colliding_artifacts_before_importing_handler(tmp_path, alias, existing):
    root = _handler_project(tmp_path, "return {'ok': True}")
    directory = root / "artifacts"
    directory.mkdir()
    name = "report.html" if alias == "default_report" else "same.html"
    target = directory / name
    if existing:
        target.write_text("<html>existing report</html>")
    options = [] if alias == "default_report" else ["--report", f"artifacts/{name}"]
    result_path = f"artifacts/{name}"
    if alias == "relative":
        result_path = f"artifacts/../artifacts/{name}"
    elif alias == "absolute":
        result_path = str(target)
    elif alias == "file_symlink":
        (directory / "alias.json").symlink_to(target)
        result_path = "artifacts/alias.json"
    elif alias == "directory_symlink":
        (root / "linked-artifacts").symlink_to(directory, target_is_directory=True)
        result_path = f"linked-artifacts/{name}"
    before_paths = sorted(str(path.relative_to(root)) for path in root.rglob("*"))
    before_files = {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in root.rglob("*") if path.is_file()
    }
    completed = _run_cli(root, *options, "--result", result_path)
    result = json.loads(completed.stdout)
    assert completed.returncode != 0
    assert result["status"] == "failed"
    assert result["artifacts"] == {"html": None, "result": None}
    assert result["errors"][0]["phase"] == "output_paths"
    assert "--report and --result" in completed.stderr
    assert not (root / "handler-imported").exists()
    assert not (root / "handler-called").exists()
    assert sorted(str(path.relative_to(root)) for path in root.rglob("*")) == before_paths
    assert {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in root.rglob("*") if path.is_file()
    } == before_files


def test_cli_result_can_use_default_report_path_when_html_is_disabled(tmp_path):
    root = _handler_project(tmp_path, "return {'ok': True}")
    completed = _run_cli(root, "--no-report", "--result", "artifacts/report.html")
    result = json.loads(completed.stdout)
    assert completed.returncode == 0, completed.stderr
    assert result["status"] == "passed"
    assert result["artifacts"]["html"] is None
    assert json.loads((root / "artifacts/report.html").read_text()) == result
