import json

import pytest

from easytest import Case, CaseRunner, ExecutionResult, Step, load_project_cases
from easytest.cli import main
from easytest.models import ContractError
from easytest.starter import init_project


def tree(root):
    return {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in root.rglob("*") if path.is_file()
    }


def test_list_reads_workbook_without_importing_resolving_or_writing(tmp_path, capsys, monkeypatch):
    root = init_project(tmp_path / "project")
    monkeypatch.delenv("DISCOVERY_SECRET", raising=False)
    (root / ".env").write_text("OTHER_SECRET=discovery-secret-must-not-appear\n")
    (root / "cases/demo.json").write_text("stale generated JSON")
    (root / "config/operations.json").write_text(json.dumps({"operations": {
        "http.ping": {"executor": "http", "url": "${DISCOVERY_SECRET}"},
        "sdk.read": {"executor": "scenario", "handler": "uninstalled_sdk:run"},
    }}))
    (root / "config/runtime.json").write_text(json.dumps({
        "snapshot_backend": "sqlite", "snapshot_database": ".easytest/snapshots.db",
    }))
    before = tree(root)
    main(["list", "--root", str(root)])
    output = capsys.readouterr().out
    result = json.loads(output)
    assert result["status"] == "listed"
    assert result["artifacts"] == {"html": None, "result": None}
    assert result["data"]["cases"][0]["id"] == "http.demo"
    assert result["data"]["cases"][0]["steps"][0]["source_row"] == 2
    assert result["data"]["operations"] == [
        {"name": "http.ping", "executor": "http"},
        {"name": "sdk.read", "executor": "scenario"},
    ]
    assert "discovery-secret-must-not-appear" not in output
    assert "DISCOVERY_SECRET" not in output
    assert tree(root) == before


@pytest.mark.parametrize("command", ["run", "validate", "list"])
def test_cli_exact_selection_preserves_order_and_skips_unselected_preflight(tmp_path, capsys, command):
    root = init_project(tmp_path / "project")
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    first = document["cases"][0]
    document["cases"] = [
        {**first, "id": "a"},
        {**first, "id": "b"},
        {**first, "id": "a.extra", "steps": [{**first["steps"][0], "operation": "missing"}]},
    ]
    path.write_text(json.dumps(document))
    options = ["--no-report"] if command == "run" else []
    main([command, str(path), "--root", str(root), "--case-id", "b",
          "--case-id", "a", "--case-id", "b", *options])
    result = json.loads(capsys.readouterr().out)
    assert result["errors"] == []
    if command == "validate":
        assert result["data"]["case_count"] == 2
    else:
        assert [case["id"] for case in result["data"]["cases"]] == ["a", "b"]


@pytest.mark.parametrize("command", ["run", "validate", "list"])
@pytest.mark.parametrize("case_id", ["missing", "", "http.*"])
def test_unknown_and_empty_cli_selection_fail_before_execution(tmp_path, capsys, monkeypatch, command, case_id):
    root = init_project(tmp_path / "project")

    def forbidden(*args, **kwargs):
        pytest.fail("selection error must precede case execution")

    monkeypatch.setattr(CaseRunner, "run", forbidden)
    options = ["--no-report"] if command == "run" else []
    with pytest.raises(ContractError):
        main([command, "--root", str(root), "--case-id", case_id, *options])
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "failed"
    assert result["errors"][0]["type"] == "ContractError"


def test_json_only_and_orphan_source_rules(tmp_path):
    root = init_project(tmp_path / "project")
    (root / "cases/demo.xlsx").unlink()
    with pytest.raises(ContractError, match="orphan compiled JSON"):
        load_project_cases(root / "cases", write_compiled=False)
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    for field in ("source_mode", "source", "source_sha256", "compiler_version"):
        document.pop(field)
    path.write_text(json.dumps(document))
    with pytest.raises(ContractError) as caught:
        load_project_cases(root / "cases")
    assert caught.value.code == "JSON_SOURCE_MODE_REQUIRED"
    document["source_mode"] = "json"
    path.write_text(json.dumps(document))
    before = tree(root)
    assert load_project_cases(root / "cases")[0].source == str(path)
    assert tree(root) == before
    with pytest.raises(ContractError, match="cannot be empty"):
        load_project_cases(root / "cases", case_ids=[])
    document["cases"][0]["enabled"] = False
    path.write_text(json.dumps(document))
    with pytest.raises(ContractError, match="no enabled cases"):
        load_project_cases(root / "cases", case_ids=["http.demo"])


def test_minimal_public_models_run_and_do_not_share_variables(tmp_path):
    root = init_project(tmp_path / "project")
    case = Case("minimal", steps=(
        Step("ping", 1, "http", "http.ping", expect={"$.body.ok": True}),
    ))
    assert case.name == case.id
    assert Case("other").variables is not case.variables
    with CaseRunner(root) as runner:
        result = runner.run(case)["ping"]
    assert isinstance(result, ExecutionResult)
    assert result.output["body"]["ok"] is True
