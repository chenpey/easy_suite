from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock

import requests
import pymysql
import pytest

from easytest.config import ProjectConfig
from easytest.executors.database import DatabaseExecutor, sql_type
from easytest.executors.http import HttpExecutor
from easytest.executors.rpc import RpcExecutor
from easytest.models import Case, RunContext
from easytest.models import ConfigurationError
from easytest.transport.http import HttpClient

ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def _context(root: Path, run_mode: str = "read") -> RunContext:
    case = Case(
        id="executor.case",
        name="Executor case",
        case_type="scenario",
        enabled=True,
        tags=(),
        variables={},
        mock_profile=None,
        snapshot_profile="default",
        steps=(),
    )
    return RunContext(case=case, root=root, run_mode=run_mode, variables={})


class _Response:
    status_code = 201
    headers: ClassVar[dict[str, str]] = {"Content-Type": "application/json"}
    text = ""

    @staticmethod
    def json():
        return {"created": True}

    def close(self):
        pass


class _Session:
    def __init__(self) -> None:
        self.call = None

    def request(self, method, url, timeout, **kwargs):
        self.call = (method, url, timeout, kwargs)
        return _Response()


def test_http_executor_resolves_environment_and_merges_request(
    monkeypatch,
) -> None:
    monkeypatch.setenv("HTTP_TOKEN", "runtime-token")
    session = _Session()
    executor = HttpExecutor(session)

    result = executor.execute(
        "http.create",
        {
            "headers": {"Authorization": "Bearer ${HTTP_TOKEN}"},
            "method": "POST",
            "timeout": 3,
            "url": "https://example.invalid/users",
        },
        {"json": {"id": "user-001"}},
        _context(ROOT),
    )

    assert result.output["status_code"] == 201
    assert session.call == (
        "POST",
        "https://example.invalid/users",
        3.0,
        {
            "headers": {"Authorization": "Bearer runtime-token"},
            "json": {"id": "user-001"},
        },
    )


def test_http_executor_does_not_close_injected_client() -> None:
    client = MagicMock()
    executor = HttpExecutor(client=client)

    executor.close()

    client.close.assert_not_called()


@pytest.mark.parametrize("borrow_client", [False, True])
def test_http_executor_preserves_borrowed_settings_and_rejects_conflicts(borrow_client):
    session = requests.Session()
    session.trust_env = False
    session.request = MagicMock(return_value=_Response())
    session.close = MagicMock()
    client = HttpClient(session)
    executor = HttpExecutor(client=client) if borrow_client else HttpExecutor(session)
    operation = {"url": "https://example.invalid"}
    result = executor.execute("http.ping", operation, {}, _context(ROOT))
    assert result.output["status_code"] == 201
    assert session.trust_env is False
    with pytest.raises(ConfigurationError, match="conflicts"):
        executor.execute("http.ping", operation, {"trust_env": True}, _context(ROOT))
    session.request.assert_called_once()
    executor.close()
    session.close.assert_not_called()


def test_rpc_executor_injects_auth_from_environment(monkeypatch) -> None:
    monkeypatch.setenv("RPC_CLIENT_SECRET", "runtime-secret")
    received = {}

    def handler(**kwargs):
        received.update(kwargs)
        return {"approved": True}

    result = RpcExecutor({"rpc.limit": handler}).execute(
        "rpc.limit",
        {
            "auth": {"client_secret": "${RPC_CLIENT_SECRET}"},
            "endpoint": "mock://service",
        },
        {"user_id": "user-001"},
        _context(ROOT),
    )

    assert result.output == {"approved": True}
    assert received["auth"] == {"client_secret": "runtime-secret"}


def test_database_executor_runs_bound_query(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database = tmp_path / "accounts.db"
    connection = sqlite3.connect(database)
    connection.execute(
        "CREATE TABLE accounts "
        "(id TEXT PRIMARY KEY, user_id TEXT, status TEXT, balance TEXT)"
    )
    connection.execute(
        "INSERT INTO accounts VALUES (?, ?, ?, ?)",
        ("account-001", "user-001", "ACTIVE", "125.50"),
    )
    connection.commit()
    connection.close()
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", str(database))

    config = ProjectConfig(ROOT)
    result = DatabaseExecutor(config).execute(
        "database.list_accounts",
        config.operation("database.list_accounts", "database"),
        {"parameters": {"user_id": "user-001"}},
        _context(ROOT),
    )

    assert result.output["rowcount"] == 1
    assert result.output["sql_type"] == "SELECT"
    assert result.output["attempts"] == 1
    assert result.output["rows"] == [
        {
            "balance": "125.50",
            "id": "account-001",
            "status": "ACTIVE",
        }
    ]

    update = DatabaseExecutor(config).execute(
        "database.update_account",
        config.operation("database.update_account", "database"),
        {"id": "account-001", "status": "CLOSED"},
        _context(ROOT, run_mode="write"),
    )
    assert update.output == {
        "attempts": 1,
        "rowcount": 1,
        "rows": [],
        "sql_type": "UPDATE",
        "write": True,
    }
    connection = sqlite3.connect(database)
    assert connection.execute(
        "SELECT status FROM accounts WHERE id = ?", ("account-001",)
    ).fetchone() == ("CLOSED",)
    connection.close()


def test_database_executor_rejects_write_flag_mismatch() -> None:
    executor = DatabaseExecutor(ProjectConfig(ROOT))

    with pytest.raises(ConfigurationError, match="declares write=False"):
        executor.execute(
            "unsafe.operation",
            {
                "connection": "default",
                "statement": "UPDATE accounts SET status = :status",
                "write": False,
            },
            {"status": "CLOSED"},
            _context(ROOT, run_mode="write"),
        )


def test_database_executor_rejects_multiple_statements() -> None:
    with pytest.raises(ConfigurationError, match="exactly one SQL statement"):
        sql_type("SELECT 1; DELETE FROM accounts")


def test_database_executor_supports_sqlite_executemany(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database = tmp_path / "batch.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE events (id TEXT PRIMARY KEY)")
    connection.close()
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", str(database))
    executor = DatabaseExecutor(ProjectConfig(ROOT))

    result = executor.execute(
        "database.batch_insert",
        {
            "connection": "default",
            "execute_many": True,
            "statement": "INSERT INTO events(id) VALUES (:id)",
            "write": True,
        },
        {"parameters": [{"id": "one"}, {"id": "two"}]},
        _context(ROOT, run_mode="write"),
    )

    assert result.output["rowcount"] == 2


def test_database_executor_enforces_sqlite_read_only_connection(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database = tmp_path / "read-only.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE values_table (value TEXT)")
    connection.execute("INSERT INTO values_table VALUES ('one')")
    connection.commit()
    connection.close()
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", str(database))
    config = ProjectConfig(ROOT)
    settings = config.runtime["database"]["connections"]["default"]
    settings["read_only"] = True
    settings["pragmas"] = {"busy_timeout": 1000, "foreign_keys": "ON"}
    executor = DatabaseExecutor(config)

    result = executor.execute(
        "database.read_only_query",
        {
            "connection": "default",
            "statement": "SELECT value FROM values_table",
            "write": False,
        },
        {},
        _context(ROOT),
    )

    assert result.output["rows"] == [{"value": "one"}]
    with pytest.raises(ConfigurationError, match="configured as read-only"):
        executor.execute(
            "database.read_only_write",
            {
                "connection": "default",
                "statement": "DELETE FROM values_table",
                "write": True,
            },
            {},
        _context(ROOT, run_mode="write"),
        )


def test_database_executor_blocks_sqlite_pragma_writes_in_read_mode(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database = tmp_path / "read?mode#%.db"
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA user_version = 7")
    connection.commit()
    connection.close()
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", str(database))
    config = ProjectConfig(ROOT)
    config.runtime["database"]["connections"]["default"]["pragmas"][
        "query_only"
    ] = "OFF"
    executor = DatabaseExecutor(config)

    result = executor.execute(
        "database.read_pragma",
        {
            "connection": "default",
            "statement": "PRAGMA user_version",
            "write": False,
        },
        {},
        _context(ROOT),
    )
    assert result.output["rows"] == [{"user_version": 7}]

    with pytest.raises(sqlite3.DatabaseError, match="not authorized|readonly"):
        executor.execute(
            "database.write_pragma",
            {
                "connection": "default",
                "statement": "PRAGMA user_version = 123",
                "write": False,
            },
            {},
            _context(ROOT),
        )

    connection = sqlite3.connect(database)
    assert connection.execute("PRAGMA user_version").fetchone() == (7,)
    connection.close()


def test_database_executor_rejects_read_mode_write_pragmas_in_config(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database = tmp_path / "configured.db"
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA user_version = 7")
    connection.commit()
    connection.close()
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", str(database))
    config = ProjectConfig(ROOT)
    config.runtime["database"]["connections"]["default"]["pragmas"] = {
        "user_version": 123,
        "query_only": "OFF",
    }

    with pytest.raises(sqlite3.DatabaseError, match="not authorized|readonly"):
        DatabaseExecutor(config).execute(
            "database.read_config",
            {
                "connection": "default",
                "statement": "PRAGMA user_version",
                "write": False,
            },
            {},
            _context(ROOT),
        )

    connection = sqlite3.connect(database)
    assert connection.execute("PRAGMA user_version").fetchone() == (7,)
    connection.close()


def test_database_executor_retries_only_mysql_reads(monkeypatch) -> None:
    for key, value in {
        "DB_HOST": "localhost",
        "DB_NAME": "example",
        "DB_USER": "user",
        "DB_PASSWORD": "password",
    }.items():
        monkeypatch.setenv(key, value)
    cursor = MagicMock()
    cursor.description = [("value",)]
    cursor.fetchall.return_value = [{"value": 1}]
    connection = MagicMock()
    connection.cursor.return_value = cursor
    attempts = []

    def factory(_settings):
        attempts.append(1)
        if len(attempts) == 1:
            raise pymysql.err.OperationalError(2013, "lost connection")
        return connection

    executor = DatabaseExecutor(ProjectConfig(ROOT), factories={"mysql": factory})
    result = executor.execute(
        "database.retry_read",
        {
            "connection": "mysql_example",
            "read_retries": 1,
            "retry_delay_seconds": 0,
            "statement": "SELECT value FROM example",
            "write": False,
        },
        {},
        _context(ROOT),
    )

    assert result.output["attempts"] == 2
    assert result.output["rows"] == [{"value": 1}]


@pytest.mark.parametrize("mode,permission,allowed", [
    ("read", True, True), ("write", False, False), ("baseline", False, False),
    ("read", None, False), ("write", None, True),
])
def test_database_write_permission_is_independent_of_snapshots(
    tmp_path, monkeypatch, mode, permission, allowed,
):
    database = tmp_path / "permission.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE events (id INTEGER)")
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", str(database))
    context = _context(ROOT, mode)
    context.allow_db_write = permission
    executor = DatabaseExecutor(ProjectConfig(ROOT))
    operation = {"statement": "INSERT INTO events VALUES (1)", "write": True}
    if allowed:
        assert executor.execute("insert", operation, {}, context).output["rowcount"] == 1
    else:
        with pytest.raises(ConfigurationError, match="blocked"):
            executor.execute("insert", operation, {}, context)
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM events").fetchone() == (int(allowed),)


def test_explicit_db_permission_still_respects_connection_read_only(monkeypatch):
    monkeypatch.setenv("DB_DRIVER", "sqlite")
    monkeypatch.setenv("DB_PATH", ":memory:")
    config = ProjectConfig(ROOT)
    config.runtime["database"]["connections"]["default"]["read_only"] = True
    factory = MagicMock()
    context = _context(ROOT)
    context.allow_db_write = True
    with pytest.raises(ConfigurationError, match="configured as read-only"):
        DatabaseExecutor(config, factories={"sqlite": factory}).execute(
            "insert", {"statement": "INSERT INTO events VALUES (1)", "write": True},
            {}, context,
        )
    factory.assert_not_called()
