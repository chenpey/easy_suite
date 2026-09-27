from __future__ import annotations

from pathlib import Path

import pytest

from easytest.executors.base import Executor
from easytest.notebook import NotebookResult, NotebookSession
from easytest.starter import init_project

ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def test_notebook_session_lists_and_runs_compiled_case() -> None:
    with NotebookSession(ROOT, run_mode="read") as session:
        cases = session.cases("cases/http/profile_api.xlsx")
        results = session.run_case("cases/http/profile_api.json")

    assert cases == [
        {
            "id": "http.profile_api",
            "name": "Profile HTTP API",
            "type": "http",
            "tags": ["api", "offline"],
            "steps": 1,
        }
    ]
    assert results["get_profile"].output["status_code"] == 200
    assert results["get_profile"].mocked is True


def test_notebook_session_runs_single_mocked_operation() -> None:
    with NotebookSession(ROOT, run_mode="read") as session:
        result = session.run_step(
            executor="rpc",
            operation="rpc.calculate_limit",
            request={"user_id": "manual-user", "amount": "88.00"},
            mock="rpc_success",
            expect={"path": "$.approved", "equals": True},
        )

    assert isinstance(result, NotebookResult)
    assert result.output["available_limit"] == "1000.00"
    assert result.mocked is True
    assert "rpc.calculate_limit" in result._repr_html_()


def test_notebook_session_filters_operations() -> None:
    with NotebookSession(ROOT) as session:
        operations = session.operations("database")

    assert operations == [
        {
            "operation": "database.list_accounts",
            "executor": "database",
        },
        {
            "operation": "database.update_account",
            "executor": "database",
        },
    ]


def test_notebook_result_table_resolves_selected_rows(monkeypatch) -> None:
    captured = {}

    def display(value, *, max_rows):
        captured.update(value=value, max_rows=max_rows)
        return "rendered"

    monkeypatch.setattr("easytest.notebook.session.display_table", display)
    result = NotebookResult(
        step_id="query",
        executor="database",
        operation="database.query",
        output={"rows": [{"id": "account-1"}]},
        artifacts={},
        mocked=False,
    )

    assert result.table("$.rows", max_rows=1) == "rendered"
    assert captured == {"value": [{"id": "account-1"}], "max_rows": 1}


def test_notebook_uses_shared_directory_loading_and_run_settings(tmp_path):
    root = init_project(tmp_path / "project")
    with NotebookSession(root, profile="offline-strict", allow_db_write=True) as session:
        assert session.runner.settings["allow_db_write"] is True
        assert [case["id"] for case in session.cases()] == ["http.demo"]
        result = session.run_case()
    assert result["ping"].mocked is True
    assert result["ping"].output["body"] == {"ok": True}


def test_notebook_context_exit_keeps_original_error(tmp_path):
    class Broken(Executor):
        def execute(self, *_args):
            raise NotImplementedError

        def close(self):
            raise OSError("cleanup failed")

    root = init_project(tmp_path / "project")
    original = ValueError("manual failure")
    with pytest.raises(ValueError) as error:
        with NotebookSession(root, executors={"http": Broken()}):
            raise original
    assert error.value is original
    assert "OSError" in str(error.value.__notes__)
