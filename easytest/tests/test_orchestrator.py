from __future__ import annotations

import shutil
import json
from dataclasses import replace
from pathlib import Path

import pytest

from easytest.cases.loader import load_cases
from easytest.config import ProjectConfig
from easytest.executors.base import Executor
from easytest.executors.database import DatabaseExecutor
from easytest.models import CleanupError, ConfigurationError, ExecutionResult, RunContext
from easytest.runtime.runner import CaseRunner
from easytest.snapshots.manager import SnapshotManager
from easytest.starter import init_project

ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def _example_project(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "assets", tmp_path / "assets")
    source = ROOT / "cases" / "scenario" / "account_flow.json"
    target = tmp_path / "cases" / "scenario" / source.name
    target.parent.mkdir(parents=True)
    shutil.copy2(source, target)
    shutil.copy2(source.with_suffix(".xlsx"), target.with_suffix(".xlsx"))
    return tmp_path


def test_mocked_scenario_covers_all_executor_types(tmp_path: Path) -> None:
    root = _example_project(tmp_path)
    case = load_cases(root / "cases/scenario/account_flow.json")[0]

    written = CaseRunner(root, run_mode="write").run(case)
    verified = CaseRunner(root, run_mode="read").run(case)

    assert set(verified) == {"seed_user", "profile", "limit", "accounts", "dashboard"}
    assert written["seed_user"].mocked is True
    assert all(
        written[step].mocked for step in ("profile", "limit", "accounts", "dashboard")
    )
    assert (root / "snapshots/scenario.account_flow/dashboard.png").is_file()


def test_database_write_is_blocked_in_read_mode(tmp_path: Path) -> None:
    root = _example_project(tmp_path)
    config = ProjectConfig(root)
    executor = DatabaseExecutor(config)
    case = load_cases(root / "cases/scenario/account_flow.json")[0]
    context = RunContext(
        case=case,
        root=root,
        run_mode="read",
        variables={},
    )

    with pytest.raises(ConfigurationError, match="blocked in read mode"):
        executor.execute(
            "database.update_account",
            config.operation("database.update_account", "database"),
            {"id": "account-001", "status": "CLOSED"},
            context,
        )


def test_baseline_mode_requires_explicit_confirmation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CONFIRM_BASELINE", raising=False)

    with pytest.raises(ConfigurationError, match="CONFIRM_BASELINE=1"):
        SnapshotManager._assert_or_write(
            tmp_path / "snapshot.json",
            b"{}\n",
            "baseline",
        )


def test_runner_default_http_is_shared_within_case_and_isolated_between_cases(
    monkeypatch,
) -> None:
    monkeypatch.setenv("BASE_URL", "https://example.invalid")
    monkeypatch.setenv("HTTP_TOKEN", "test-token")
    instances = []
    observed_cookies = []

    class Http(Executor):
        def __init__(self):
            self.cookie = None
            self.closed = 0
            instances.append(self)

        def execute(self, operation_name, operation, request, context):
            observed_cookies.append(self.cookie)
            self.cookie = "login-cookie"
            return ExecutionResult("http", operation_name, {"status_code": 200})

        def close(self):
            self.closed += 1

    monkeypatch.setattr("easytest.runtime.runner.HttpExecutor", Http)
    original = load_cases(ROOT / "cases/http/profile_api.json")[0]
    first = replace(original.steps[0], snapshot=None, expect=None, mock=False)
    second = replace(first, id="second", order=2)
    case = replace(original, steps=(first, second))

    with CaseRunner(ROOT, profile="live") as runner:
        runner.run(case)
        runner.run(case)

    assert observed_cookies == [None, "login-cookie", None, "login-cookie"]
    assert len(instances) == 2
    assert [item.closed for item in instances] == [1, 1]


def test_runner_close_attempts_remaining_resources_once_after_failure() -> None:
    class Resource(Executor):
        def __init__(self, fails=False):
            self.fails = fails
            self.closed = 0

        def execute(self, *_args):
            raise AssertionError("this test only closes resources")

        def close(self):
            self.closed += 1
            if self.fails:
                raise RuntimeError("close failed")

    broken = Resource(fails=True)
    other = Resource()
    runner = CaseRunner(
        ROOT, executors={"first": broken, "alias": broken, "last": other}
    )

    with pytest.raises(RuntimeError):
        runner.close()

    assert broken.closed == 1
    assert other.closed == 1
    runner.close()
    assert broken.closed == other.closed == 1


def test_runner_preserves_execution_error_when_snapshot_finish_fails(
    monkeypatch,
) -> None:
    original_error = ValueError("business failed")

    class FailedHttp(Executor):
        def execute(self, *_args):
            raise original_error

    def finish(_context, *, success):
        raise OSError("snapshot storage failed")

    original = load_cases(ROOT / "cases/http/profile_api.json")[0]
    case = replace(
        original, steps=(replace(original.steps[0], mock=False, snapshot=None),)
    )
    with CaseRunner(ROOT, profile="live", executors={"http": FailedHttp()}) as runner:
        monkeypatch.setattr(runner.snapshots, "finish_case", finish)
        with pytest.raises(ValueError) as error:
            runner.run(case)

    assert error.value is original_error
    assert any("OSError" in note for note in error.value.__notes__)


@pytest.mark.parametrize("failure", [None, ValueError("failed"), KeyboardInterrupt()])
def test_case_cleanup_precedes_snapshot_finish(monkeypatch, failure) -> None:
    monkeypatch.setenv("BASE_URL", "https://example.invalid")
    monkeypatch.setenv("HTTP_TOKEN", "test-token")
    finished = []
    closed = []

    class Http(Executor):
        def execute(self, operation_name, *_args):
            if failure is not None:
                raise failure
            return ExecutionResult("http", operation_name, {})

        def close(self):
            closed.append(True)
            raise OSError("password=should-not-appear")

    monkeypatch.setattr("easytest.runtime.runner.HttpExecutor", Http)
    original = load_cases(ROOT / "cases/http/profile_api.json")[0]
    case = replace(original, steps=(replace(
        original.steps[0], mock=False, snapshot=None, expect=None,
    ),))
    with CaseRunner(ROOT, profile="live") as runner:
        def finish(_context, *, success):
            assert closed == [True]
            finished.append(success)

        monkeypatch.setattr(runner.snapshots, "finish_case", finish)
        with pytest.raises(type(failure) if failure is not None else CleanupError) as error:
            runner.run(case)
        if failure is not None:
            assert error.value is failure
            assert "should-not-appear" not in str(error.value.__notes__)
        assert finished == [False]
        assert "case.done" not in [event["event"] for event in runner.last_events]


def test_begin_failure_finishes_unsuccessfully_without_creating_http(monkeypatch):
    original = load_cases(ROOT / "cases/http/profile_api.json")[0]
    finishes = []
    error = RuntimeError("begin failed")

    def begin(_context):
        raise error

    def unexpected_http():
        raise AssertionError("HTTP should be lazy")

    monkeypatch.setattr("easytest.runtime.runner.HttpExecutor", unexpected_http)
    with CaseRunner(ROOT) as runner:
        monkeypatch.setattr(runner.snapshots, "begin_case", begin)
        monkeypatch.setattr(
            runner.snapshots, "finish_case",
            lambda _context, *, success: finishes.append(success),
        )
        with pytest.raises(RuntimeError) as caught:
            runner.run(original)
    assert caught.value is error
    assert finishes == [False]


def test_context_exit_preserves_original_error_and_closes_resources():
    class Broken(Executor):
        def execute(self, *_args):
            raise NotImplementedError

        def close(self):
            raise OSError("password=secret")

    original = ValueError("original")
    with pytest.raises(ValueError) as caught:
        with CaseRunner(ROOT, executors={"http": Broken()}):
            raise original
    assert caught.value is original
    assert any("OSError" in note for note in caught.value.__notes__)
    assert "secret" not in str(caught.value.__notes__)


@pytest.mark.parametrize("mock", [None, False, {"kind": "inject", "request": {"extra": 1}}])
def test_strict_mode_blocks_every_decision_without_a_result(tmp_path, monkeypatch, mock):
    from easytest.models import MockMissError

    root = init_project(tmp_path / "project")
    path = root / "config/mock_profiles.json"
    document = json.loads(path.read_text())
    document["profiles"]["empty"] = {}
    path.write_text(json.dumps(document))
    original = load_cases(root / "cases/demo.json")[0]
    case = replace(
        original, mock_profile="empty",
        steps=(replace(original.steps[0], mock=mock),),
    )
    # The empty Case profile takes priority; it must not fall back to offline.
    def create_http():
        raise AssertionError("strict gate must run before constructing HTTP")

    monkeypatch.setattr("easytest.runtime.runner.HttpExecutor", create_http)
    with CaseRunner(root) as runner:
        with pytest.raises(MockMissError):
            runner.run(case)
        explicit = replace(case, steps=(replace(
            case.steps[0],
            mock={"response": {"status_code": 200, "body": {"ok": True}}},
        ),))
        assert runner.run(explicit)["ping"].mocked is True


def test_assertion_failure_skips_snapshot_and_preserves_source_location(tmp_path, monkeypatch):
    from unittest.mock import Mock

    root = init_project(tmp_path / "project")
    original = load_cases(root / "cases/demo.json")[0]
    case = replace(original, steps=(replace(
        original.steps[0], expect={"$.status_code": 500},
    ),))
    with CaseRunner(root) as runner:
        process = Mock()
        monkeypatch.setattr(runner.snapshots, "process", process)
        with pytest.raises(AssertionError) as error:
            runner.run(case)
        process.assert_not_called()
    assert "demo.xlsx" in str(error.value.__notes__)
    assert "sheet=steps, row=2" in str(error.value.__notes__)


def test_case_cleanup_failure_cannot_create_a_completed_sqlite_baseline(tmp_path, monkeypatch):
    monkeypatch.setenv("BASE_URL", "https://example.invalid")
    monkeypatch.setenv("HTTP_TOKEN", "test-token")
    root = _example_project(tmp_path)
    runtime_path = root / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime["snapshot_backend"] = "sqlite"
    runtime_path.write_text(json.dumps(runtime))

    class Http(Executor):
        def execute(self, operation_name, *_args):
            return ExecutionResult(
                "http", operation_name, {"status_code": 200, "body": {"status": "ACTIVE"}},
            )

        def close(self):
            raise OSError("cleanup failed")

    monkeypatch.setattr("easytest.runtime.runner.HttpExecutor", Http)
    original = load_cases(ROOT / "cases/http/profile_api.json")[0]
    case = replace(original, steps=(replace(original.steps[0], mock=False),))
    with CaseRunner(root, profile="live", run_mode="write") as runner:
        with pytest.raises(CleanupError):
            runner.run(case)
        assert runner.snapshots.store.latest_completed(case.id, "response") is None


def test_component_initialization_failure_closes_acquired_resources(monkeypatch):
    from unittest.mock import Mock

    acquired = Mock(spec=Executor)
    original = ValueError("initialization failed")
    monkeypatch.setattr("easytest.runtime.runner.ScenarioExecutor", lambda _handlers: acquired)
    monkeypatch.setattr("easytest.runtime.runner.RpcExecutor", Mock(side_effect=original))
    with pytest.raises(ValueError) as error:
        CaseRunner(ROOT)
    assert error.value is original
    acquired.close.assert_called_once()
