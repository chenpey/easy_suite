from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

from filelock import FileLock
from filelock import Timeout as FileLockTimeout

from easytest.models import ConfigurationError
from easytest.snapshots.codec import (
    ARTIFACT_NAME,
    ARTIFACT_SUFFIXES,
    DEFAULT_MAX_SNAPSHOT_BYTES,
    SNAPSHOT_ARTIFACT_MAGIC,
    SNAPSHOT_RAW_MAGIC,
    decode_artifact_reference,
    decode_snapshot,
    encode_snapshot,
    read_bounded_file,
    read_snapshot_artifact,
    snapshot_artifact_target,
    snapshot_size_limit,
)


SNAPSHOT_SCHEMA_VERSION = 1
REQUIRED_TABLES = {"snapshot_runs", "snapshot_items"}
REQUIRED_RUN_COLUMNS = {
    "id", "run_id", "case_id", "status", "created_at", "base_run_id", "finished_at",
}
REQUIRED_ITEM_COLUMNS = {
    "id", "run_id", "case_id", "name", "kind", "content", "created_at",
}
SNAPSHOT_SCHEMA_SQL = """
CREATE TABLE snapshot_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    base_run_id INTEGER NOT NULL DEFAULT 0,
    finished_at TEXT,
    UNIQUE(run_id, case_id)
);
CREATE TABLE snapshot_items (
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
CREATE INDEX idx_snapshot_baseline
    ON snapshot_runs(case_id, status, id DESC);
"""


def _schema_signature(connection: sqlite3.Connection) -> frozenset[tuple[str, ...]]:
    return frozenset(
        (
            str(row[0]),
            str(row[1]),
            str(row[2]),
            " ".join(str(row[3]).split()),
        )
        for row in connection.execute(
            """
            SELECT type, name, tbl_name, sql
            FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
              AND type IN ('table', 'index', 'view', 'trigger')
            """
        )
    )


@lru_cache(maxsize=1)
def _expected_schema_signature() -> frozenset[tuple[str, ...]]:
    with sqlite3.connect(":memory:") as connection:
        connection.executescript(SNAPSHOT_SCHEMA_SQL)
        return _schema_signature(connection)


class SnapshotConflictError(ConfigurationError):
    code = "SNAPSHOT_CONFLICT"
    field = "snapshot"


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
        artifact_dir: str | Path | None = None,
        timeout_seconds: float = 30,
        history_keep: int | None = None,
        max_snapshot_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
    ) -> None:
        if history_keep is not None and (
            type(history_keep) is not int or history_keep < 1
        ):
            raise ConfigurationError(
                "snapshot_history_keep must be a positive integer or null"
            )
        self.history_keep = history_keep
        self.max_snapshot_bytes = snapshot_size_limit(max_snapshot_bytes)
        self.path = Path(path).resolve()
        self.artifact_dir = (
            Path(artifact_dir).resolve()
            if artifact_dir is not None
            else self.path.parent / "snapshot-artifacts"
        )
        self.timeout_seconds = max(1, float(timeout_seconds))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(
            f"{self.path}.lock",
            timeout=self.timeout_seconds,
            preserve_lock_file=True,
        )
        self.run_lock_dir = self.path.parent / f".{self.path.name}.runs"
        self.run_lock_dir.mkdir(parents=True, exist_ok=True)
        self._run_locks: dict[tuple[str, str], FileLock] = {}
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

    @staticmethod
    def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
        return {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})")}

    def _ensure_schema(self) -> None:
        with self.lock, self._connection() as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            signature = _schema_signature(connection)
            fresh = version == 0 and not signature
            if not fresh and version != SNAPSHOT_SCHEMA_VERSION:
                raise ConfigurationError(
                    f"unsupported snapshot database schema {version}; "
                    "remove or recreate the snapshot database"
                )
            if not fresh and signature != _expected_schema_signature():
                raise ConfigurationError(
                    "snapshot database schema does not match the current contract; "
                    "remove or recreate the snapshot database"
                )
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            if fresh:
                connection.executescript(SNAPSHOT_SCHEMA_SQL)
                connection.execute(f"PRAGMA user_version={SNAPSHOT_SCHEMA_VERSION}")
                connection.commit()

    @staticmethod
    def _latest_completed_run_id(
        connection: sqlite3.Connection,
        case_id: str,
        *,
        exclude_run_id: str | None = None,
    ) -> int:
        exclude = "AND r.run_id != ?" if exclude_run_id else ""
        parameters = (case_id, exclude_run_id) if exclude_run_id else (case_id,)
        row = connection.execute(
            f"""
            SELECT COALESCE(MAX(r.id), 0)
            FROM snapshot_runs r
            WHERE r.case_id = ? AND r.status = 'completed' {exclude}
              AND EXISTS (
                  SELECT 1 FROM snapshot_items i
                  WHERE i.run_id = r.run_id AND i.case_id = r.case_id
              )
            """,
            parameters,
        ).fetchone()
        return int(row[0])

    def begin(self, run_id: str, case_id: str) -> None:
        key = (run_id, case_id)
        if key in self._run_locks:
            raise ConfigurationError(f"snapshot run already active: {case_id}/{run_id}")
        lease = FileLock(
            self._run_lock_path(run_id, case_id),
            timeout=self.timeout_seconds,
            preserve_lock_file=True,
        )
        lease.acquire()
        self._run_locks[key] = lease
        try:
            with self.lock, self._connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                base_run_id = self._latest_completed_run_id(connection, case_id)
                connection.execute(
                    """
                    INSERT INTO snapshot_runs(
                        run_id, case_id, status, base_run_id, created_at, finished_at
                    )
                    VALUES (?, ?, 'running', ?, CURRENT_TIMESTAMP, NULL)
                    """,
                    (run_id, case_id, base_run_id),
                )
                connection.commit()
        except BaseException:
            self._release_run_lock(key)
            raise

    def _run_lock_path(self, run_id: str, case_id: str) -> Path:
        digest = hashlib.sha256(f"{case_id}\0{run_id}".encode()).hexdigest()
        return self.run_lock_dir / f"{digest}.lock"

    def _release_run_lock(self, key: tuple[str, str]) -> None:
        lease = self._run_locks.pop(key, None)
        if lease is not None:
            lease.release()

    def _put(self, connection: sqlite3.Connection, record: SnapshotRecord, content: bytes) -> None:
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
                encode_snapshot(content, max_bytes=self.max_snapshot_bytes),
            ),
        )

    def put(self, record: SnapshotRecord) -> None:
        if record.kind == "screenshot":
            raise ConfigurationError(
                "screenshot snapshots must use external artifact storage"
            )
        with self.lock, self._connection() as connection:
            self._put(connection, record, record.content)
            connection.commit()

    def _artifact_target(self, reference: dict[str, Any]) -> Path:
        return snapshot_artifact_target(self.artifact_dir, reference)

    def _write_artifact(self, content: bytes, suffix: str) -> tuple[dict[str, Any], Path]:
        if len(content) > self.max_snapshot_bytes:
            raise ConfigurationError(
                f"snapshot content exceeds snapshot_max_bytes ({self.max_snapshot_bytes})",
                code="SNAPSHOT_TOO_LARGE",
                field="snapshot_max_bytes",
            )
        suffix = suffix.lower()
        if suffix not in ARTIFACT_SUFFIXES:
            raise ConfigurationError(f"unsupported snapshot artifact extension: {suffix}")
        if suffix == ".jpeg":
            suffix = ".jpg"
        digest = hashlib.sha256(content).hexdigest()
        relative = Path(digest[:2]) / f"{digest}{suffix}"
        reference = {"path": relative.as_posix(), "sha256": digest, "size": len(content)}
        target = self._artifact_target(reference)
        if target.exists():
            if target.stat().st_size != len(content):
                raise ConfigurationError(f"snapshot artifact is corrupted: {target}")
            existing = read_bounded_file(
                target,
                max_bytes=self.max_snapshot_bytes,
                label="snapshot artifact",
            )
            if hashlib.sha256(existing).hexdigest() != digest:
                raise ConfigurationError(f"snapshot artifact is corrupted: {target}")
            return reference, target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=target.parent,
                prefix=f".{target.name}.pending-",
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return reference, target

    @staticmethod
    def _reference_bytes(reference: dict[str, Any]) -> bytes:
        return SNAPSHOT_ARTIFACT_MAGIC + json.dumps(
            reference,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()

    def put_artifact(self, record: SnapshotRecord, suffix: str) -> Path:
        if record.kind != "screenshot":
            raise ConfigurationError("only screenshot snapshots can use external artifacts")
        with self.lock:
            reference, target = self._write_artifact(record.content, suffix)
            with self._connection() as connection:
                self._put(connection, record, self._reference_bytes(reference))
                connection.commit()
        return target

    def _read_artifact(self, reference: dict[str, Any]) -> bytes:
        return read_snapshot_artifact(
            self.artifact_dir,
            reference,
            max_bytes=self.max_snapshot_bytes,
        )

    def _decode_content(self, kind: str, content: bytes) -> bytes:
        decoded = decode_snapshot(content, max_bytes=self.max_snapshot_bytes)
        reference = (
            decode_artifact_reference(decoded) if kind == "screenshot" else None
        )
        if kind == "screenshot":
            if reference is None:
                raise ConfigurationError(
                    "screenshot snapshot does not contain an external artifact reference"
                )
            return self._read_artifact(reference)
        return decoded

    def latest_completed(
        self,
        case_id: str,
        name: str,
        *,
        exclude_run_id: str | None = None,
    ) -> SnapshotRecord | None:
        exclude = "AND r.run_id != ?" if exclude_run_id else ""
        stored_limit = self.max_snapshot_bytes + len(SNAPSHOT_RAW_MAGIC)
        parameters = (
            (stored_limit, case_id, name, exclude_run_id)
            if exclude_run_id
            else (stored_limit, case_id, name)
        )
        with self._connection() as connection:
            row = connection.execute(
                f"""
                SELECT i.run_id, i.case_id, i.name, i.kind,
                       length(i.content) AS content_size,
                       CASE WHEN length(i.content) <= ? THEN i.content END AS content
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
        if row["content"] is None:
            raise ConfigurationError(
                f"stored snapshot exceeds snapshot_max_bytes "
                f"({self.max_snapshot_bytes})",
                code="SNAPSHOT_TOO_LARGE",
                field="snapshot_max_bytes",
            )
        return SnapshotRecord(
            run_id=row["run_id"],
            case_id=row["case_id"],
            name=row["name"],
            kind=row["kind"],
            content=self._decode_content(row["kind"], row["content"]),
        )

    def finish(self, run_id: str, case_id: str, *, success: bool) -> None:
        conflict: tuple[int, int] | None = None
        key = (run_id, case_id)
        try:
            with self.lock, self._connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    """
                    SELECT id, base_run_id, EXISTS (
                        SELECT 1 FROM snapshot_items i
                        WHERE i.run_id = snapshot_runs.run_id
                          AND i.case_id = snapshot_runs.case_id
                    ) AS has_items
                    FROM snapshot_runs
                    WHERE run_id = ? AND case_id = ?
                    """,
                    (run_id, case_id),
                ).fetchone()
                if row is None:
                    connection.rollback()
                    raise ConfigurationError(
                        f"snapshot run does not exist: {case_id}/{run_id}"
                    )
                if not row["has_items"]:
                    connection.execute(
                        "DELETE FROM snapshot_runs WHERE run_id = ? AND case_id = ?",
                        (run_id, case_id),
                    )
                    connection.commit()
                    return
                status = "completed" if success else "failed"
                if success:
                    latest = self._latest_completed_run_id(
                        connection, case_id, exclude_run_id=run_id,
                    )
                    if latest != int(row["base_run_id"]):
                        status = "conflict"
                        conflict = (int(row["base_run_id"]), latest)
                connection.execute(
                    """
                    UPDATE snapshot_runs
                    SET status = ?, finished_at = CURRENT_TIMESTAMP
                    WHERE run_id = ? AND case_id = ?
                    """,
                    (status, run_id, case_id),
                )
                if status == "completed" and self.history_keep is not None:
                    self._prune_history(connection, case_id)
                connection.commit()
        finally:
            self._release_run_lock(key)
        if conflict is not None:
            raise SnapshotConflictError(
                f"snapshot baseline changed while case was running: {case_id}; "
                f"expected generation {conflict[0]}, found {conflict[1]}"
            )

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
                WHERE case_id = ? AND status IN ('failed', 'conflict')
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

    def _referenced_artifacts(self, connection: sqlite3.Connection) -> set[Path]:
        references: set[Path] = set()
        for row in connection.execute(
            """
            SELECT id, kind, length(content) AS content_size,
                   CASE WHEN length(content) <= ? THEN content END AS content
            FROM snapshot_items WHERE kind = 'screenshot'
            """,
            (self.max_snapshot_bytes + len(SNAPSHOT_RAW_MAGIC),),
        ):
            if row["content"] is None:
                raise ConfigurationError(
                    f"stored snapshot item {row['id']} exceeds snapshot_max_bytes "
                    f"({self.max_snapshot_bytes})",
                    code="SNAPSHOT_TOO_LARGE",
                    field="snapshot_max_bytes",
                )
            decoded = decode_snapshot(row["content"], max_bytes=self.max_snapshot_bytes)
            reference = decode_artifact_reference(decoded)
            if reference is None:
                raise ConfigurationError(
                    "screenshot snapshot does not contain an external artifact reference"
                )
            references.add(self._artifact_target(reference))
        return references

    def _managed_artifacts(self) -> list[Path]:
        if not self.artifact_dir.is_dir():
            return []
        artifacts: list[Path] = []
        for directory in self.artifact_dir.iterdir():
            if (
                directory.is_symlink()
                or not directory.is_dir()
                or len(directory.name) != 2
                or any(character not in "0123456789abcdef" for character in directory.name)
            ):
                continue
            for target in directory.iterdir():
                if (
                    target.is_symlink()
                    or not target.is_file()
                    or not ARTIFACT_NAME.fullmatch(target.name)
                    or target.suffix not in ARTIFACT_SUFFIXES
                    or target.stem[:2] != directory.name
                ):
                    continue
                artifacts.append(target)
        return artifacts

    def _remove_orphan_artifacts(self, referenced: set[Path]) -> tuple[int, int]:
        removed = 0
        removed_bytes = 0
        for target in self._managed_artifacts():
            if target.resolve() not in referenced:
                removed_bytes += target.stat().st_size
                target.unlink()
                removed += 1
        if self.artifact_dir.is_dir():
            directories = list(self.artifact_dir.iterdir())
        else:
            directories = []
        for directory in directories:
            if (
                not directory.is_symlink()
                and directory.is_dir()
                and not any(directory.iterdir())
            ):
                directory.rmdir()
        return removed, removed_bytes

    def maintain(
        self,
        *,
        stale_after_seconds: float = 24 * 60 * 60,
        keep_failed: int = 1,
        compact: bool = False,
    ) -> dict[str, Any]:
        if (
            isinstance(stale_after_seconds, bool)
            or not isinstance(stale_after_seconds, (int, float))
            or not math.isfinite(stale_after_seconds)
            or stale_after_seconds < 0
        ):
            raise ConfigurationError("stale_after_seconds must be non-negative")
        if type(keep_failed) is not int or keep_failed < 0:
            raise ConfigurationError("keep_failed must be a non-negative integer")
        database_bytes_before = self.path.stat().st_size if self.path.exists() else 0
        cutoff = (
            datetime.now(UTC) - timedelta(seconds=float(stale_after_seconds))
        ).strftime("%Y-%m-%d %H:%M:%S")
        stale_leases: list[FileLock] = []
        with self.lock:
            try:
                with self._connection() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    before_runs = int(
                        connection.execute(
                            "SELECT COUNT(*) FROM snapshot_runs"
                        ).fetchone()[0]
                    )
                    stale_rows = connection.execute(
                        """
                        SELECT id, run_id, case_id FROM snapshot_runs
                        WHERE status = 'running' AND created_at <= ?
                        """,
                        (cutoff,),
                    ).fetchall()
                    stale_ids = []
                    for row in stale_rows:
                        lease = FileLock(
                            self._run_lock_path(row["run_id"], row["case_id"]),
                            timeout=0,
                            preserve_lock_file=True,
                        )
                        try:
                            lease.acquire()
                        except FileLockTimeout:
                            continue
                        stale_leases.append(lease)
                        stale_ids.append(row["id"])
                    if stale_ids:
                        placeholders = ",".join("?" for _ in stale_ids)
                        connection.execute(
                            f"DELETE FROM snapshot_runs WHERE id IN ({placeholders})",
                            stale_ids,
                        )
                    failed_ids = [
                        row["id"]
                        for row in connection.execute(
                            """
                            SELECT id FROM (
                                SELECT id, ROW_NUMBER() OVER (
                                    PARTITION BY case_id ORDER BY id DESC
                                ) AS version
                                FROM snapshot_runs
                                WHERE status IN ('failed', 'conflict')
                            ) WHERE version > ?
                            """,
                            (keep_failed,),
                        )
                    ]
                    if failed_ids:
                        placeholders = ",".join("?" for _ in failed_ids)
                        connection.execute(
                            f"DELETE FROM snapshot_runs WHERE id IN ({placeholders})",
                            failed_ids,
                        )
                    if self.history_keep is not None:
                        case_ids = [
                            row[0]
                            for row in connection.execute(
                                "SELECT DISTINCT case_id FROM snapshot_runs"
                            )
                        ]
                        for case_id in case_ids:
                            self._prune_history(connection, case_id)
                    after_runs = int(
                        connection.execute(
                            "SELECT COUNT(*) FROM snapshot_runs"
                        ).fetchone()[0]
                    )
                    referenced = self._referenced_artifacts(connection)
                    connection.commit()
                    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    connection.execute("PRAGMA optimize")
                    if compact:
                        connection.execute("VACUUM")
            finally:
                for lease in stale_leases:
                    lease.release()
            removed_artifacts, removed_artifact_bytes = self._remove_orphan_artifacts(
                referenced
            )
        return {
            "removed_runs": before_runs - after_runs,
            "removed_stale_runs": len(stale_ids),
            "removed_failed_runs": len(failed_ids),
            "removed_artifacts": removed_artifacts,
            "removed_artifact_bytes": removed_artifact_bytes,
            "database_bytes_before": database_bytes_before,
            "database_bytes_after": self.path.stat().st_size,
            "compacted": compact,
        }

    def statistics(self) -> dict[str, Any]:
        with self._connection() as connection:
            statuses = {
                row["status"]: row["count"]
                for row in connection.execute(
                    "SELECT status, COUNT(*) AS count FROM snapshot_runs GROUP BY status"
                )
            }
            item_count = int(
                connection.execute("SELECT COUNT(*) FROM snapshot_items").fetchone()[0]
            )
            schema_version = int(
                connection.execute("PRAGMA user_version").fetchone()[0]
            )
        artifacts = self._managed_artifacts()
        return {
            "schema_version": schema_version,
            "runs": statuses,
            "item_count": item_count,
            "artifact_count": len(artifacts),
            "artifact_bytes": sum(target.stat().st_size for target in artifacts),
            "database_bytes": self.path.stat().st_size if self.path.exists() else 0,
        }

    def healthcheck(self) -> list[str]:
        issues: list[str] = []
        try:
            with self._connection() as connection:
                version = int(connection.execute("PRAGMA user_version").fetchone()[0])
                if version != SNAPSHOT_SCHEMA_VERSION:
                    issues.append(
                        f"schema version is {version}; expected {SNAPSHOT_SCHEMA_VERSION}"
                    )
                if _schema_signature(connection) != _expected_schema_signature():
                    issues.append("schema objects do not match the current contract")
                integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
                if integrity != ["ok"]:
                    issues.extend(f"integrity: {item}" for item in integrity)
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                    )
                }
                missing = REQUIRED_TABLES - tables
                unexpected = tables - REQUIRED_TABLES
                if missing:
                    issues.append(f"missing tables: {sorted(missing)}")
                if unexpected:
                    issues.append(f"unexpected tables: {sorted(unexpected)}")
                if not missing and not unexpected:
                    missing_runs = REQUIRED_RUN_COLUMNS - self._columns(
                        connection, "snapshot_runs"
                    )
                    missing_items = REQUIRED_ITEM_COLUMNS - self._columns(
                        connection, "snapshot_items"
                    )
                    if missing_runs:
                        issues.append(f"snapshot_runs missing columns: {sorted(missing_runs)}")
                    if missing_items:
                        issues.append(f"snapshot_items missing columns: {sorted(missing_items)}")
                for row in connection.execute(
                    """
                    SELECT id, kind, length(content) AS content_size,
                           CASE WHEN length(content) <= ? THEN content END AS content
                    FROM snapshot_items ORDER BY id
                    """,
                    (self.max_snapshot_bytes + len(SNAPSHOT_RAW_MAGIC),),
                ):
                    if row["content"] is None:
                        issues.append(
                            f"snapshot item {row['id']} exceeds snapshot_max_bytes "
                            f"({self.max_snapshot_bytes})"
                        )
                        continue
                    try:
                        self._decode_content(row["kind"], row["content"])
                    except Exception as exc:
                        issues.append(
                            f"snapshot item {row['id']} cannot be decoded: "
                            f"{type(exc).__name__}: {exc}"
                        )
        except sqlite3.DatabaseError as exc:
            issues.append(f"cannot open snapshot database: {exc}")
        return issues

    def assert_healthy(self) -> None:
        issues = self.healthcheck()
        if issues:
            raise ConfigurationError("; ".join(issues))
