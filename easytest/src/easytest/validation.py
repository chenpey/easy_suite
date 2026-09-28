"""Shared, side-effect-free checks for framework-owned settings."""
from __future__ import annotations

import math
import re
import string
from http.cookiejar import CookieJar
from typing import Any
from urllib.parse import urlsplit

from easytest.models import ConfigurationError


class Deferred:
    """A value which can only be known during execution."""

    def __deepcopy__(self, memo):
        return self


DEFERRED = Deferred()
PLACEHOLDER = re.compile(r"\$\{([^{}]+)}")


def template_shape(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: template_shape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [template_shape(item) for item in value]
    if isinstance(value, str) and PLACEHOLDER.search(value):
        return DEFERRED
    return value


def has_deferred(value: Any) -> bool:
    if isinstance(value, Deferred):
        return True
    if isinstance(value, dict):
        return any(has_deferred(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(has_deferred(item) for item in value)
    return False


def fields(value: Any, allowed: set[str], label: str) -> None:
    if isinstance(value, Deferred):
        return
    if not isinstance(value, dict):
        raise ConfigurationError(f"{label} must be an object", code="INVALID_TYPE", field=label)
    unknown = value.keys() - allowed
    if unknown:
        raise ConfigurationError(
            f"unknown fields in {label}: {sorted(unknown)}",
            code="UNKNOWN_FIELD", field=f"{label}.{sorted(unknown)[0]}",
        )


def typed(value: Any, types: type | tuple[type, ...], label: str) -> None:
    if not isinstance(value, Deferred) and not isinstance(value, types):
        raise ConfigurationError(f"{label} has an invalid type", code="INVALID_TYPE", field=label)


def text(value: Any, label: str) -> None:
    if isinstance(value, Deferred):
        return
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{label} must be a non-empty string", code="INVALID_VALUE", field=label)


def number(value: Any, label: str, *, minimum: float = 0, integer: bool = False) -> None:
    if isinstance(value, Deferred):
        return
    types = (int,) if integer else (int, float)
    if type(value) not in types or not math.isfinite(value) or value < minimum:
        raise ConfigurationError(
            f"{label} must be a finite {'integer' if integer else 'number'} >= {minimum}",
            code="INVALID_VALUE", field=label,
        )


HTTP_FIELDS = {
    "method", "url", "path", "headers", "params", "data", "json", "retry",
    "expected_status", "raise_for_status", "timeout", "trust_env", "verify",
    "cookies", "files", "allow_redirects", "cert", "stream", "max_response_bytes",
}


def http_secret_sources(value: Any, *, runtime_templates: bool = False) -> None:
    """Check source text before environment/template resolution; never echo values."""
    if not isinstance(value, dict):
        return
    headers = value.get("headers")
    if not isinstance(headers, dict):
        return
    reference = r"\$\{[A-Z][A-Z0-9_]*}"
    if runtime_templates:
        reference = r"\$\{(?:variables|steps|state)\.[^{}]+}"
    for name, item in headers.items():
        key = re.sub(r"[^a-z0-9]", "", str(name).lower())
        sensitive = (
            key in {"authorization", "proxyauthorization", "cookie", "apikey"}
            or any(word in key for word in ("token", "secret", "password", "apikey"))
        )
        if sensitive and item is not None and (
            not isinstance(item, str)
            or not re.fullmatch(r"(?:Bearer |Basic )?" + reference, item, re.IGNORECASE if runtime_templates else 0)
        ):
            raise ConfigurationError(
                "sensitive HTTP headers require an environment reference in operations "
                "or a runtime reference in step requests",
                code="HTTP_SECRET_SOURCE", field=f"HTTP headers.{name}",
            )


def http_settings(value: Any, *, operation: bool = False, required: bool = False) -> None:
    label = "HTTP operation" if operation else "HTTP request"
    fields(value, HTTP_FIELDS | ({"executor"} if operation else set()), label)
    if isinstance(value, Deferred):
        return
    if "max_response_bytes" in value and not isinstance(value["max_response_bytes"], Deferred):
        from easytest.transport.http import response_limit

        response_limit(value["max_response_bytes"])
    if required and "url" not in value:
        raise ConfigurationError(
            "HTTP operation/request must define url", code="MISSING_FIELD", field="HTTP url",
        )
    for key in ("url", "method"):
        if key in value:
            text(value[key], f"HTTP {key}")
    method = value.get("method", "GET")
    if isinstance(method, str) and not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", method):
        raise ConfigurationError("HTTP method must be a valid token")
    url = value.get("url")
    if isinstance(url, str):
        try:
            parsed = urlsplit(url)
            valid = parsed.scheme in {"http", "https"} and parsed.hostname and parsed.port != 0
        except ValueError:
            valid = False
        if not valid:
            raise ConfigurationError("HTTP url must be an absolute http(s) URL")
    for key in ("path", "headers", "params"):
        if key in value and value[key] is not None:
            typed(value[key], dict, f"HTTP {key}")
    if isinstance(value.get("headers"), dict):
        for name, item in value["headers"].items():
            text(name, "HTTP header name")
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
                raise ConfigurationError("invalid HTTP header name")
            typed(item, (str, type(None)), "HTTP header value")
            if isinstance(item, str) and ("\r" in item or "\n" in item or item[:1].isspace()):
                raise ConfigurationError("HTTP header value cannot start with whitespace or contain newlines")
    if required and isinstance(url, str):
        parameters = value.get("path") or {}
        if not isinstance(parameters, Deferred):
            try:
                for _, name, _, _ in string.Formatter().parse(url):
                    if name is not None and re.split(r"[.\[]", name)[0] not in parameters:
                        raise ConfigurationError(f"missing URL path parameter: {name}")
                if not has_deferred(parameters):
                    url.format_map(parameters)
            except (ValueError, KeyError, IndexError, AttributeError, TypeError) as exc:
                raise ConfigurationError("invalid HTTP URL path parameters") from exc
    for key in ("raise_for_status", "trust_env", "allow_redirects", "stream"):
        if key in value:
            typed(value[key], bool, f"HTTP {key}")
    if "verify" in value:
        typed(value["verify"], (bool, str), "HTTP verify")
    if value.get("cookies") is not None:
        typed(value["cookies"], (dict, CookieJar), "HTTP cookies")
    if value.get("files") is not None:
        typed(value["files"], (dict, list, tuple), "HTTP files")
    if value.get("cert") is not None and not isinstance(value["cert"], Deferred):
        cert = value["cert"]
        typed(cert, (str, tuple, list), "HTTP cert")
        if isinstance(cert, (tuple, list)) and len(cert) != 2:
            raise ConfigurationError("HTTP cert requires certificate/key paths")
        for path in cert if isinstance(cert, (tuple, list)) else [cert]:
            text(path, "HTTP cert path")
    if "timeout" in value:
        timeout = value["timeout"]
        if isinstance(timeout, (tuple, list)):
            if len(timeout) != 2:
                raise ConfigurationError("HTTP timeout must contain connect/read values")
            for item in timeout:
                number(item, "HTTP timeout", minimum=0.000001)
        elif timeout is not None:
            number(timeout, "HTTP timeout", minimum=0.000001)
    statuses = value.get("expected_status")
    if statuses is not None and not isinstance(statuses, Deferred):
        _statuses([statuses] if type(statuses) is int else statuses, "HTTP expected_status")
        if not statuses:
            raise ConfigurationError("HTTP expected_status cannot be empty")
    retry = value.get("retry")
    if retry is None or isinstance(retry, Deferred):
        return
    fields(retry, {"retries", "backoff_seconds", "jitter_seconds", "methods", "status_codes"}, "HTTP retry")
    for key in ("retries", "backoff_seconds", "jitter_seconds"):
        if key in retry:
            number(retry[key], f"HTTP retry.{key}", integer=key == "retries")
    if "methods" in retry and not isinstance(retry["methods"], Deferred):
        typed(retry["methods"], (list, tuple, set, frozenset), "HTTP retry.methods")
        for method in retry["methods"]:
            text(method, "HTTP retry method")
    if "status_codes" in retry:
        _statuses(retry["status_codes"], "HTTP retry.status_codes")


def _statuses(value: Any, label: str) -> None:
    if isinstance(value, Deferred):
        return
    typed(value, (list, tuple, set, frozenset), label)
    for item in value:
        number(item, label, minimum=100, integer=True)
        if not isinstance(item, Deferred) and item > 599:
            raise ConfigurationError(f"{label} must contain HTTP status codes")


def mock_settings(value: Any) -> None:
    if value is None or value is False or value == "" or isinstance(value, (str, Deferred)):
        return
    allowed = {
        "preset", "kind", "response", "request", "updates", "values", "repeat_last",
        "delay_seconds", "message", "exception", "artifacts",
    }
    fields(value, allowed, "mock")
    kind = value.get("kind", "response")
    if isinstance(kind, Deferred):
        return
    if not isinstance(kind, str) or kind not in {"response", "inject", "state", "sequence", "exception", "timeout", "service_rejected"}:
        raise ConfigurationError("unsupported mock kind")
    if "preset" not in value:
        kind_fields = {
            "response": {"response", "artifacts"},
            "service_rejected": {"response", "artifacts"},
            "state": {"updates", "response", "artifacts"},
            "sequence": {"values", "repeat_last", "artifacts"},
            "inject": {"request"},
            "timeout": {"delay_seconds", "message"},
            "exception": {"exception", "message"},
        }
        fields(value, {"kind"} | kind_fields[kind], f"mock kind={kind}")
    for key in ("request", "updates", "artifacts"):
        if key in value:
            typed(value[key], dict, f"mock.{key}")
    if "repeat_last" in value:
        typed(value["repeat_last"], bool, "mock.repeat_last")
    if "delay_seconds" in value:
        number(value["delay_seconds"], "mock.delay_seconds")
    if kind == "sequence" and not isinstance(value.get("values"), Deferred):
        if not isinstance(value.get("values"), list) or not value["values"]:
            raise ConfigurationError("sequence mock values must be a non-empty list")
    if kind == "exception" and not isinstance(value.get("exception"), Deferred):
        if value.get("exception", "RuntimeError") not in ("RuntimeError", "ValueError", "ConnectionError"):
            raise ConfigurationError("unsupported mock exception type")
    if "preset" in value:
        text(value["preset"], "mock.preset")


SNAPSHOT_FIELDS = {
    "kind", "name", "select", "artifact", "ignore_paths", "ignore_keys",
    "ignore_key_suffixes", "ignore_key_exclusions", "null_strings", "ignore_empty",
    "unordered_lists", "normalizers", "replacements",
}


def snapshot_settings(value: Any, *, spec: bool = False) -> None:
    if spec and (value is None or value is False or value == "" or isinstance(value, str)):
        return
    fields(value, SNAPSHOT_FIELDS | ({"rule"} if spec else set()), "snapshot")
    if isinstance(value, Deferred):
        return
    kind = value.get("kind", "response")
    if not isinstance(kind, Deferred) and kind not in ("response", "database", "screenshot"):
        raise ConfigurationError("unsupported snapshot kind")
    for key in ("rule", "name", "select", "artifact"):
        if key in value:
            text(value[key], f"snapshot.{key}")
    name = value.get("name")
    if isinstance(name, str) and (
        name in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", name)
    ):
        raise ConfigurationError("unsafe snapshot name")
    for key in ("null_strings", "ignore_empty"):
        if key in value:
            typed(value[key], bool, f"snapshot.{key}")
    for key in ("ignore_paths", "ignore_keys", "ignore_key_suffixes", "ignore_key_exclusions"):
        if key in value and not isinstance(value[key], Deferred):
            typed(value[key], list, f"snapshot.{key}")
            for item in value[key]:
                text(item, f"snapshot.{key}")
    for key, allowed in (
        ("normalizers", {"path", "type", "utc_offset_hours"}),
        ("unordered_lists", {"path", "keys"}),
    ):
        rules = value.get(key, [])
        if isinstance(rules, Deferred):
            continue
        typed(rules, list, f"snapshot.{key}")
        for rule in rules:
            fields(rule, allowed, f"snapshot.{key}")
            if isinstance(rule, Deferred):
                continue
            path = rule.get("path")
            if not isinstance(path, Deferred):
                text(path, f"snapshot.{key}.path")
            if key == "normalizers":
                normalizer = rule.get("type")
                if not isinstance(normalizer, Deferred) and normalizer not in ("decimal", "date", "datetime"):
                    raise ConfigurationError("unsupported snapshot normalizer")
                offset = rule.get("utc_offset_hours")
                if offset is not None and not isinstance(offset, Deferred):
                    number(offset, "snapshot.utc_offset_hours", minimum=-23.999)
                    if offset >= 24:
                        raise ConfigurationError("snapshot.utc_offset_hours must be < 24")
            elif "keys" in rule and not isinstance(rule["keys"], Deferred):
                keys = rule["keys"]
                typed(keys, (str, list), "snapshot.unordered_lists.keys")
                for item in keys if isinstance(keys, list) else [keys]:
                    text(item, "snapshot.unordered_lists.keys")
    replacements = value.get("replacements", {})
    typed(replacements, dict, "snapshot.replacements")
    if isinstance(replacements, dict):
        for pattern, replacement in replacements.items():
            if not isinstance(replacement, Deferred):
                try:
                    re.compile(pattern).sub(str(replacement), "")
                except (re.error, IndexError) as exc:
                    raise ConfigurationError("invalid snapshot replacement expression") from exc
