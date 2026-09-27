import json
import sqlite3
from contextlib import closing

import pytest

from easytest.notebook import NotebookSession
from easytest.starter import init_project


def _seed(path, value):
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE origin (value TEXT)")
        connection.execute("INSERT INTO origin VALUES (?)", (value,))
        connection.commit()


def _project(tmp_path, database, **settings):
    root = init_project(tmp_path / "project")
    (root / "config/runtime.json").write_text(json.dumps({
        "database": {"connections": {"default": {
            "driver": "sqlite", "database": database, **settings,
        }}},
    }))
    (root / "config/operations.json").write_text(json.dumps({"operations": {
        "read": {"executor": "database", "statement": "SELECT value FROM origin"},
        "write": {"executor": "database", "statement": "UPDATE origin SET value='UPDATED'", "write": True},
        "constant": {"executor": "database", "statement": "SELECT 7 AS value"},
    }}))
    return root


@pytest.mark.parametrize("write", [False, True])
@pytest.mark.parametrize("filename", ["business.db", "business ?#%.db"])
def test_database_paths_use_project_root_for_connections_and_locks(tmp_path, monkeypatch, write, filename):
    root = _project(tmp_path, filename)
    other = tmp_path / "caller"
    other.mkdir()
    _seed(root / filename, "PROJECT")
    _seed(other / filename, "CWD")
    monkeypatch.chdir(other)
    with NotebookSession(root, allow_db_write=write) as session:
        if write:
            session.run_step(executor="database", operation="write")
        result = session.run_step(executor="database", operation="read")
        assert result.output["rows"] == [{"value": "UPDATED" if write else "PROJECT"}]
        monkeypatch.chdir(root)
        assert session.run_step(executor="database", operation="read").output == result.output
    with closing(sqlite3.connect(other / filename)) as connection:
        assert connection.execute("SELECT value FROM origin").fetchone() == ("CWD",)
    assert (root / f"{filename}.lock").exists() is write
    assert not (other / f"{filename}.lock").exists()


@pytest.mark.parametrize("database,uri", [
    (":memory:", False),
    ("file::memory:?cache=shared", True),
    ("file:easytest-memory?mode=memory&cache=shared", True),
])
def test_database_paths_preserve_memory_semantics(tmp_path, database, uri):
    root = _project(tmp_path, database, uri=uri)
    with NotebookSession(root, allow_db_write=False) as session:
        assert session.run_step(executor="database", operation="constant").output["rows"] == [{"value": 7}]
    assert not list(root.glob("*.lock"))


@pytest.mark.parametrize("relative", [False, True])
def test_database_paths_preserve_explicit_uri_and_query(tmp_path, monkeypatch, relative):
    external = tmp_path / "external"
    external.mkdir()
    database = external / "uri #%.db"
    _seed(database, "URI")
    uri = "file:uri%20%23%25.db?cache=shared" if relative else database.as_uri() + "?cache=shared"
    root = _project(tmp_path, uri, uri=True)
    monkeypatch.chdir(external)
    with NotebookSession(root, allow_db_write=False) as session:
        assert session.run_step(executor="database", operation="read").output["rows"] == [{"value": "URI"}]
