from __future__ import annotations

import importlib
import copy
import json
import os
import re
from collections import ChainMap
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from dotenv import dotenv_values
from dotenv.variables import parse_variables

from easytest.models import ConfigurationError
from easytest.validation import http_secret_sources, mock_settings, snapshot_settings, template_shape, text
from easytest.transport.http import DEFAULT_MAX_RESPONSE_BYTES, response_limit

_ENV_PATTERN = re.compile(r"\$\{([A-Z][A-Z0-9_]*)}")


def _is_note_key(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("__note_")
        and value.endswith("__")
    )


def _strip_note_keys(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_note_keys(item)
            for key, item in value.items()
            if not _is_note_key(key)
        }
    if isinstance(value, list):
        return [_strip_note_keys(item) for item in value]
    return value


def _load_json(path: Path, *, optional: bool = False) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        if optional:
            return {}
        raise ConfigurationError(
            f"missing configuration file: {path}", code="MISSING_CONFIGURATION", field=str(path),
        ) from exc
    except json.JSONDecodeError as exc:
        raise ConfigurationError(
            f"invalid JSON in {path}: {exc}", code="INVALID_JSON", field=str(path),
        ) from exc
    if not isinstance(value, dict):
        raise ConfigurationError(f"{path} must contain a JSON object")
    return _strip_note_keys(value)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigurationError(f"{label} must be an object", code="INVALID_TYPE", field=label)
    return value


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ConfigurationError(f"{label} must be a boolean", code="INVALID_TYPE", field=label)
    return value


def _run_mode(value: Any) -> str:
    if not isinstance(value, str) or value.lower() not in {"read", "write", "baseline"}:
        raise ConfigurationError(f"invalid run mode: {value!r}")
    return value.lower()


def _observability(value: Any) -> None:
    settings = _object(value, "runtime.observability")
    _known_fields(settings, {"emit_stdout", "max_event_length"}, "runtime.observability")
    if "emit_stdout" in settings:
        _boolean(settings["emit_stdout"], "observability.emit_stdout")
    if "max_event_length" in settings and (
        type(settings["max_event_length"]) is not int or settings["max_event_length"] < 1000
    ):
        raise ConfigurationError("observability.max_event_length must be an integer >= 1000")


def _known_fields(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = value.keys() - allowed
    if unknown:
        raise ConfigurationError(
            f"unknown fields in {label}: {sorted(unknown)}",
            code="UNKNOWN_FIELD", field=f"{label}.{sorted(unknown)[0]}",
        )


def resolve_env(value: Any, environment: Mapping[str, str | None] | None = None) -> Any:
    environment = os.environ if environment is None else environment
    if isinstance(value, dict):
        return {key: resolve_env(item, environment) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_env(item, environment) for item in value]
    if not isinstance(value, str):
        return value

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        resolved = environment.get(name)
        if resolved is None:
            raise ConfigurationError(
                f"required environment variable {name} is not set",
                code="MISSING_ENVIRONMENT_VARIABLE", field=f"environment.{name}",
            )
        return resolved

    return _ENV_PATTERN.sub(replace, value)


def load_handler(reference: str) -> Callable[..., Any]:
    if ":" not in reference:
        raise ConfigurationError(
            f"handler must use 'package.module:function' syntax: {reference!r}"
        )
    module_name, function_name = reference.split(":", 1)
    try:
        handler = getattr(importlib.import_module(module_name), function_name)
    except (ImportError, AttributeError) as exc:
        raise ConfigurationError(f"cannot load handler {reference!r}") from exc
    if not callable(handler):
        raise ConfigurationError(f"handler {reference!r} is not callable")
    return handler


class ProjectConfig:
    def __init__(self, root: str | Path, config_dir: str | Path = "config") -> None:
        self.root = Path(root).resolve()
        local: dict[str, str | None] = {}
        self.environment = ChainMap(os.environ, local)
        for name, value in dotenv_values(self.root / ".env", interpolate=False).items():
            local[name] = (
                "".join(part.resolve(self.environment) for part in parse_variables(value))
                if value is not None else None
            )
        directory = Path(config_dir)
        self.config_dir = (
            directory if directory.is_absolute() else self.root / directory
        )

        self.runtime = _load_json(self.config_dir / "runtime.json", optional=True)
        operation_data = _load_json(self.config_dir / "operations.json")
        _known_fields(operation_data, {"operations"}, "operations.json")
        self.operations = operation_data.get("operations", {})
        mock_data = _load_json(self.config_dir / "mock_profiles.json", optional=True)
        _known_fields(mock_data, {"presets", "profiles"}, "mock_profiles.json")
        self.mock_presets = mock_data.get("presets", {})
        self.mock_profiles = mock_data.get("profiles", {})
        snapshot_data = _load_json(self.config_dir / "snapshots.json", optional=True)
        _known_fields(snapshot_data, {"profiles"}, "snapshots.json")
        self.snapshot_profiles = snapshot_data.get("profiles", {})
        profile_data = _load_json(self.config_dir / "profiles.json", optional=True)
        _known_fields(profile_data, {"profiles"}, "profiles.json")
        self.profiles = _object(profile_data.get("profiles", {}), "profiles")
        self._validate()

    def _validate(self) -> None:
        _known_fields(self.runtime, {
            "run_mode", "allow_db_write", "default_profile", "database", "observability",
            "snapshot_backend", "snapshot_database", "snapshot_dir", "snapshot_history_keep",
            "http", "redaction",
        }, "runtime")
        http = _object(self.runtime.get("http", {}), "runtime.http")
        _known_fields(http, {"max_response_bytes"}, "runtime.http")
        limit = response_limit(http.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES))
        redaction = _object(self.runtime.get("redaction", {}), "runtime.redaction")
        _known_fields(redaction, {"secret_keys", "pii_keys"}, "runtime.redaction")
        for key, values in redaction.items():
            if not isinstance(values, list) or any(
                not isinstance(item, str) or not item.strip() for item in values
            ):
                raise ConfigurationError(f"runtime.redaction.{key} must be a list of non-empty strings")
        _run_mode(self.runtime.get("run_mode", "read"))
        if "allow_db_write" in self.runtime:
            _boolean(self.runtime["allow_db_write"], "runtime.allow_db_write")
        for key in ("snapshot_dir", "snapshot_database"):
            if key in self.runtime:
                text(self.runtime[key], f"runtime.{key}")
        for label, values in (
            ("mock presets", self.mock_presets),
            ("mock profiles", self.mock_profiles),
            ("snapshot profiles", self.snapshot_profiles),
        ):
            for name, value in _object(values, label).items():
                _object(value, f"{label}.{name}")
        for preset in self.mock_presets.values():
            mock_settings(template_shape(preset))
        for profile in self.mock_profiles.values():
            for spec in profile.values():
                mock_settings(template_shape(spec))
        for profile in self.snapshot_profiles.values():
            for rule in profile.values():
                snapshot_settings(template_shape(rule))
        for name, profile in self.profiles.items():
            _object(profile, f"profile {name}")
            _known_fields(
                profile, {"mock_profile", "fail_on_mock_miss", "runtime", "allow_db_write"},
                f"profile {name}",
            )
            if "mock_profile" in profile:
                if not isinstance(profile["mock_profile"], str) or not profile["mock_profile"]:
                    raise ConfigurationError(f"profile {name}.mock_profile must be a non-empty string")
                self.mock_profile(profile["mock_profile"])
            for key in ("fail_on_mock_miss", "allow_db_write"):
                if key in profile:
                    _boolean(profile[key], f"profile {name}.{key}")
            runtime = _object(profile.get("runtime", {}), f"profile {name}.runtime")
            _known_fields(runtime, {"run_mode", "observability"}, f"profile {name}.runtime")
            if "run_mode" in runtime:
                _run_mode(runtime["run_mode"])
            observation = runtime.get("observability", {})
            _observability(observation)
            _known_fields(observation, {"emit_stdout", "max_event_length"}, f"profile {name}.observability")
        if "default_profile" in self.runtime:
            self._profile(self.runtime["default_profile"])
        snapshot_backend = str(self.runtime.get("snapshot_backend", "file")).lower()
        if snapshot_backend not in {"file", "sqlite"}:
            raise ConfigurationError(
                "runtime.snapshot_backend must be 'file' or 'sqlite'"
            )
        history_keep = self.runtime.get("snapshot_history_keep")
        if history_keep is not None and (
            type(history_keep) is not int or history_keep < 1
        ):
            raise ConfigurationError(
                "runtime.snapshot_history_keep must be a positive integer or null"
            )
        _observability(self.runtime.get("observability", {}))

        if not isinstance(self.operations, dict) or not self.operations:
            raise ConfigurationError(
                "operations.json must define a non-empty operations object"
            )
        for name, operation in self.operations.items():
            if not isinstance(operation, dict):
                raise ConfigurationError(f"operation {name!r} must be an object")
            if operation.get("executor") not in {
                "scenario",
                "http",
                "rpc",
                "database",
                "ui",
            }:
                raise ConfigurationError(f"operation {name!r} has an invalid executor")
            if operation.get("executor") == "database":
                if "write" in operation:
                    _boolean(operation["write"], f"operation {name}.write")
                statement = operation.get("statement")
                if not isinstance(statement, str) or not statement.strip():
                    raise ConfigurationError(
                        f"database operation {name!r} must define statement"
                    )
                if "${" in statement:
                    raise ConfigurationError(
                        f"database operation {name!r} must use bound parameters, "
                        "not environment interpolation in SQL"
                    )
            if operation.get("executor") == "http":
                http_secret_sources(operation)
                if response_limit(operation.get("max_response_bytes", limit)) > limit:
                    raise ConfigurationError(
                        "HTTP operation max_response_bytes exceeds runtime.http limit",
                        code="INVALID_VALUE", field=f"operations.{name}.max_response_bytes",
                    )
            if operation.get("executor") == "rpc":
                auth = operation.get("auth", {})
                if not isinstance(auth, dict):
                    raise ConfigurationError(
                        f"RPC operation {name!r} auth must be an object"
                    )
                for key, value in auth.items():
                    if not isinstance(value, str) or not _ENV_PATTERN.fullmatch(value):
                        raise ConfigurationError(
                            f"RPC operation {name!r} must source auth field {key!r} "
                            "from an environment variable"
                        )

        database = _object(self.runtime.get("database", {}), "runtime.database")
        _known_fields(database, {"connections"}, "runtime.database")
        connections = database.get("connections", {})
        if not isinstance(connections, dict):
            raise ConfigurationError("runtime.database.connections must be an object")
        for name, connection in connections.items():
            if not isinstance(connection, dict):
                raise ConfigurationError(
                    f"database connection {name!r} must be an object"
                )
            if "password" in connection:
                raise ConfigurationError(
                    f"database connection {name!r} must use password_env, not password"
                )
            if "read_only" in connection:
                _boolean(connection["read_only"], f"connection {name}.read_only")

    def _profile(self, name: str) -> dict[str, Any]:
        if not isinstance(name, str) or not name or name not in self.profiles:
            raise ConfigurationError(f"unknown profile: {name!r}", code="UNKNOWN_PROFILE", field="profile")
        return self.profiles[name]

    def resolve_run(
        self, *, run_mode: str | None = None, profile: str | None = None,
        allow_db_write: bool | None = None,
    ) -> dict[str, Any]:
        """Resolve once for CLI, pytest and Notebook without mutating base settings."""
        selected = profile if profile is not None else self.runtime.get("default_profile")
        preset = self._profile(selected) if selected is not None else {}
        runtime = copy.deepcopy(self.runtime)
        overrides = preset.get("runtime", {})
        runtime["observability"] = {
            **runtime.get("observability", {}), **overrides.get("observability", {})
        }
        mode = run_mode
        if mode is None:
            mode = overrides.get("run_mode", self.environment.get("RUN_MODE"))
        if mode is None:
            mode = runtime.get("run_mode", "read")
        runtime["run_mode"] = _run_mode(mode)
        permission = allow_db_write
        if permission is None:
            permission = preset.get("allow_db_write", runtime.get("allow_db_write"))
        if permission is not None:
            _boolean(permission, "allow_db_write")
        return {
            "profile": selected,
            "runtime": runtime,
            "run_mode": runtime["run_mode"],
            "mock_profile": preset.get("mock_profile"),
            "fail_on_mock_miss": preset.get("fail_on_mock_miss", False),
            "allow_db_write": permission,
        }

    def operation(self, name: str, executor: str) -> dict[str, Any]:
        try:
            operation = self.operations[name]
        except KeyError as exc:
            raise ConfigurationError(
                f"unknown operation: {name}", code="UNKNOWN_OPERATION", field="operation",
            ) from exc
        configured_executor = operation.get("executor")
        if configured_executor != executor:
            raise ConfigurationError(
                f"operation {name!r} uses executor {configured_executor!r}, "
                f"but step requested {executor!r}",
                code="EXECUTOR_MISMATCH", field="executor",
            )
        result = dict(operation)
        if executor == "http":
            result.setdefault(
                "max_response_bytes",
                self.runtime.get("http", {}).get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES),
            )
        return result

    def connection(self, name: str) -> dict[str, Any]:
        connections = self.runtime.get("database", {}).get("connections", {})
        try:
            connection = dict(connections[name])
        except KeyError as exc:
            raise ConfigurationError(
                f"unknown database connection: {name}", code="UNKNOWN_CONNECTION", field="connection",
            ) from exc
        password_env = connection.pop("password_env", None)
        if password_env:
            password = self.environment.get(str(password_env))
            if password is None:
                raise ConfigurationError(
                    f"required database password environment variable {password_env} is not set",
                    code="MISSING_ENVIRONMENT_VARIABLE", field=f"environment.{password_env}",
                )
            connection["password"] = password
        return resolve_env(connection, self.environment)

    def mock_profile(self, name: str | None) -> dict[str, Any]:
        if not name:
            return {}
        try:
            profile = self.mock_profiles[name]
        except KeyError as exc:
            raise ConfigurationError(
                f"unknown mock profile: {name}", code="UNKNOWN_MOCK_PROFILE", field="mock_profile",
            ) from exc
        if not isinstance(profile, dict):
            raise ConfigurationError(f"mock profile {name!r} must be an object")
        return profile

    def mock_preset(self, name: str) -> dict[str, Any]:
        try:
            preset = self.mock_presets[name]
        except KeyError as exc:
            raise ConfigurationError(
                f"unknown mock preset: {name}", code="UNKNOWN_MOCK_PRESET", field="mock.preset",
            ) from exc
        if not isinstance(preset, dict):
            raise ConfigurationError(f"mock preset {name!r} must be an object")
        return dict(preset)

    def snapshot_rule(self, profile_name: str, rule_name: str) -> dict[str, Any]:
        try:
            profile = self.snapshot_profiles[profile_name]
            rule = profile[rule_name]
        except KeyError as exc:
            raise ConfigurationError(
                f"unknown snapshot rule {profile_name}.{rule_name}",
                code="UNKNOWN_SNAPSHOT_RULE", field="snapshot.rule",
            ) from exc
        if not isinstance(rule, dict):
            raise ConfigurationError(
                f"snapshot rule {profile_name}.{rule_name} must be an object"
            )
        return dict(rule)
