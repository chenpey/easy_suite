from __future__ import annotations

import socket
import sqlite3
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import closing, nullcontext
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

import pymysql
import sqlparse
from filelock import FileLock

from easytest.config import ProjectConfig
from easytest.executors.base import Executor
from easytest.models import ConfigurationError, ExecutionResult, RunContext
from easytest.serialization import to_jsonable


ConnectionFactory = Callable[[dict[str, Any]], Any]
READ_SQL_TYPES = {"SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "PRAGMA"}
WRITE_SQL_TYPES = {
    "ALTER",
    "CREATE",
    "DELETE",
    "DROP",
    "INSERT",
    "REPLACE",
    "TRUNCATE",
    "UPDATE",
}
RETRYABLE_MYSQL_CODES = {2003, 2006, 2013, 2014, 2055}
SQLITE_WRITE_PRAGMAS = {"journal_mode", "locking_mode", "synchronous"}
SQLITE_CONNECTION_PRAGMAS = {
    "automatic_index",
    "busy_timeout",
    "cache_size",
    "cache_spill",
    "case_sensitive_like",
    "checkpoint_fullfsync",
    "defer_foreign_keys",
    "foreign_keys",
    "fullfsync",
    "ignore_check_constraints",
    "mmap_size",
    "query_only",
    "read_uncommitted",
    "recursive_triggers",
    "reverse_unordered_selects",
    "secure_delete",
    "temp_store",
    "trusted_schema",
    "wal_autocheckpoint",
}
SQLITE_WRITE_ACTIONS = {
    sqlite3.SQLITE_CREATE_INDEX,
    sqlite3.SQLITE_CREATE_TABLE,
    sqlite3.SQLITE_CREATE_TEMP_INDEX,
    sqlite3.SQLITE_CREATE_TEMP_TABLE,
    sqlite3.SQLITE_CREATE_TEMP_TRIGGER,
    sqlite3.SQLITE_CREATE_TEMP_VIEW,
    sqlite3.SQLITE_CREATE_TRIGGER,
    sqlite3.SQLITE_CREATE_VIEW,
    sqlite3.SQLITE_CREATE_VTABLE,
    sqlite3.SQLITE_DELETE,
    sqlite3.SQLITE_DROP_INDEX,
    sqlite3.SQLITE_DROP_TABLE,
    sqlite3.SQLITE_DROP_TEMP_INDEX,
    sqlite3.SQLITE_DROP_TEMP_TABLE,
    sqlite3.SQLITE_DROP_TEMP_TRIGGER,
    sqlite3.SQLITE_DROP_TEMP_VIEW,
    sqlite3.SQLITE_DROP_TRIGGER,
    sqlite3.SQLITE_DROP_VIEW,
    sqlite3.SQLITE_DROP_VTABLE,
    sqlite3.SQLITE_INSERT,
    sqlite3.SQLITE_REINDEX,
    sqlite3.SQLITE_ANALYZE,
    sqlite3.SQLITE_ALTER_TABLE,
    sqlite3.SQLITE_ATTACH,
    sqlite3.SQLITE_DETACH,
    sqlite3.SQLITE_TRANSACTION,
    sqlite3.SQLITE_SAVEPOINT,
    sqlite3.SQLITE_UPDATE,
}


def sql_type(statement: str) -> str:
    parsed = [item for item in sqlparse.parse(statement) if str(item).strip()]
    if len(parsed) != 1:
        raise ConfigurationError("database operation must contain exactly one SQL statement")
    kind = parsed[0].get_type().upper()
    if kind == "UNKNOWN":
        first = next(
            (
                token.normalized.upper()
                for token in parsed[0].flatten()
                if not token.is_whitespace and not token.value.startswith("--")
            ),
            "",
        )
        kind = first
    if kind not in READ_SQL_TYPES | WRITE_SQL_TYPES:
        raise ConfigurationError(f"unsupported SQL statement type: {kind or 'unknown'}")
    return kind


def _rows(cursor) -> list[dict[str, Any]]:
    if cursor.description is None:
        return []
    columns = [item[0] for item in cursor.description]
    rows = []
    for row in cursor.fetchall():
        if isinstance(row, Mapping):
            item = dict(row)
        else:
            item = dict(zip(columns, row, strict=True))
        rows.append(to_jsonable(item))
    return rows


def _is_retryable_mysql_error(error: Exception) -> bool:
    if isinstance(error, (TimeoutError, socket.timeout)):
        return True
    if not isinstance(error, pymysql.err.OperationalError):
        return False
    code = error.args[0] if error.args else None
    if code in RETRYABLE_MYSQL_CODES:
        return True
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "timeout",
            "timed out",
            "connection reset",
            "server has gone away",
        )
    )


class _SqliteReadOnlyAuthorizer:
    def __init__(self) -> None:
        self.configuring = True

    def __call__(
        self,
        action: int,
        arg1: str | None,
        arg2: str | None,
        _database: str | None,
        _source: str | None,
    ) -> int:
        if action == sqlite3.SQLITE_PRAGMA:
            if arg2 is None:
                return sqlite3.SQLITE_OK
            if self.configuring and str(arg1).lower() in SQLITE_CONNECTION_PRAGMAS:
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        if action in SQLITE_WRITE_ACTIONS:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK


class DatabaseExecutor(Executor):
    name = "database"

    def __init__(
        self,
        config: ProjectConfig,
        factories: dict[str, ConnectionFactory] | None = None,
    ) -> None:
        self.config = config
        self.factories = factories or {}

    def _sqlite_target(self, settings: dict[str, Any]) -> tuple[str, Path | None]:
        database = str(settings.get("database", ":memory:"))
        if database in {"", ":memory:"}:
            return database, None
        if settings.get("uri") and database.startswith("file:"):
            # Explicit SQLite URIs keep SQLite's own relative-path semantics.
            parsed = urlsplit(database)
            query = dict(parse_qsl(parsed.query))
            if parsed.path == ":memory:" or query.get("mode") == "memory":
                return database, None
            return database, Path(unquote(parsed.path)).resolve()
        path = (self.config.root / database).resolve()
        return str(path), path

    def _connect(
        self,
        driver: str,
        connection: dict[str, Any],
        *,
        write: bool,
        read_only: bool = False,
    ):
        if driver in self.factories:
            return self.factories[driver](connection)
        if driver == "sqlite":
            database, file_path = self._sqlite_target(connection)
            connection.pop("database", None)
            configured_read_only = bool(connection.pop("read_only", False))
            read_only = read_only or configured_read_only
            connection.pop("pragmas", None)
            if read_only and write:
                raise ConfigurationError("SQLite connection is configured as read-only")
            if read_only and file_path is not None:
                if connection.get("uri") and database.startswith("file:"):
                    parsed = urlsplit(database)
                    query = [(k, v) for k, v in parse_qsl(parsed.query) if k != "mode"]
                    database = urlunsplit(parsed._replace(query=urlencode([*query, ("mode", "ro")])))
                else:
                    database = f"{file_path.as_uri()}?mode=ro"
                connection["uri"] = True
            client = sqlite3.connect(database, **connection)
            client.row_factory = sqlite3.Row
            return client
        if driver == "mysql":
            read_only = bool(connection.pop("read_only", False))
            if read_only and write:
                raise ConfigurationError("MySQL connection is configured as read-only")
            timeout = max(1, int(connection.pop("timeout_seconds", 20)))
            connection.setdefault("connect_timeout", timeout)
            connection.setdefault("read_timeout", timeout)
            connection.setdefault("write_timeout", timeout)
            connection.setdefault("cursorclass", pymysql.cursors.DictCursor)
            return pymysql.connect(**connection)
        raise ConfigurationError(f"unsupported database driver: {driver}")

    @staticmethod
    def _configure_sqlite(
        connection,
        settings: dict[str, Any],
        *,
        read_only: bool = False,
    ) -> None:
        configured_read_only = bool(settings.get("read_only", False))
        read_only = read_only or configured_read_only
        defaults = {
            "busy_timeout": 30000,
            "foreign_keys": "ON",
        }
        configured = dict(settings.get("pragmas", {}))
        if read_only:
            blocked = SQLITE_WRITE_PRAGMAS & {
                str(name).lower() for name in configured
            }
            if configured_read_only and blocked:
                raise ConfigurationError(
                    "read-only SQLite connection cannot configure write-affecting "
                    f"PRAGMAs: {sorted(blocked)}"
                )
            configured = {
                name: value
                for name, value in configured.items()
                if str(name).lower() not in SQLITE_WRITE_PRAGMAS
            }
            defaults["query_only"] = "ON"
        else:
            defaults["synchronous"] = "NORMAL"
            if str(settings.get("database", ":memory:")) != ":memory:":
                defaults["journal_mode"] = "WAL"
        defaults.update(configured)
        for name, value in defaults.items():
            if not str(name).replace("_", "").isalnum():
                raise ConfigurationError(f"invalid SQLite PRAGMA name: {name!r}")
            connection.execute(f"PRAGMA {name}={value}")
        if read_only:
            connection.execute("PRAGMA query_only=ON")

    def _execute_once(
        self,
        *,
        driver: str,
        connection_settings: dict[str, Any],
        statement: str,
        parameters: dict[str, Any] | Sequence[Any],
        write: bool,
        execute_many: bool,
        read_only: bool,
    ) -> dict[str, Any]:
        connection = self._connect(
            driver,
            dict(connection_settings),
            write=write,
            read_only=read_only,
        )
        try:
            if driver == "sqlite":
                authorizer = _SqliteReadOnlyAuthorizer() if read_only else None
                if authorizer is not None:
                    connection.set_authorizer(authorizer)
                self._configure_sqlite(
                    connection,
                    connection_settings,
                    read_only=read_only,
                )
                if authorizer is not None:
                    authorizer.configuring = False
            with closing(connection.cursor()) as cursor:
                if execute_many:
                    if not isinstance(parameters, list):
                        raise ConfigurationError(
                            "execute_many requires parameters to be a list"
                        )
                    cursor.executemany(statement, parameters)
                else:
                    cursor.execute(statement, parameters)
                rows = _rows(cursor)
                rowcount = cursor.rowcount if write else len(rows)
            if write:
                connection.commit()
            return {"rows": rows, "rowcount": rowcount, "write": write}
        except Exception:
            if write:
                connection.rollback()
            raise
        finally:
            connection.close()

    def execute(
        self,
        operation_name: str,
        operation: dict[str, Any],
        request: dict[str, Any],
        context: RunContext,
    ) -> ExecutionResult:
        connection_name = str(operation.get("connection", "default"))
        statement = str(operation["statement"])
        kind = sql_type(statement)
        actual_write = kind in WRITE_SQL_TYPES
        declared_write = bool(operation.get("write", False))
        if actual_write != declared_write:
            raise ConfigurationError(
                f"database operation {operation_name!r} declares write={declared_write}, "
                f"but SQL type is {kind}"
            )
        allow_write = (
            context.run_mode != "read"
            if context.allow_db_write is None else context.allow_db_write
        )
        if not isinstance(allow_write, bool):
            raise ConfigurationError("allow_db_write must be a boolean")
        if actual_write and not allow_write:
            reason = (
                "blocked in read mode"
                if context.allow_db_write is None else "blocked by allow_db_write=false"
            )
            raise ConfigurationError(
                f"database write operation {operation_name!r} is {reason}"
            )

        parameters = request.get("parameters", request)
        if not isinstance(parameters, (dict, list, tuple)):
            raise ConfigurationError(
                f"database operation {operation_name!r} parameters must be an object or list"
            )
        execute_many = bool(operation.get("execute_many", False))
        settings = self.config.connection(connection_name)
        if actual_write and settings.get("read_only", False):
            raise ConfigurationError("database connection is configured as read-only")
        driver = str(settings.pop("driver", "sqlite")).lower()
        sqlite_read_only = driver == "sqlite" and (
            not allow_write or bool(settings.get("read_only", False))
        )
        retries = max(0, int(operation.get("read_retries", settings.pop("read_retries", 1))))
        retry_delay = max(
            0,
            float(operation.get("retry_delay_seconds", settings.pop("retry_delay_seconds", 0.2))),
        )
        file_path = None
        if driver == "sqlite":
            settings["database"], file_path = self._sqlite_target(settings)
        lock = (
            FileLock(f"{file_path}.lock", timeout=30)
            if actual_write and file_path is not None
            else nullcontext()
        )

        attempts = retries + 1 if driver == "mysql" and not actual_write else 1
        with lock:
            for attempt in range(1, attempts + 1):
                try:
                    output = self._execute_once(
                        driver=driver,
                        connection_settings=settings,
                        statement=statement,
                        parameters=parameters,
                        write=actual_write,
                        execute_many=execute_many,
                        read_only=sqlite_read_only,
                    )
                    output.update({"sql_type": kind, "attempts": attempt})
                    return ExecutionResult(
                        executor=self.name,
                        operation=operation_name,
                        output=output,
                    )
                except Exception as exc:
                    if attempt >= attempts or not _is_retryable_mysql_error(exc):
                        raise
                    time.sleep(retry_delay * attempt)

        raise RuntimeError("database operation ended without a result")
