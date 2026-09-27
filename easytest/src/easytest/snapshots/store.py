from __future__ import annotations

import sqlite3
import zlib
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from filelock import FileLock

from easytest.models import ConfigurationError


SNAPSHOT_CODEC_MAGIC = b"EASYTEST-SNAPSHOT-1\0"
REQUIRED_TABLES = {"snapshot_runs", "snapshot_items"}


def encode_snapshot(content: bytes) -> bytes:
    return SNAPSHOT_CODEC_MAGIC + zlib.compress(content, level=6)


def decode_snapshot(content: bytes | memoryview | str) -> bytes:
    if isinstance(content, str):
        return content.encode()
    if isinstance(content, memoryview):
        content = content.tobytes()
    if content.startswith(SNAPSHOT_CODEC_MAGIC):
        return zlib.decompress(content[len(SNAPSHOT_CODEC_MAGIC) :])
    return content


@dataclass(frozen=True)
class SnapshotRecord:
    run_id: str
    case_id: str
    name: str
    kind: str
    content: bytes


class SqliteSnapshotStore:
    """Concurrent-safe history store for snapshot runs and payloads."""

    def __init__(
        self,
        path: str | Path,
        *,
        timeout_seconds: float = 30,
        history_keep: int | None = None,
    ) -> None:
        if history_keep is not None and (
            type(history_keep) is not int or history_keep < 1
        ):
            raise ConfigurationError(
                "snapshot_history_keep must be a positive integer or null"
            )
        self.history_keep = history_keep
        self.path = Path(path).resolve()
        self.timeout_seconds = max(1, float(timeout_seconds))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(f"{self.path}.lock", timeout=self.timeout_seconds)
        self._ensure_schema()

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self.path, timeout=self.timeout_seconds)
        connection.row_factory = sqlite3.Row
        connection.execute(f"PRAGMA busy_timeout={int(self.timeout_seconds * 1000)}")
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
        finally:
            connection.close()

    def _ensure_schema(self) -> None:
        with self.lock, self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS snapshot_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    case_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(run_id, case_id)
                );
                CREATE TABLE IF NOT EXISTS snapshot_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    case_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    content BLOB NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(run_id, case_id, name),
                    FOREIGN KEY(run_id, case_id)
                        REFERENCES snapshot_runs(run_id, case_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_snapshot_baseline
                    ON snapshot_runs(case_id, status, id DESC);
                """
            )
            connection.commit()

    def begin(self, run_id: str, case_id: str) -> None:
        with self.lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO snapshot_runs(run_id, case_id, status)
                VALUES (?, ?, 'running')
                ON CONFLICT(run_id, case_id)
                DO UPDATE SET status = 'running'
                """,
                (run_id, case_id),
            )
            connection.commit()

    def put(self, record: SnapshotRecord) -> None:
        with self.lock, self._connection() as connection:
            connection.execute(
                """
                INSERT INTO snapshot_items(run_id, case_id, name, kind, content)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(run_id, case_id, name)
                DO UPDATE SET kind = excluded.kind, content = excluded.content
                """,
                (
                    record.run_id,
                    record.case_id,
                    record.name,
                    record.kind,
                    encode_snapshot(record.content),
                ),
            )
            connection.commit()

    def latest_completed(
        self,
        case_id: str,
        name: str,
        *,
        exclude_run_id: str | None = None,
    ) -> SnapshotRecord | None:
        exclude = "AND r.run_id != ?" if exclude_run_id else ""
        parameters = (
            (case_id, name, exclude_run_id)
            if exclude_run_id
            else (case_id, name)
        )
        with self._connection() as connection:
            row = connection.execute(
                f"""
                SELECT i.run_id, i.case_id, i.name, i.kind, i.content
                FROM snapshot_items i
                JOIN snapshot_runs r
                  ON r.run_id = i.run_id AND r.case_id = i.case_id
                WHERE r.case_id = ? AND i.name = ? AND r.status = 'completed'
                  {exclude}
                ORDER BY r.id DESC, i.id DESC
                LIMIT 1
                """,
                parameters,
            ).fetchone()
        if row is None:
            return None
        return SnapshotRecord(
            run_id=row["run_id"],
            case_id=row["case_id"],
            name=row["name"],
            kind=row["kind"],
            content=decode_snapshot(row["content"]),
        )

    def finish(self, run_id: str, case_id: str, *, success: bool) -> None:
        status = "completed" if success else "failed"
        with self.lock, self._connection() as connection:
            updated = connection.execute(
                "UPDATE snapshot_runs SET status = ? WHERE run_id = ? AND case_id = ?",
                (status, run_id, case_id),
            )
            if success and updated.rowcount and self.history_keep is not None:
                self._prune_history(connection, case_id)
            connection.commit()

    def _prune_history(self, connection: sqlite3.Connection, case_id: str) -> None:
        # Retain each snapshot independently: a partial update must not remove
        # the last baseline of a snapshot absent from newer runs.
        connection.execute(
            """
            DELETE FROM snapshot_items WHERE id IN (
                SELECT id FROM (
                    SELECT i.id, ROW_NUMBER() OVER (
                        PARTITION BY i.name ORDER BY r.id DESC, i.id DESC
                    ) AS version
                    FROM snapshot_items i
                    JOIN snapshot_runs r
                      ON r.run_id = i.run_id AND r.case_id = i.case_id
                    WHERE r.case_id = ? AND r.status = 'completed'
                ) WHERE version > ?
            )
            """,
            (case_id, self.history_keep),
        )
        connection.execute(
            """
            DELETE FROM snapshot_runs
            WHERE case_id = ? AND status = 'completed'
              AND NOT EXISTS (
                  SELECT 1 FROM snapshot_items i
                  WHERE i.run_id = snapshot_runs.run_id
                    AND i.case_id = snapshot_runs.case_id
              )
            """,
            (case_id,),
        )

    def cleanup_failed(self, case_id: str, *, keep: int = 1) -> int:
        keep = max(0, int(keep))
        with self.lock, self._connection() as connection:
            rows = connection.execute(
                """
                SELECT id FROM snapshot_runs
                WHERE case_id = ? AND status = 'failed'
                ORDER BY id DESC
                """,
                (case_id,),
            ).fetchall()
            delete_ids = [row["id"] for row in rows[keep:]]
            if not delete_ids:
                return 0
            placeholders = ",".join("?" for _ in delete_ids)
            cursor = connection.execute(
                f"DELETE FROM snapshot_runs WHERE id IN ({placeholders})",
                delete_ids,
            )
            connection.commit()
            return cursor.rowcount

    def healthcheck(self) -> list[str]:
        issues: list[str] = []
        try:
            with self._connection() as connection:
                integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
                if integrity != ["ok"]:
                    issues.extend(f"integrity: {item}" for item in integrity)
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                missing = REQUIRED_TABLES - tables
                if missing:
                    issues.append(f"missing tables: {sorted(missing)}")
                for row in connection.execute(
                    "SELECT id, content FROM snapshot_items ORDER BY id"
                ):
                    try:
                        decode_snapshot(row["content"])
                    except Exception as exc:
                        issues.append(f"snapshot item {row['id']} cannot be decoded: {exc}")
        except sqlite3.DatabaseError as exc:
            issues.append(f"cannot open snapshot database: {exc}")
        return issues

    def assert_healthy(self) -> None:
        issues = self.healthcheck()
        if issues:
            raise ConfigurationError("; ".join(issues))
