from __future__ import annotations

import json
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from easytest.cases.loader import load_cases
from easytest.models import ConfigurationError
from easytest.runtime.runner import CaseRunner
from easytest.snapshots.store import SnapshotRecord, SqliteSnapshotStore


ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def test_sqlite_snapshot_store_tracks_latest_completed_run(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    store.begin("run-1", "case-1")
    store.put(
        SnapshotRecord(
            run_id="run-1",
            case_id="case-1",
            name="response",
            kind="response",
            content=b'{"value":1}\n',
        )
    )
    store.finish("run-1", "case-1", success=True)

    record = store.latest_completed("case-1", "response")

    assert record is not None
    assert record.content == b'{"value":1}\n'
    assert store.healthcheck() == []


def test_sqlite_snapshot_backend_reports_structured_difference(
    tmp_path: Path,
) -> None:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "assets", tmp_path / "assets")
    case_path = tmp_path / "cases/http/profile_api.json"
    case_path.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "cases/http/profile_api.json", case_path)
    shutil.copy2(ROOT / "cases/http/profile_api.xlsx", case_path.with_suffix(".xlsx"))

    runtime_path = tmp_path / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime["snapshot_backend"] = "sqlite"
    runtime["snapshot_database"] = ".easytest/snapshots.db"
    runtime_path.write_text(json.dumps(runtime))

    case = load_cases(case_path)[0]
    with CaseRunner(tmp_path, run_mode="write") as runner:
        runner.run(case)
    with CaseRunner(tmp_path, run_mode="read") as runner:
        runner.run(case)

    mock_path = tmp_path / "config/mock_profiles.json"
    mocks = json.loads(mock_path.read_text())
    mocks["presets"]["http_success"]["response"]["body"]["name"] = "Changed User"
    mock_path.write_text(json.dumps(mocks))

    with (
        CaseRunner(tmp_path, run_mode="read") as runner,
        pytest.raises(AssertionError, match=r"\$\.body\.name"),
    ):
        runner.run(case)


def _save_run(store, run_id, *, case_id="case-1", names=("response",), success=True):
    store.begin(run_id, case_id)
    for name in names:
        store.put(SnapshotRecord(
            run_id=run_id, case_id=case_id, name=name, kind="response",
            content=json.dumps({"value": run_id}).encode(),
        ))
    if success is not None:
        store.finish(run_id, case_id, success=success)


def _history(path):
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute(
            """
            SELECT r.case_id, r.run_id, r.status, i.name
            FROM snapshot_runs r LEFT JOIN snapshot_items i
              ON r.case_id = i.case_id AND r.run_id = i.run_id
            ORDER BY r.id, i.name
            """
        ).fetchall()


@pytest.mark.parametrize("keep,expected_runs", [
    (1, ["run-3"]), (2, ["run-2", "run-3"]), (None, ["run-1", "run-2", "run-3"]),
])
def test_history_keep_limits_successful_versions_including_current(
    tmp_path, keep, expected_runs,
):
    store = SqliteSnapshotStore(tmp_path / "history.db", history_keep=keep)
    for run in ("run-1", "run-2", "run-3"):
        _save_run(store, run)
    assert _history(store.path) == [
        ("case-1", run, "completed", "response") for run in expected_runs
    ]
    assert store.latest_completed("case-1", "response").run_id == "run-3"
    assert store.healthcheck() == []


def test_history_keep_preserves_baselines_missing_from_partial_updates(tmp_path):
    store = SqliteSnapshotStore(tmp_path / "history.db", history_keep=1)
    _save_run(store, "run-1", names=("first", "second"))
    _save_run(store, "run-2", names=("first",))
    _save_run(store, "run-3", names=("first",))
    assert _history(store.path) == [
        ("case-1", "run-1", "completed", "second"),
        ("case-1", "run-3", "completed", "first"),
    ]
    assert store.latest_completed("case-1", "first").run_id == "run-3"
    assert store.latest_completed("case-1", "second").run_id == "run-1"


def test_history_keep_only_prunes_after_success_and_leaves_other_runs_alone(tmp_path):
    path = tmp_path / "history.db"
    store = SqliteSnapshotStore(path)
    _save_run(store, "run-1")
    _save_run(store, "run-2")
    _save_run(store, "other-1", case_id="other")
    _save_run(store, "other-2", case_id="other")
    _save_run(store, "pending", success=None)
    _save_run(store, "rejected", success=None)

    bounded = SqliteSnapshotStore(path, history_keep=1)
    bounded.finish("rejected", "case-1", success=False)
    before = _history(path)
    assert ("case-1", "run-1", "completed", "response") in before
    assert ("case-1", "run-2", "completed", "response") in before
    _save_run(bounded, "run-3")

    assert _history(path) == [
        row for row in before if row[1] not in {"run-1", "run-2"}
    ] + [("case-1", "run-3", "completed", "response")]
    assert bounded.latest_completed("case-1", "response").run_id == "run-3"


def test_pruning_failure_rolls_back_completion_and_keeps_previous_baseline(tmp_path):
    store = SqliteSnapshotStore(tmp_path / "history.db", history_keep=1)
    _save_run(store, "run-1")
    with closing(sqlite3.connect(store.path)) as connection:
        connection.execute(
            """
            CREATE TRIGGER prevent_delete BEFORE DELETE ON snapshot_items
            BEGIN SELECT RAISE(ABORT, 'cannot prune'); END
            """
        )
        connection.commit()
    with pytest.raises(sqlite3.IntegrityError, match="cannot prune"):
        _save_run(store, "run-2")
    assert _history(store.path) == [
        ("case-1", "run-1", "completed", "response"),
        ("case-1", "run-2", "running", "response"),
    ]
    assert store.latest_completed("case-1", "response").run_id == "run-1"


@pytest.mark.parametrize("keep", [0, True])
def test_store_rejects_invalid_history_keep_before_creating_database(tmp_path, keep):
    path = tmp_path / "history.db"
    with pytest.raises(ConfigurationError, match="snapshot_history_keep"):
        SqliteSnapshotStore(path, history_keep=keep)
    assert not path.exists()


def _sqlite_project(root, *, history_keep):
    shutil.copytree(ROOT / "config", root / "config")
    runtime_path = root / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime.update(snapshot_backend="sqlite", snapshot_history_keep=history_keep)
    runtime_path.write_text(json.dumps(runtime))
    return load_cases(ROOT / "cases/http/profile_api.json")[0]


def test_read_mode_neither_appends_nor_prunes_history(tmp_path):
    case = _sqlite_project(tmp_path, history_keep=None)
    with CaseRunner(tmp_path, run_mode="write") as runner:
        for _ in range(3):
            runner.run(case)
        path = runner.snapshots.store.path
    before = _history(path)
    assert len(before) == 3

    runtime_path = tmp_path / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime["snapshot_history_keep"] = 1
    runtime_path.write_text(json.dumps(runtime))
    with CaseRunner(tmp_path, run_mode="read") as runner:
        for _ in range(5):
            runner.run(case)
    assert _history(path) == before


def test_explicit_baseline_updates_keep_configured_versions(tmp_path, monkeypatch):
    case = _sqlite_project(tmp_path, history_keep=2)
    monkeypatch.setenv("CONFIRM_BASELINE", "1")
    mock_path = tmp_path / "config/mock_profiles.json"
    mocks = json.loads(mock_path.read_text())
    for name in ("First", "Second", "Third"):
        mocks["presets"]["http_success"]["response"]["body"]["name"] = name
        mock_path.write_text(json.dumps(mocks))
        with CaseRunner(tmp_path, run_mode="baseline") as runner:
            runner.run(case)
            store = runner.snapshots.store
            current = store.latest_completed(case.id, "response")
            assert json.loads(current.content)["body"]["name"] == name
    history = _history(store.path)
    assert len(history) == 2
    assert all(row[2] == "completed" for row in history)
    with CaseRunner(tmp_path, run_mode="read") as runner:
        runner.run(case)
    assert _history(store.path) == history

    monkeypatch.delenv("CONFIRM_BASELINE")
    with CaseRunner(tmp_path, run_mode="baseline") as runner:
        with pytest.raises(ConfigurationError, match="CONFIRM_BASELINE=1"):
            runner.run(case)
    assert _history(store.path) == history
