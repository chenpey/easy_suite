"""Validate a whole selection without executing handlers or opening business clients."""
from __future__ import annotations

import ast
import importlib.machinery
import inspect
import json
import re
import sqlite3
import symtable
from dataclasses import dataclass, field, fields as dataclass_fields
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import pymysql
import sqlparse

from easytest.cases.schema import parse_document
from easytest.config import ProjectConfig, resolve_env
from easytest.executors.database import WRITE_SQL_TYPES, sql_type
from easytest.executors.http import request_settings
from easytest.validation import http_secret_sources
from easytest.models import Case, ConfigurationError, ContractError, MockMissError, RunContext
from easytest.runtime.assertions import expectation_checks
from easytest.runtime.mocks import MockEngine
from easytest.runtime.policy import ExecutionPolicy, execution_input_hash
from easytest.runtime.values import merge_nested, path_parts, render_templates, state_write_parts
from easytest.snapshots.manager import SnapshotManager, snapshot_target
from easytest.validation import (
    DEFERRED, Deferred, fields, has_deferred, http_settings, mock_settings, number,
    snapshot_settings, template_shape, text, typed,
)


@dataclass
class PreflightResult:
    case_count: int = 0
    step_count: int = 0
    deferred: list[dict[str, str]] = field(default_factory=list)
    input_hash: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": "valid", "case_count": self.case_count,
            "step_count": self.step_count, "deferred": self.deferred,
            "input_hash": self.input_hash,
        }


def _case_contract(case: Case) -> None:
    document = {
        "schema_version": 1,
        "cases": [{
            "id": case.id, "name": case.name, "type": case.case_type,
            "enabled": case.enabled, "tags": list(case.tags), "variables": case.variables,
            "mock_profile": case.mock_profile, "snapshot_profile": case.snapshot_profile,
            "steps": [
                {item.name: getattr(step, item.name) for item in dataclass_fields(step)}
                for step in case.steps
            ],
        }],
    }
    parse_document(document, source=case.source)
    if list(case.steps) != sorted(case.steps, key=lambda step: step.order):
        raise ContractError("Case.steps must be ordered by step.order")


def _handler(
    reference: Any,
    cache: dict[str, tuple[frozenset[str], bool]],
) -> None:
    text(reference, "handler")
    if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*", reference):
        raise ConfigurationError("handler must use 'package.module:function' syntax")
    module, function = reference.split(":")
    if module not in cache:
        cache[module] = _module_symbols(module)
    names, dynamic = cache[module]
    if function not in names and not dynamic:
        raise ConfigurationError(f"handler symbol is not defined: {reference}")


def _module_symbols(module: str) -> tuple[frozenset[str], bool]:
    # Unlike importlib.util.find_spec, walking PathFinder does not import parents.
    search = None
    parts = module.split(".")
    for index in range(len(parts)):
        name = ".".join(parts[:index + 1])
        spec = importlib.machinery.PathFinder.find_spec(name, search)
        if spec is None:
            raise ConfigurationError(f"handler module is not installed: {module}")
        search = spec.submodule_search_locations
        if index < len(parts) - 1 and search is None:
            raise ConfigurationError(f"handler parent is not a package: {name}")
    if spec.origin and spec.origin.endswith(".py"):
        try:
            source = Path(spec.origin).read_bytes()
        except (SyntaxError, ValueError) as exc:
            raise ConfigurationError(f"handler module has invalid Python syntax: {module}") from exc
        return _python_symbols(module, spec.origin, source)
    return frozenset(), True


@lru_cache(maxsize=128)
def _python_symbols(
    module: str,
    origin: str,
    source: bytes,
) -> tuple[frozenset[str], bool]:
    try:
        tree = ast.parse(source)
        symbols = symtable.symtable(source, origin, "exec").get_symbols()
    except (SyntaxError, ValueError) as exc:
        raise ConfigurationError(f"handler module has invalid Python syntax: {module}") from exc
    names = frozenset(
        symbol.get_name()
        for symbol in symbols
        if symbol.is_assigned() or symbol.is_imported()
    )
    dynamic = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            dynamic |= node.name == "__getattr__"
        elif isinstance(node, ast.alias):
            dynamic |= node.name == "*"
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            dynamic |= node.func.id in {"exec", "globals", "locals", "setattr"}
    return names, dynamic


def _http(
    config: ProjectConfig,
    operation: dict,
    request: Any,
    *,
    live: bool,
) -> dict[str, Any] | None:
    http_settings(template_shape(operation), operation=True)
    http_settings(request)
    if isinstance(request, Deferred):
        return None
    settings = (
        request_settings(operation, request, config.environment) if live
        else merge_nested(template_shape(operation), request)
    )
    http_settings(settings, operation=True, required=True)
    if not isinstance(settings.get("max_response_bytes"), Deferred) and (
        settings["max_response_bytes"] > operation["max_response_bytes"]
    ):
        raise ConfigurationError(
            "HTTP request max_response_bytes exceeds operation limit",
            code="INVALID_VALUE", field="max_response_bytes",
        )
    return settings


def _database(config: ProjectConfig, operation: dict, request: Any, settings: dict, *, live: bool) -> None:
    fields(operation, {
        "executor", "connection", "statement", "write", "execute_many", "read_retries",
        "retry_delay_seconds",
    }, "database operation")
    text(operation.get("statement"), "database statement")
    kind = sql_type(operation["statement"])
    write = kind in WRITE_SQL_TYPES
    if write != operation.get("write", False):
        raise ConfigurationError(f"database write flag disagrees with SQL type {kind}")
    for key in ("write", "execute_many"):
        if key in operation:
            typed(operation[key], bool, f"database {key}")
    for key in ("read_retries", "retry_delay_seconds"):
        if key in operation:
            number(operation[key], key, integer=key == "read_retries")
    if not isinstance(request, Deferred):
        parameters = request.get("parameters", request)
        typed(parameters, (dict, list, tuple), "database parameters")
        if operation.get("execute_many"):
            typed(parameters, list, "database execute_many parameters")
        if not isinstance(parameters, Deferred):
            bindings = [
                token.value for token in sqlparse.parse(operation["statement"])[0].flatten()
                if token.ttype in sqlparse.tokens.Name.Placeholder
            ]
            for row in parameters if operation.get("execute_many") else [parameters]:
                if isinstance(row, Deferred):
                    continue
                typed(row, (dict, list, tuple), "database parameter row")
                named = [
                    match.group(1) or match.group(2)
                    for binding in bindings
                    if (match := re.fullmatch(r"[:@$](\w+)|%\((\w+)\)s", binding))
                ]
                if isinstance(row, dict):
                    missing = set(named) - row.keys()
                    if missing:
                        raise ConfigurationError(f"missing SQL bound parameters: {sorted(missing)}")
                    if any(binding in {"?", "%s"} for binding in bindings):
                        raise ConfigurationError("positional SQL placeholders require a parameter list")
                elif len(row) != len(bindings):
                    raise ConfigurationError("SQL placeholder count differs from parameter list length")
    name = operation.get("connection", "default")
    text(name, "database connection")
    connection = config.runtime.get("database", {}).get("connections", {}).get(name)
    if connection is None:
        raise ConfigurationError(f"unknown database connection: {name}")
    if not live:
        return
    connection = config.connection(name)
    driver = connection.get("driver", "sqlite")
    if not isinstance(driver, str) or driver.lower() not in {"sqlite", "mysql"}:
        raise ConfigurationError("unsupported database driver")
    common = {"driver", "read_only", "read_retries", "retry_delay_seconds"}
    supported = (
        {"database", "timeout", "detect_types", "isolation_level", "check_same_thread",
         "factory", "cached_statements", "uri", "autocommit", "pragmas"}
        if driver.lower() == "sqlite"
        else set(inspect.signature(pymysql.connect).parameters) | {"timeout_seconds"}
    )
    fields(connection, common | supported, "database connection")
    permission = settings["allow_db_write"]
    allowed = settings["run_mode"] != "read" if permission is None else permission
    if write and (not allowed or connection.get("read_only", False)):
        raise ConfigurationError("database write blocked by run settings or read-only connection")
    for key in ("read_retries", "retry_delay_seconds", "timeout_seconds"):
        if key in connection:
            number(connection[key], f"database connection.{key}", integer=key == "read_retries")


def _snapshot(config: ProjectConfig, case: Case, step_id: str, spec: Any, mode: str, mock: Any) -> bool:
    if spec in (None, "", False):
        return False
    if isinstance(spec, Deferred):
        return True
    snapshot_settings(spec, spec=True)
    spec = {"rule": spec} if isinstance(spec, str) else spec
    name = spec.get("rule", "response_default")
    if isinstance(name, Deferred):
        return True
    rule = {**config.snapshot_rule(case.snapshot_profile, name), **{k: v for k, v in spec.items() if k != "rule"}}
    snapshot_settings(rule)
    select = rule.get("select", "$")
    if not isinstance(select, Deferred):
        path_parts(select)
    if has_deferred(rule):
        return True
    SnapshotManager._require_baseline_confirmation(mode, config.environment)
    kind = rule.get("kind", "response")
    name = rule.get("name", step_id)
    suffix = ".json"
    if kind == "screenshot":
        artifact = rule.get("artifact", "screenshot")
        artifacts = mock.get("artifacts", {}) if isinstance(mock, dict) else {}
        source = artifacts.get(artifact) if isinstance(artifacts, dict) else None
        if source is None or isinstance(source, Deferred):
            return True
        path = config.root / str(source)
        if not path.is_file():
            raise ConfigurationError(f"screenshot artifact does not exist: {path}")
        suffix = path.suffix.lower() or ".png"
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise ConfigurationError("unsupported screenshot snapshot extension")
    target = None
    if config.runtime.get("snapshot_backend", "file").lower() == "file":
        target = snapshot_target(
            config.root / config.runtime.get("snapshot_dir", "snapshots"),
            case.id, name, suffix,
        )
    if mode != "read":
        return False
    if config.runtime.get("snapshot_backend", "file").lower() == "sqlite":
        database = config.root / config.runtime.get("snapshot_database", ".easytest/snapshots.db")
        if not database.is_file():
            raise ConfigurationError(f"SQLite snapshot baseline does not exist: {case.id}/{name}")
        wal = database.with_name(database.name + "-wal")
        if wal.is_file() and wal.stat().st_size:
            # Pending writer state cannot be read immutably without losing WAL data.
            # Defer instead of creating/updating shared-memory sidecar files.
            return True
        try:
            # Never construct SqliteSnapshotStore here: its constructor writes schema.
            connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
            try:
                row = connection.execute(
                    "SELECT 1 FROM snapshot_items i JOIN snapshot_runs r "
                    "ON i.run_id=r.run_id AND i.case_id=r.case_id "
                    "WHERE i.case_id=? AND i.name=? AND r.status='completed' LIMIT 1",
                    (case.id, name),
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error as exc:
            raise ConfigurationError("cannot read SQLite snapshot baseline") from exc
        if row is None:
            raise ConfigurationError(f"SQLite snapshot baseline does not exist: {case.id}/{name}")
    else:
        if not target.is_file():
            raise ConfigurationError(f"snapshot baseline does not exist: {target}")
        if suffix == ".json":
            try:
                json.loads(target.read_text(encoding="utf-8"))
            except (ValueError, UnicodeError) as exc:
                raise ConfigurationError(f"invalid JSON snapshot baseline: {target}") from exc
    return False


def preflight(
    cases: Iterable[Case], config: ProjectConfig, settings: dict[str, Any], *,
    custom_executors: set[str] | None = None,
    handlers: dict[str, dict[str, Any]] | None = None,
    execution_policy: ExecutionPolicy | None = None,
) -> PreflightResult:
    selected = list(cases)
    result = PreflightResult()
    seen = set()
    mocks = MockEngine(config)
    handler_cache: dict[str, tuple[frozenset[str], bool]] = {}
    if execution_policy is not None:
        execution_policy.check_profile(settings["profile"])
    for case in selected:
        step_id = ""
        field_name = "case"
        try:
            if case.id in seen:
                raise ContractError(f"duplicate case id: {case.id}")
            seen.add(case.id)
            _case_contract(case)
            if execution_policy is not None:
                execution_policy.check_case(case)
            result.case_count += 1
            field_name = "mock_profile"
            mock_profile = case.mock_profile or settings["mock_profile"]
            config.mock_profile(mock_profile)
            context = RunContext(case, config.root, settings["run_mode"], dict(case.variables))
            scope = context.template_scope()
            scope["state"] = DEFERRED
            if config.runtime.get("snapshot_backend") == "sqlite":
                SnapshotManager._require_baseline_confirmation(settings["run_mode"], config.environment)
            for step in case.steps:
                step_id = step.id
                field_name = "operation"
                operation = config.operation(step.operation, step.executor)
                custom_executor = step.executor in (custom_executors or set())
                if execution_policy is not None:
                    execution_policy.check_step(
                        executor=step.executor,
                        operation=step.operation,
                        custom_executor=custom_executor,
                    )
                field_name = "request"
                if step.executor == "http" and not custom_executor:
                    http_secret_sources(step.request, runtime_templates=True)
                request = render_templates(step.request, scope)
                field_name = "mock"
                raw_mock = mocks.resolve(
                    step_mock=step.mock, profile_name=mock_profile, operation_name=step.operation,
                )
                if (
                    step.executor == "http" and not custom_executor
                    and isinstance(raw_mock, dict) and raw_mock.get("kind") == "inject"
                ):
                    http_secret_sources(raw_mock.get("request"), runtime_templates=True)
                mock = render_templates(raw_mock, scope)
                mock_settings(mock)
                field_name = "expect"
                expectation = render_templates(step.expect, scope)
                expectation_checks(expectation)
                field_name = "snapshot"
                snapshot = render_templates(step.snapshot, scope)
                deferred_reasons = (
                    ["Step output/state values require runtime validation."]
                    if has_deferred((request, mock, expectation, snapshot)) else []
                )
                kind = mock.get("kind", "response") if isinstance(mock, dict) else None
                live = mock is None or kind == "inject" or isinstance(kind, Deferred) or isinstance(mock, Deferred)
                if live and settings["fail_on_mock_miss"]:
                    raise MockMissError(
                        f"strict profile blocked real execution: {step.operation}; "
                        "provide a response/state mock or select a live profile"
                    )
                if kind == "inject":
                    injected = mock.get("request", {})
                    request = (
                        DEFERRED if isinstance(request, Deferred) or isinstance(injected, Deferred)
                        else merge_nested(request, injected)
                    )
                field_name = f"{step.executor} operation"
                if custom_executor:
                    deferred_reasons.append("Custom executor parameters and behavior require adapter validation.")
                elif step.executor == "http":
                    http = _http(config, operation, request, live=live)
                    if execution_policy is not None and live:
                        execution_policy.check_http(http or {})
                elif step.executor == "database":
                    _database(config, operation, request, settings, live=live)
                else:
                    if step.executor != "scenario" or "builtin" not in operation:
                        fields(
                            operation,
                            {"executor", "handler", "endpoint", "auth"} if step.executor == "rpc"
                            else {"executor", "handler"}, f"{step.executor} operation",
                        )
                    builtin = operation.get("builtin") if step.executor == "scenario" else None
                    if builtin is not None:
                        if builtin not in ("set", "get", "wait"):
                            raise ConfigurationError("unsupported scenario builtin")
                        fields(operation, {"executor", "builtin", "path", "value", "seconds"}, "scenario operation")
                        if not isinstance(request, Deferred):
                            fields(request, {"seconds"} if builtin == "wait" else {"path", "value"}, "scenario request")
                            if builtin == "wait":
                                number(request.get("seconds", operation.get("seconds", 0)), "wait seconds")
                            else:
                                path = request.get("path", operation.get("path", ""))
                                text(path, "scenario path")
                                if not isinstance(path, Deferred):
                                    if builtin == "set":
                                        state_write_parts(path)
                                    else:
                                        path_parts(path)
                    elif live:
                        handler = (handlers or {}).get(step.executor, {}).get(step.operation)
                        if handler is not None:
                            if not callable(handler):
                                raise ConfigurationError("injected handler must be callable")
                        else:
                            _handler(operation.get("handler"), handler_cache)
                        deferred_reasons.append("Handler dependencies, callability and behavior require runtime validation.")
                    if step.executor == "rpc" and live:
                        resolve_env(operation.get("auth", {}), config.environment)
                        resolve_env(operation.get("endpoint"), config.environment)
                field_name = "snapshot"
                if _snapshot(
                    config, case, step.id, snapshot, settings["run_mode"], mock,
                ):
                    deferred_reasons.append("Dynamic snapshot rules, artifacts or pending SQLite WAL require runtime validation.")
                if deferred_reasons:
                    result.deferred.append({
                        "case_id": case.id, "step_id": step.id,
                        "reason": " ".join(deferred_reasons),
                    })
                scope["steps"][step.save_as or step.id] = DEFERRED
                result.step_count += 1
        except (ConfigurationError, ContractError) as exc:
            if exc.field in {"config", "cases"}:
                exc.field = field_name
            exc.preflight_case_id = case.id
            exc.preflight_step_id = step_id
            exc.preflight_source = case.source
            location = f"Case={case.id}, Step={step_id or 'unknown'}, Source={case.source}"
            if step_id:
                failed = next(step for step in case.steps if step.id == step_id)
                exc.preflight_operation = failed.operation
                exc.preflight_source_row = failed.source_row
                location += f", Operation={failed.operation}"
                if failed.source_row is not None:
                    location += f", sheet=steps, row={failed.source_row}"
            exc.add_note(location)
            raise
    result.input_hash = execution_input_hash(
        selected,
        config,
        settings,
        execution_policy,
    )
    return result
