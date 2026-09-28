from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from easytest.config import ProjectConfig
from easytest.models import ConfigurationError, ExecutionResult, RunContext
from easytest.runtime.values import resolve_path
from easytest.snapshots.comparison import (
    Difference,
    SnapshotMismatchError,
    compare,
    format_differences,
    normalize,
)
from easytest.snapshots.codec import DEFAULT_MAX_SNAPSHOT_BYTES, read_bounded_file
from easytest.snapshots.store import SnapshotRecord, SqliteSnapshotStore
from easytest.validation import snapshot_settings


_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def snapshot_target(directory: Path, case_id: str, name: str, extension: str) -> Path:
    for label, value in (("case id", case_id), ("snapshot name", name)):
        if value in {".", ".."} or not _SAFE_NAME.fullmatch(value):
            raise ConfigurationError(f"unsafe {label}: {value!r}")
    root = directory.resolve()
    target = (root / case_id / f"{name}{extension}").resolve()
    if not target.is_relative_to(root):
        raise ConfigurationError("snapshot target escapes snapshot directory")
    return target


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str)
        + "\n"
    ).encode()


def _byte_differences(
    expected: bytes, actual: bytes, *, is_json: bool
) -> tuple[Difference, ...]:
    category = "binary_changed"
    if is_json:
        category = "format_changed"
        try:
            result = compare(
                json.loads(expected), json.loads(actual), {"null_strings": False}
            )
            if not result.equal:
                return result.differences
        except (ValueError, UnicodeError):
            pass
    return (
        Difference(
            "$", "changed",
            {"sha256": hashlib.sha256(expected).hexdigest()},
            {"sha256": hashlib.sha256(actual).hexdigest()},
            category,
        ),
    )


class SnapshotManager:
    def __init__(self, config: ProjectConfig) -> None:
        self.config = config
        snapshot_dir = config.runtime.get("snapshot_dir", "snapshots")
        self.snapshot_dir = config.root / str(snapshot_dir)
        self.max_snapshot_bytes = config.runtime.get(
            "snapshot_max_bytes",
            DEFAULT_MAX_SNAPSHOT_BYTES,
        )
        self.backend = str(config.runtime.get("snapshot_backend", "file")).lower()
        if self.backend not in {"file", "sqlite"}:
            raise ConfigurationError(
                f"snapshot_backend must be 'file' or 'sqlite'; got {self.backend!r}"
            )
        self.store = None
        self._pending_files: dict[tuple[str, str], dict[Path, bytes]] = {}
        if self.backend == "sqlite":
            database = config.runtime.get(
                "snapshot_database",
                ".easytest/snapshots.db",
            )
            artifact_dir = config.runtime.get(
                "snapshot_artifact_dir",
                ".easytest/snapshot-artifacts",
            )
            self.store = SqliteSnapshotStore(
                config.root / str(database),
                artifact_dir=config.root / str(artifact_dir),
                history_keep=config.runtime.get("snapshot_history_keep"),
                max_snapshot_bytes=self.max_snapshot_bytes,
            )

    def begin_case(self, context: RunContext) -> None:
        if self.store is not None and context.run_mode != "read":
            self._require_baseline_confirmation(context.run_mode, self.config.environment)
            self.store.begin(context.run_id, context.case.id)
        elif context.run_mode != "read":
            self._require_baseline_confirmation(context.run_mode, self.config.environment)
            self._pending_files[(context.run_id, context.case.id)] = {}

    def finish_case(self, context: RunContext, *, success: bool) -> None:
        if self.store is not None and context.run_mode != "read":
            self.store.finish(context.run_id, context.case.id, success=success)
        elif context.run_mode != "read":
            pending = self._pending_files.pop((context.run_id, context.case.id), {})
            if success:
                self._commit_files(pending)

    def process(
        self,
        *,
        spec: Any,
        result: ExecutionResult,
        context: RunContext,
        step_id: str,
    ) -> Path | None:
        if spec in (None, "", False):
            return None
        if isinstance(spec, str):
            spec = {"rule": spec}
        if not isinstance(spec, dict):
            raise ConfigurationError("snapshot must be a rule name, object, or empty")

        rule_name = str(spec.get("rule", "response_default"))
        rule = self.config.snapshot_rule(context.case.snapshot_profile, rule_name)
        merged = {
            **rule,
            **{key: value for key, value in spec.items() if key != "rule"},
        }
        snapshot_settings(merged)
        kind = str(merged.get("kind", "response"))
        name = str(merged.get("name", step_id))
        if name in {".", ".."} or not _SAFE_NAME.fullmatch(name):
            raise ConfigurationError(f"unsafe snapshot name: {name!r}")

        if kind in {"response", "database"}:
            selected = resolve_path(result.output, str(merged.get("select", "$")))
            payload = normalize(selected, merged)
            extension = ".json"
            content = _json_bytes(payload)
        elif kind == "screenshot":
            artifact_name = str(merged.get("artifact", "screenshot"))
            try:
                source = result.artifacts[artifact_name]
            except KeyError as exc:
                raise ConfigurationError(
                    f"screenshot snapshot requires result artifact {artifact_name!r}"
                ) from exc
            if not source.is_file():
                raise ConfigurationError(
                    f"screenshot artifact does not exist: {source}"
                )
            extension = source.suffix.lower() or ".png"
            if extension not in {".png", ".jpg", ".jpeg", ".webp"}:
                raise ConfigurationError(
                    f"unsupported screenshot snapshot extension: {extension}"
                )
            payload = None
            content = read_bounded_file(
                source,
                max_bytes=self.max_snapshot_bytes,
                label="snapshot content",
            )
        else:
            raise ConfigurationError(f"unsupported snapshot kind: {kind}")
        if len(content) > self.max_snapshot_bytes:
            raise ConfigurationError(
                "snapshot content exceeds snapshot_max_bytes "
                f"({self.max_snapshot_bytes})",
                code="SNAPSHOT_TOO_LARGE",
                field="snapshot_max_bytes",
            )

        if self.store is not None:
            self._process_sqlite(
                name=name,
                kind=kind,
                content=content,
                payload=payload,
                rule=merged,
                context=context,
                extension=extension,
            )
            return self.store.path

        target = snapshot_target(self.snapshot_dir, context.case.id, name, extension)
        if kind in {"response", "database"} and context.run_mode == "read" and target.is_file():
            expected = json.loads(
                read_bounded_file(
                    target,
                    max_bytes=self.max_snapshot_bytes,
                    label="snapshot baseline",
                )
            )
            comparison = compare(expected, payload, merged)
            if not comparison.equal:
                raise SnapshotMismatchError(
                    f"snapshot mismatch: {target}\n{format_differences(comparison)}",
                    target=str(target), differences=comparison.differences,
                )
            return target
        if context.run_mode == "read":
            self._assert_or_write(
                target,
                content,
                context.run_mode,
                self.config.environment,
                max_bytes=self.max_snapshot_bytes,
            )
        else:
            self._stage_file(target, content, context)
        return target

    def _stage_file(
        self,
        target: Path,
        content: bytes,
        context: RunContext,
    ) -> None:
        key = (context.run_id, context.case.id)
        pending = self._pending_files.setdefault(key, {})
        if context.run_mode == "write":
            current = pending.get(target)
            if current is None and target.exists():
                current = read_bounded_file(
                    target,
                    max_bytes=self.max_snapshot_bytes,
                    label="snapshot baseline",
                )
            if current is not None:
                if current != content:
                    raise SnapshotMismatchError(
                        f"snapshot already exists and differs: {target}; "
                        "use baseline mode to replace it",
                        target=str(target),
                        differences=_byte_differences(
                            current,
                            content,
                            is_json=target.suffix == ".json",
                        ),
                    )
                return
        pending[target] = content

    @staticmethod
    def _commit_files(pending: dict[Path, bytes]) -> None:
        if not pending:
            return
        prepared: dict[Path, Path] = {}
        backups: dict[Path, Path | None] = {}
        committed: list[Path] = []
        completed = False
        try:
            for target, content in pending.items():
                target.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    dir=target.parent,
                    prefix=f".{target.name}.pending-",
                    delete=False,
                ) as stream:
                    temporary = Path(stream.name)
                    stream.write(content)
                mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
                os.chmod(temporary, mode)
                prepared[target] = temporary

            for target, temporary in prepared.items():
                backup = None
                if target.exists():
                    with tempfile.NamedTemporaryFile(
                        dir=target.parent,
                        prefix=f".{target.name}.backup-",
                        delete=False,
                    ) as stream:
                        backup = Path(stream.name)
                    backup.unlink()
                    os.replace(target, backup)
                backups[target] = backup
                try:
                    os.replace(temporary, target)
                except BaseException:
                    if backup is not None:
                        os.replace(backup, target)
                    raise
                committed.append(target)
            completed = True
        except BaseException:
            for target in reversed(committed):
                backup = backups.get(target)
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    os.replace(backup, target)
            raise
        finally:
            for temporary in prepared.values():
                temporary.unlink(missing_ok=True)
            if completed:
                for backup in backups.values():
                    if backup is not None:
                        backup.unlink(missing_ok=True)

    def _process_sqlite(
        self,
        *,
        name: str,
        kind: str,
        content: bytes,
        payload: Any,
        rule: dict[str, Any],
        context: RunContext,
        extension: str,
    ) -> None:
        if self.store is None:
            raise RuntimeError("SQLite snapshot store is not configured")
        baseline = self.store.latest_completed(
            context.case.id,
            name,
            exclude_run_id=context.run_id,
        )
        if context.run_mode != "read":
            record = SnapshotRecord(
                run_id=context.run_id,
                case_id=context.case.id,
                name=name,
                kind=kind,
                content=content,
            )
            if kind == "screenshot":
                self.store.put_artifact(record, extension)
            else:
                self.store.put(record)
        if context.run_mode == "baseline":
            return
        if baseline is None:
            if context.run_mode == "read":
                raise SnapshotMismatchError(
                    f"SQLite snapshot baseline does not exist: {context.case.id}/{name}",
                    target=f"{context.case.id}/{name}",
                    differences=(Difference(
                        "$", "missing_expected", None, payload if kind != "screenshot"
                        else {"sha256": hashlib.sha256(content).hexdigest()},
                        "baseline_missing",
                    ),),
                )
            return

        if kind in {"response", "database"}:
            expected = json.loads(baseline.content.decode())
            comparison = compare(expected, payload, rule)
            if not comparison.equal:
                raise SnapshotMismatchError(
                    f"SQLite snapshot mismatch: {context.case.id}/{name}\n"
                    f"{format_differences(comparison)}",
                    target=f"{context.case.id}/{name}",
                    differences=comparison.differences,
                )
        elif baseline.content != content:
            expected_hash = hashlib.sha256(baseline.content).hexdigest()[:12]
            actual_hash = hashlib.sha256(content).hexdigest()[:12]
            raise SnapshotMismatchError(
                f"SQLite screenshot snapshot mismatch: {context.case.id}/{name} "
                f"(expected sha256={expected_hash}, actual sha256={actual_hash})",
                target=f"{context.case.id}/{name}",
                differences=_byte_differences(baseline.content, content, is_json=False),
            )

    @staticmethod
    def _require_baseline_confirmation(
        run_mode: str, environment: Mapping[str, str | None] | None = None,
    ) -> None:
        environment = os.environ if environment is None else environment
        if run_mode == "baseline" and environment.get("CONFIRM_BASELINE") != "1":
            raise ConfigurationError(
                "baseline mode requires CONFIRM_BASELINE=1 to replace snapshots"
            )

    @staticmethod
    def _assert_or_write(
        target: Path, content: bytes, run_mode: str,
        environment: Mapping[str, str | None] | None = None,
        *,
        max_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
    ) -> None:
        if run_mode not in {"read", "write", "baseline"}:
            raise ConfigurationError(f"invalid run mode: {run_mode}")
        SnapshotManager._require_baseline_confirmation(run_mode, environment)

        if run_mode in {"write", "baseline"}:
            target.parent.mkdir(parents=True, exist_ok=True)
            if run_mode == "write" and target.exists():
                current = read_bounded_file(
                    target,
                    max_bytes=max_bytes,
                    label="snapshot baseline",
                )
                if current != content:
                    raise SnapshotMismatchError(
                        f"snapshot already exists and differs: {target}; "
                        "use baseline mode to replace it",
                        target=str(target),
                        differences=_byte_differences(
                            current, content, is_json=target.suffix == ".json"
                        ),
                    )
                return
            target.write_bytes(content)
            return

        if not target.is_file():
            raise SnapshotMismatchError(
                f"snapshot does not exist: {target}",
                target=str(target),
                differences=(Difference(
                    "$", "missing_expected", None,
                    json.loads(content) if target.suffix == ".json"
                    else {"sha256": hashlib.sha256(content).hexdigest()},
                    "baseline_missing",
                ),),
            )
        expected = read_bounded_file(
            target,
            max_bytes=max_bytes,
            label="snapshot baseline",
        )
        if expected != content:
            expected_hash = hashlib.sha256(expected).hexdigest()[:12]
            actual_hash = hashlib.sha256(content).hexdigest()[:12]
            raise SnapshotMismatchError(
                f"snapshot mismatch: {target} "
                f"(expected sha256={expected_hash}, actual sha256={actual_hash})",
                target=str(target),
                differences=_byte_differences(
                    expected, content, is_json=target.suffix == ".json"
                ),
            )
