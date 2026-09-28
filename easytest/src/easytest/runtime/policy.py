from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from easytest.config import ProjectConfig
from easytest.models import Case, ConfigurationError
from easytest.serialization import to_jsonable


POLICY_ENV = "EASYTEST_EXECUTION_POLICY"
_EXECUTORS = {"scenario", "http", "rpc", "database", "ui"}
_METHOD = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_FIELDS = {
    "schema_version",
    "allowed_profiles",
    "allowed_case_ids",
    "allowed_operations",
    "allowed_executors",
    "allowed_http_methods",
    "allowed_http_origins",
    "allow_custom_executors",
}
_REQUIRED_FIELDS = {
    "schema_version",
    "allowed_profiles",
    "allowed_case_ids",
    "allowed_operations",
    "allowed_executors",
}


def _violation(message: str, field_name: str) -> ConfigurationError:
    return ConfigurationError(
        message,
        code="EXECUTION_POLICY_VIOLATION",
        field=f"execution_policy.{field_name}",
    )


def _allowlist(
    document: dict[str, Any],
    name: str,
    *,
    allow_none: bool = False,
) -> frozenset[str | None]:
    value = document.get(name)
    if not isinstance(value, list) or not value:
        raise _violation(f"{name} must be a non-empty list", name)
    if not all(isinstance(item, str) or (allow_none and item is None) for item in value):
        raise _violation(f"{name} contains an invalid value", name)
    normalized = [item.strip() if isinstance(item, str) else None for item in value]
    if any(item == "" for item in normalized):
        raise _violation(f"{name} cannot contain an empty string", name)
    if "*" in normalized and len(normalized) != 1:
        raise _violation(f"{name} must use '*' by itself", name)
    return frozenset(normalized)


def _origin(value: str, *, field_name: str, require_origin: bool = False) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise _violation(f"{field_name} contains an invalid origin", field_name) from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or (
            require_origin
            and (parsed.path not in {"", "/"} or parsed.query or parsed.fragment)
        )
    ):
        raise _violation(
            f"{field_name} entries must be HTTP origins without path, query, or credentials",
            field_name,
        )
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 80 if parsed.scheme == "http" else 443
    suffix = "" if port in {None, default_port} else f":{port}"
    return f"{parsed.scheme.lower()}://{host}{suffix}"


@dataclass(frozen=True)
class ExecutionPolicy:
    allowed_profiles: frozenset[str | None]
    allowed_case_ids: frozenset[str]
    allowed_operations: frozenset[str]
    allowed_executors: frozenset[str]
    allowed_http_methods: frozenset[str] = field(default_factory=frozenset)
    allowed_http_origins: frozenset[str] = field(default_factory=frozenset)
    allow_custom_executors: bool = False
    source: str = ""

    @classmethod
    def from_file(cls, path: str | Path) -> ExecutionPolicy:
        source = Path(path).resolve()
        try:
            document = json.loads(source.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise _violation(f"execution policy does not exist: {source}", "source") from exc
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise _violation(f"execution policy is not valid JSON: {source}", "source") from exc
        if not isinstance(document, dict):
            raise _violation("execution policy must be a JSON object", "document")
        unknown = document.keys() - _FIELDS
        if unknown:
            raise _violation(
                f"execution policy contains unknown fields: {sorted(unknown)}",
                sorted(unknown)[0],
            )
        missing = _REQUIRED_FIELDS - document.keys()
        if missing:
            raise _violation(
                f"execution policy is missing fields: {sorted(missing)}",
                sorted(missing)[0],
            )
        if document.get("schema_version") != 1:
            raise _violation("execution policy schema_version must be 1", "schema_version")

        executors = _allowlist(document, "allowed_executors")
        if "*" not in executors and not executors <= _EXECUTORS:
            raise _violation("allowed_executors contains an unsupported executor", "allowed_executors")
        methods = _allowlist(document, "allowed_http_methods") if "allowed_http_methods" in document else frozenset()
        if "*" not in methods:
            methods = frozenset(str(item).upper() for item in methods)
            if any(not _METHOD.fullmatch(item) for item in methods):
                raise _violation("allowed_http_methods contains an invalid method", "allowed_http_methods")
        origins = _allowlist(document, "allowed_http_origins") if "allowed_http_origins" in document else frozenset()
        if "*" not in origins:
            origins = frozenset(
                _origin(
                    str(item),
                    field_name="allowed_http_origins",
                    require_origin=True,
                )
                for item in origins
            )
        custom = document.get("allow_custom_executors", False)
        if not isinstance(custom, bool):
            raise _violation("allow_custom_executors must be a boolean", "allow_custom_executors")
        return cls(
            allowed_profiles=_allowlist(document, "allowed_profiles", allow_none=True),
            allowed_case_ids=frozenset(_allowlist(document, "allowed_case_ids")),
            allowed_operations=frozenset(_allowlist(document, "allowed_operations")),
            allowed_executors=frozenset(executors),
            allowed_http_methods=frozenset(methods),
            allowed_http_origins=frozenset(origins),
            allow_custom_executors=custom,
            source=str(source),
        )

    @staticmethod
    def _permits(allowed: frozenset[Any], value: Any) -> bool:
        return "*" in allowed or value in allowed

    def check_profile(self, profile: str | None) -> None:
        if not self._permits(self.allowed_profiles, profile):
            raise _violation(f"profile is not allowed: {profile!r}", "allowed_profiles")

    def check_case(self, case: Case) -> None:
        if not (
            self._permits(self.allowed_case_ids, case.id)
            or self._permits(self.allowed_case_ids, case.execution_id)
        ):
            raise _violation(
                f"Case is not allowed: {case.execution_id}",
                "allowed_case_ids",
            )

    def check_step(
        self,
        *,
        executor: str,
        operation: str,
        custom_executor: bool,
    ) -> None:
        if not self._permits(self.allowed_executors, executor):
            raise _violation(f"executor is not allowed: {executor}", "allowed_executors")
        if not self._permits(self.allowed_operations, operation):
            raise _violation(f"operation is not allowed: {operation}", "allowed_operations")
        if custom_executor and not self.allow_custom_executors:
            raise _violation(
                f"custom executor is not allowed: {executor}",
                "allow_custom_executors",
            )

    def check_http(self, settings: dict[str, Any]) -> None:
        method = settings.get("method", "GET")
        url = settings.get("url")
        if not isinstance(method, str):
            raise _violation("HTTP method must be statically known", "allowed_http_methods")
        if not isinstance(url, str):
            raise _violation("HTTP target must be statically known", "allowed_http_origins")
        method = method.upper()
        if not self.allowed_http_methods:
            raise _violation(
                "allowed_http_methods is required for live HTTP execution",
                "allowed_http_methods",
            )
        if not self._permits(self.allowed_http_methods, method):
            raise _violation(f"HTTP method is not allowed: {method}", "allowed_http_methods")
        if not self.allowed_http_origins:
            raise _violation(
                "allowed_http_origins is required for live HTTP execution",
                "allowed_http_origins",
            )
        origin = _origin(url, field_name="allowed_http_origins")
        if not self._permits(self.allowed_http_origins, origin):
            raise _violation(f"HTTP origin is not allowed: {origin}", "allowed_http_origins")
        if settings.get("allow_redirects", True) is not False:
            raise _violation(
                "HTTP redirects must be disabled when an execution policy is active",
                "allowed_http_origins",
            )

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "allowed_profiles": sorted(
                self.allowed_profiles,
                key=lambda item: "" if item is None else str(item),
            ),
            "allowed_case_ids": sorted(self.allowed_case_ids),
            "allowed_operations": sorted(self.allowed_operations),
            "allowed_executors": sorted(self.allowed_executors),
            "allowed_http_methods": sorted(self.allowed_http_methods),
            "allowed_http_origins": sorted(self.allowed_http_origins),
            "allow_custom_executors": self.allow_custom_executors,
        }


def load_execution_policy(
    root: str | Path,
    explicit: str | Path | ExecutionPolicy | None = None,
) -> ExecutionPolicy | None:
    forced = os.environ.get(POLICY_ENV)
    if isinstance(explicit, ExecutionPolicy):
        if forced and Path(forced).resolve() != Path(explicit.source).resolve():
            raise _violation(
                f"{POLICY_ENV} cannot be overridden by a different policy",
                "source",
            )
        return explicit
    selected: str | Path | None = forced or explicit
    if selected is None:
        return None
    selected_path = Path(selected)
    if forced and not selected_path.is_absolute():
        raise _violation(f"{POLICY_ENV} must contain an absolute path", "source")
    if not selected_path.is_absolute():
        selected_path = Path(root) / selected_path
    if forced and explicit is not None:
        explicit_path = Path(explicit)
        if not explicit_path.is_absolute():
            explicit_path = Path(root) / explicit_path
        if explicit_path.resolve() != selected_path.resolve():
            raise _violation(
                f"{POLICY_ENV} cannot be overridden by --execution-policy",
                "source",
            )
    return ExecutionPolicy.from_file(selected_path)


def execution_input_hash(
    cases: list[Case],
    config: ProjectConfig,
    settings: dict[str, Any],
    policy: ExecutionPolicy | None,
) -> str:
    case_values = []
    for case in cases:
        value = asdict(case)
        value.pop("source", None)
        value.pop("data_source_row", None)
        for step in value["steps"]:
            step.pop("source_row", None)
        case_values.append(value)
    payload = {
        "schema_version": 1,
        "cases": case_values,
        "config": {
            "runtime": config.runtime,
            "operations": config.operations,
            "mock_profiles": config.mock_profiles,
            "mock_presets": config.mock_presets,
            "snapshot_profiles": config.snapshot_profiles,
            "profiles": config.profiles,
        },
        "settings": settings,
        "execution_policy": policy.as_dict() if policy is not None else None,
    }
    encoded = json.dumps(
        to_jsonable(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"
