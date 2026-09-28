from __future__ import annotations

import os
import json
import shutil
import sqlite3
from concurrent.futures import ProcessPoolExecutor
from contextlib import closing
from pathlib import Path

import pytest

from easytest.cases.loader import load_cases
from easytest.cli import main
from easytest.config import ProjectConfig
from easytest.models import Case, ConfigurationError, ExecutionResult, RunContext
from easytest.runtime.preflight import preflight
from easytest.runtime.runner import CaseRunner
from easytest.snapshots.codec import (
    SNAPSHOT_ARTIFACT_MAGIC,
    SNAPSHOT_RAW_MAGIC,
    SNAPSHOT_ZLIB_MAGIC,
    decode_snapshot,
    encode_snapshot,
    snapshot_artifact_target,
)
from easytest.snapshots.manager import SnapshotManager
from easytest.snapshots.store import (
    SNAPSHOT_SCHEMA_VERSION,
    SnapshotConflictError,
    SnapshotRecord,
    SqliteSnapshotStore,
)
from easytest.starter import init_project


ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def _write_snapshot_in_process(arguments):
    path, artifact_dir, index = arguments
    store = SqliteSnapshotStore(path, artifact_dir=artifact_dir)
    run_id = f"run-{index}"
    case_id = f"case-{index}"
    store.begin(run_id, case_id)
    store.put(SnapshotRecord(
        run_id=run_id,
        case_id=case_id,
        name="response",
        kind="response",
        content=json.dumps({"value": index}).encode(),
    ))
    store.finish(run_id, case_id, success=True)
    return store.latest_completed(case_id, "response").content


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


def test_snapshot_codec_is_adaptive_bounded_and_strict() -> None:
    compressible = b"x" * 1000
    incompressible = os.urandom(1000)
    assert encode_snapshot(compressible).startswith(SNAPSHOT_ZLIB_MAGIC)
    assert encode_snapshot(incompressible).startswith(SNAPSHOT_RAW_MAGIC)
    assert decode_snapshot(encode_snapshot(compressible)) == compressible
    assert decode_snapshot(encode_snapshot(incompressible)) == incompressible
    with pytest.raises(ValueError, match="unknown snapshot payload codec"):
        decode_snapshot(b"unmarked")
    with pytest.raises(ConfigurationError, match="snapshot_max_bytes"):
        decode_snapshot(
            encode_snapshot(b"x" * 1000),
            max_bytes=32,
        )


def test_sqlite_text_payload_is_rejected_as_corrupt(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    store.begin("run-1", "case-1")
    with closing(sqlite3.connect(store.path)) as connection:
        connection.execute(
            """
            INSERT INTO snapshot_items(run_id, case_id, name, kind, content)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                "run-1",
                "case-1",
                "response",
                "response",
                SNAPSHOT_RAW_MAGIC.decode() + '{"value":1}',
            ),
        )
        connection.commit()
    store.finish("run-1", "case-1", success=True)

    with pytest.raises(ValueError, match="must be bytes"):
        store.latest_completed("case-1", "response")
    assert any("must be bytes" in issue for issue in store.healthcheck())


def test_oversized_sqlite_blob_is_rejected_before_decoding(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db", max_snapshot_bytes=8)
    store.begin("run-1", "case-1")
    with closing(sqlite3.connect(store.path)) as connection:
        connection.execute(
            """
            INSERT INTO snapshot_items(run_id, case_id, name, kind, content)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("run-1", "case-1", "response", "response", b"x" * 128),
        )
        connection.commit()
    store.finish("run-1", "case-1", success=True)

    with pytest.raises(ConfigurationError, match="snapshot_max_bytes"):
        store.latest_completed("case-1", "response")
    assert any("snapshot_max_bytes" in issue for issue in store.healthcheck())


def test_screenshot_payload_is_external_and_verified(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(
        tmp_path / "history.db",
        artifact_dir=tmp_path / "artifacts",
    )
    content = b"\x89PNG\r\n\x1a\n" + os.urandom(128)
    store.begin("run-1", "case-1")
    target = store.put_artifact(SnapshotRecord(
        run_id="run-1",
        case_id="case-1",
        name="page",
        kind="screenshot",
        content=content,
    ), ".png")
    store.finish("run-1", "case-1", success=True)

    with closing(sqlite3.connect(store.path)) as connection:
        stored = decode_snapshot(
            connection.execute("SELECT content FROM snapshot_items").fetchone()[0]
        )
    assert stored.startswith(SNAPSHOT_ARTIFACT_MAGIC)
    assert content not in stored
    assert target.read_bytes() == content
    assert store.latest_completed("case-1", "page").content == content
    assert store.statistics()["artifact_count"] == 1
    assert store.healthcheck() == []

    target.write_bytes(b"corrupt")
    with pytest.raises(ConfigurationError, match="size does not match"):
        store.latest_completed("case-1", "page")
    target.write_bytes(b"x" * len(content))
    with pytest.raises(ConfigurationError, match="checksum does not match"):
        store.latest_completed("case-1", "page")
    assert store.healthcheck()


@pytest.mark.parametrize("path", [
    "../outside.png",
    "aa/not-the-reference-hash.png",
    "aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.exe",
])
def test_snapshot_artifact_references_cannot_escape_content_addressing(
    tmp_path: Path,
    path: str,
) -> None:
    with pytest.raises(ValueError, match="unsafe snapshot artifact reference"):
        snapshot_artifact_target(tmp_path, {
            "path": path,
            "sha256": "a" * 64,
            "size": 1,
        })


def test_screenshot_cannot_be_embedded_in_sqlite(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    store.begin("run-1", "case-1")
    with pytest.raises(ConfigurationError, match="external artifact"):
        store.put(SnapshotRecord(
            "run-1", "case-1", "page", "screenshot", b"image",
        ))


def test_maintenance_removes_failed_artifacts(
    tmp_path: Path,
) -> None:
    store = SqliteSnapshotStore(
        tmp_path / "history.db",
        artifact_dir=tmp_path / "artifacts",
    )
    content = b"\x89PNG\r\n\x1a\ncurrent-image"
    store.begin("completed", "case-1")
    completed = store.put_artifact(
        SnapshotRecord("completed", "case-1", "page", "screenshot", content),
        ".png",
    )
    store.finish("completed", "case-1", success=True)
    store.begin("failed", "case-2")
    orphan = store.put_artifact(
        SnapshotRecord("failed", "case-2", "page", "screenshot", content + b"-failed"),
        ".png",
    )
    store.finish("failed", "case-2", success=False)

    result = store.maintain(keep_failed=0, compact=True)

    assert result["removed_failed_runs"] == 1
    assert result["removed_artifacts"] == 1
    assert not orphan.exists()
    assert completed.exists()
    assert store.latest_completed("case-1", "page").content == content
    assert store.statistics()["schema_version"] == SNAPSHOT_SCHEMA_VERSION


def test_maintenance_never_follows_symlinked_artifact_shards(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    outside = tmp_path / "outside"
    outside.mkdir()
    external = outside / f"{'a' * 64}.png"
    external.write_bytes(b"outside")
    artifact_dir.mkdir()
    try:
        (artifact_dir / "aa").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")
    store = SqliteSnapshotStore(
        tmp_path / "history.db",
        artifact_dir=artifact_dir,
    )

    result = store.maintain(keep_failed=0)

    assert result["removed_artifacts"] == 0
    assert external.read_bytes() == b"outside"
    assert store.statistics()["artifact_count"] == 0


def test_non_current_snapshot_schema_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "unsupported.db"
    with closing(sqlite3.connect(path)) as connection:
        connection.execute(f"PRAGMA user_version={SNAPSHOT_SCHEMA_VERSION + 1}")
    before = path.read_bytes()
    with pytest.raises(ConfigurationError, match="unsupported snapshot database schema"):
        SqliteSnapshotStore(path)
    assert path.read_bytes() == before


def test_unversioned_populated_database_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "unversioned.db"
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE previous_format (value BLOB)")
    with pytest.raises(ConfigurationError, match="unsupported snapshot database schema 0"):
        SqliteSnapshotStore(path)


def test_current_schema_rejects_unexpected_tables(tmp_path: Path) -> None:
    path = tmp_path / "unexpected.db"
    store = SqliteSnapshotStore(path)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE compatibility_data (value BLOB)")
        connection.commit()

    assert store.healthcheck() == [
        "schema objects do not match the current contract",
        "unexpected tables: ['compatibility_data']",
    ]
    with pytest.raises(ConfigurationError, match="schema does not match"):
        SqliteSnapshotStore(path)


def test_current_schema_rejects_missing_required_index(tmp_path: Path) -> None:
    path = tmp_path / "missing-index.db"
    store = SqliteSnapshotStore(path)
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("DROP INDEX idx_snapshot_baseline")
        connection.commit()

    assert "schema objects do not match" in store.healthcheck()[0]
    with pytest.raises(ConfigurationError, match="schema does not match"):
        SqliteSnapshotStore(path)


def test_finished_run_keeps_stable_lease_inode(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    lock_path = store._run_lock_path("run-1", "case-1")
    store.begin("run-1", "case-1")
    store.put(SnapshotRecord(
        "run-1", "case-1", "response", "response", b'{"ok":true}',
    ))
    store.finish("run-1", "case-1", success=True)

    assert lock_path.is_file()


def test_maintenance_removes_stale_running_rows(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    store.begin("abandoned", "case-1")
    store.put(SnapshotRecord(
        "abandoned", "case-1", "response", "response", b'{"pending":true}',
    ))
    with closing(sqlite3.connect(store.path)) as connection:
        connection.execute(
            "UPDATE snapshot_runs SET created_at='2000-01-01 00:00:00'"
        )
        connection.commit()
    store._release_run_lock(("abandoned", "case-1"))

    result = store.maintain(stale_after_seconds=60)

    assert result["removed_stale_runs"] == 1
    assert store.statistics()["runs"] == {}


def test_maintenance_does_not_delete_active_running_rows(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    store.begin("active", "case-1")
    store.put(SnapshotRecord(
        "active", "case-1", "response", "response", b'{"active":true}',
    ))
    with closing(sqlite3.connect(store.path)) as connection:
        connection.execute(
            "UPDATE snapshot_runs SET created_at='2000-01-01 00:00:00'"
        )
        connection.commit()

    result = store.maintain(stale_after_seconds=0)

    assert result["removed_stale_runs"] == 0
    assert store.statistics()["runs"] == {"running": 1}
    store.finish("active", "case-1", success=True)


def test_screenshot_size_is_checked_before_reading_full_file(tmp_path: Path) -> None:
    root = init_project(tmp_path / "project")
    runtime_path = root / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime["snapshot_max_bytes"] = 8
    runtime_path.write_text(json.dumps(runtime))
    (root / "config/snapshots.json").write_text(json.dumps({
        "profiles": {"default": {"image": {"kind": "screenshot"}}},
    }))
    image = root / "large.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x")
    manager = SnapshotManager(ProjectConfig(root))
    context = RunContext(Case("case-1"), root, "write", {})
    result = ExecutionResult(
        "ui",
        "capture",
        {},
        artifacts={"screenshot": image},
    )

    with pytest.raises(ConfigurationError, match="snapshot_max_bytes") as caught:
        manager.process(
            spec={"rule": "image"},
            result=result,
            context=context,
            step_id="page",
        )

    assert caught.value.code == "SNAPSHOT_TOO_LARGE"
    assert not list((root / "snapshots").rglob("*"))


def test_file_snapshot_baseline_read_is_bounded(tmp_path: Path) -> None:
    target = tmp_path / "large.json"
    target.write_bytes(b"x" * 9)

    with pytest.raises(ConfigurationError, match="snapshot_max_bytes"):
        SnapshotManager._assert_or_write(
            target,
            b"{}",
            "read",
            max_bytes=8,
        )


def test_finished_run_without_snapshot_items_is_not_retained(tmp_path: Path) -> None:
    store = SqliteSnapshotStore(tmp_path / "history.db")
    store.begin("empty-success", "case-1")
    store.finish("empty-success", "case-1", success=True)
    store.begin("empty-failure", "case-1")
    store.finish("empty-failure", "case-1", success=False)
    assert store.statistics()["runs"] == {}


def test_concurrent_baseline_change_is_rejected_without_silent_overwrite(
    tmp_path: Path,
) -> None:
    path = tmp_path / "history.db"
    first = SqliteSnapshotStore(path)
    second = SqliteSnapshotStore(path)
    first.begin("run-1", "case-1")
    second.begin("run-2", "case-1")
    first.put(SnapshotRecord("run-1", "case-1", "response", "response", b"first"))
    second.put(SnapshotRecord("run-2", "case-1", "response", "response", b"second"))
    first.finish("run-1", "case-1", success=True)

    with pytest.raises(SnapshotConflictError, match="baseline changed") as caught:
        second.finish("run-2", "case-1", success=True)

    assert caught.value.code == "SNAPSHOT_CONFLICT"
    assert first.latest_completed("case-1", "response").content == b"first"
    assert first.statistics()["runs"] == {"completed": 1, "conflict": 1}


def test_concurrent_processes_can_write_distinct_cases(tmp_path: Path) -> None:
    path = tmp_path / "history.db"
    artifact_dir = tmp_path / "artifacts"
    arguments = [(path, artifact_dir, index) for index in range(8)]
    with ProcessPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(_write_snapshot_in_process, arguments))

    assert [json.loads(content)["value"] for content in results] == list(range(8))
    store = SqliteSnapshotStore(path, artifact_dir=artifact_dir)
    assert store.statistics()["runs"] == {"completed": 8}
    assert store.healthcheck() == []


def test_snapshot_cli_checks_and_maintains_store(tmp_path, capsys) -> None:
    root = init_project(tmp_path / "project")
    runtime_path = root / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime.update(snapshot_backend="sqlite", snapshot_history_keep=1)
    runtime_path.write_text(json.dumps(runtime))
    store = SqliteSnapshotStore(root / ".easytest/snapshots.db")
    store.begin("failed", "case-1")
    store.put(SnapshotRecord(
        "failed", "case-1", "response", "response", b'{"failed":true}',
    ))
    store.finish("failed", "case-1", success=False)

    main(["snapshot", "check", "--root", str(root)])
    checked = json.loads(capsys.readouterr().out)
    assert checked["status"] == "healthy"
    assert checked["data"]["runs"] == {"failed": 1}

    main([
        "snapshot", "maintain", "--root", str(root),
        "--keep-failed", "0", "--compact",
    ])
    maintained = json.loads(capsys.readouterr().out)
    assert maintained["status"] == "maintained"
    assert maintained["data"]["maintenance"]["removed_failed_runs"] == 1


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


def test_sqlite_manager_keeps_screenshot_bytes_outside_database(
    tmp_path: Path,
) -> None:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    shutil.copytree(ROOT / "assets", tmp_path / "assets")
    source = ROOT / "cases/scenario/account_flow.json"
    target = tmp_path / "cases/scenario/account_flow.json"
    target.parent.mkdir(parents=True)
    shutil.copy2(source, target)
    shutil.copy2(source.with_suffix(".xlsx"), target.with_suffix(".xlsx"))
    runtime_path = tmp_path / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime.update(
        snapshot_backend="sqlite",
        snapshot_database=".easytest/snapshots.db",
        snapshot_artifact_dir=".easytest/snapshot-artifacts",
    )
    runtime_path.write_text(json.dumps(runtime))
    case = load_cases(target)[0]

    with CaseRunner(tmp_path, run_mode="write") as runner:
        runner.run(case)
        store = runner.snapshots.store
        assert store is not None
        database = store.path
        artifact_dir = store.artifact_dir
    with closing(sqlite3.connect(database)) as connection:
        screenshot = connection.execute(
            "SELECT content FROM snapshot_items WHERE kind='screenshot'"
        ).fetchone()[0]
    assert decode_snapshot(screenshot).startswith(SNAPSHOT_ARTIFACT_MAGIC)
    assert list(artifact_dir.glob("*/*.png"))

    with CaseRunner(tmp_path, run_mode="read") as runner:
        runner.run(case)

    screenshot_target = next(artifact_dir.glob("*/*.png"))
    screenshot_target.unlink()
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    config = ProjectConfig(tmp_path)
    with pytest.raises(ConfigurationError, match="cannot read SQLite snapshot artifact"):
        preflight([case], config, config.resolve_run(run_mode="read"))


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
