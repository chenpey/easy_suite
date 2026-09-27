from __future__ import annotations

import fnmatch
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from easytest.models import ConfigurationError
from easytest.serialization import to_jsonable


_MISSING = object()


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    return type(value).__name__


def json_equal(expected: Any, actual: Any) -> bool:
    """Compare JSON types recursively, without snapshot normalization."""
    if json_type(expected) != json_type(actual):
        return False
    if isinstance(expected, dict):
        return expected.keys() == actual.keys() and all(
            json_equal(value, actual[key]) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return len(expected) == len(actual) and all(
            json_equal(left, right) for left, right in zip(expected, actual)
        )
    return expected == actual


@dataclass(frozen=True)
class Difference:
    path: str
    kind: str
    expected: Any
    actual: Any
    category: str = ""

    def __post_init__(self) -> None:
        if self.category:
            return
        if self.kind == "missing_expected":
            category = "added"
        elif self.kind == "missing_actual":
            category = "removed"
        elif json_type(self.expected) != json_type(self.actual):
            category = "type_changed"
        else:
            category = {
                "number": "number_changed",
                "string": "text_changed",
            }.get(json_type(self.expected), "value_changed")
        object.__setattr__(self, "category", category)

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "kind": self.kind,
            "category": self.category,
            "expected": self.expected,
            "actual": self.actual,
            "expected_type": (
                "missing" if self.kind == "missing_expected" else json_type(self.expected)
            ),
            "actual_type": (
                "missing" if self.kind == "missing_actual" else json_type(self.actual)
            ),
        }


@dataclass(frozen=True)
class ComparisonResult:
    expected: Any
    actual: Any
    differences: tuple[Difference, ...]

    @property
    def equal(self) -> bool:
        return not self.differences

    def as_dict(self) -> dict[str, Any]:
        return {
            "equal": self.equal,
            "diff_count": len(self.differences),
            "differences": [item.as_dict() for item in self.differences],
        }


class SnapshotMismatchError(AssertionError):
    """Assertion-compatible snapshot failure with machine-readable differences."""

    def __init__(
        self, message: str, *, target: str, differences: tuple[Difference, ...]
    ) -> None:
        super().__init__(message)
        self.target = target
        self.differences = differences


def _path_text(parts: tuple[str | int, ...], *, wildcard_indexes: bool = False) -> str:
    text = "$"
    for part in parts:
        if isinstance(part, int):
            text += "[*]" if wildcard_indexes else f"[{part}]"
        else:
            text += f".{part}"
    return text


def _matches_path(parts: tuple[str | int, ...], patterns: list[str]) -> bool:
    exact = _path_text(parts)
    exact = re.sub(r"\[(\d+)]", r".__index_\1__", exact)
    return any(
        fnmatch.fnmatchcase(
            exact,
            re.sub(r"\[(\d+|\*)]", r".__index_\1__", pattern),
        )
        for pattern in patterns
    )


def _normalize_decimal(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    try:
        decimal_value = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return value
    if not decimal_value.is_finite():
        return value
    normalized = format(decimal_value.normalize(), "f")
    normalized = normalized.rstrip("0").rstrip(".") if "." in normalized else normalized
    return "0" if normalized in {"", "-0"} else normalized


def _normalize_date(value: Any, utc_offset_hours: float | None = None) -> Any:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        return value.isoformat()
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return value
        try:
            parsed = datetime.fromisoformat(
                text[:-1] + "+00:00" if text.endswith("Z") else text
            )
        except ValueError:
            try:
                return date.fromisoformat(text).isoformat()
            except ValueError:
                return value
    else:
        return value

    if utc_offset_hours is not None:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        parsed = parsed.astimezone(timezone(timedelta(hours=utc_offset_hours)))
    return parsed.isoformat()


def _normalizer_for(
    path: tuple[str | int, ...],
    rules: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for rule in rules:
        patterns = rule.get("paths", [rule.get("path", "")])
        if isinstance(patterns, str):
            patterns = [patterns]
        if _matches_path(path, [str(pattern) for pattern in patterns if pattern]):
            return rule
    return None


def _sort_rule_for(
    path: tuple[str | int, ...],
    rules: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for rule in rules:
        if _matches_path(path, [str(rule.get("path", ""))]):
            return rule
    return None


def _nested_value(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _list_sort_key(item: Any, keys: list[str]) -> tuple[str, ...]:
    if not keys or not isinstance(item, dict):
        return (json.dumps(item, ensure_ascii=False, sort_keys=True, default=str),)
    return tuple(
        json.dumps(
            _nested_value(item, key),
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        for key in keys
    ) + (json.dumps(item, ensure_ascii=False, sort_keys=True, default=str),)


def _normalize_value(
    value: Any,
    rule: dict[str, Any],
    *,
    _path: tuple[str | int, ...] = (),
) -> Any:
    value = to_jsonable(value)
    ignore_paths = [str(path) for path in rule.get("ignore_paths", [])]
    ignore_keys = {str(key).lower() for key in rule.get("ignore_keys", [])}
    ignore_suffixes = tuple(
        str(suffix).lower() for suffix in rule.get("ignore_key_suffixes", [])
    )
    exclusions = {
        str(key).lower() for key in rule.get("ignore_key_exclusions", [])
    }

    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            child_path = (*_path, str(key))
            key_lower = str(key).lower()
            if _matches_path(child_path, ignore_paths):
                continue
            if key_lower in ignore_keys:
                continue
            if (
                ignore_suffixes
                and key_lower.endswith(ignore_suffixes)
                and key_lower not in exclusions
            ):
                continue
            result[str(key)] = _normalize_value(item, rule, _path=child_path)
        return result

    if isinstance(value, list):
        result = [
            _normalize_value(item, rule, _path=(*_path, index))
            for index, item in enumerate(value)
        ]
        sort_rule = _sort_rule_for(_path, list(rule.get("unordered_lists", [])))
        if sort_rule is not None:
            keys = sort_rule.get("keys", [])
            if isinstance(keys, str):
                keys = [keys]
            result.sort(key=lambda item: _list_sort_key(item, list(keys)))
        elif rule.get("sort_lists_by") and all(
            isinstance(item, dict) for item in result
        ):
            key = str(rule["sort_lists_by"])
            result.sort(key=lambda item: _list_sort_key(item, [key]))
        return result

    if (
        rule.get("null_strings", True)
        and isinstance(value, str)
        and value.strip().lower() == "null"
    ):
        return None

    normalizer = _normalizer_for(_path, list(rule.get("normalizers", [])))
    if normalizer is None:
        return value
    normalizer_type = str(normalizer.get("type", "")).lower()
    if normalizer_type == "decimal":
        return _normalize_decimal(value)
    if normalizer_type == "date":
        normalized = _normalize_date(value, normalizer.get("utc_offset_hours"))
        return normalized.split("T", 1)[0] if isinstance(normalized, str) else normalized
    if normalizer_type == "datetime":
        return _normalize_date(value, normalizer.get("utc_offset_hours"))
    raise ConfigurationError(f"unsupported snapshot normalizer: {normalizer_type}")


def normalize(value: Any, rule: dict[str, Any] | None = None) -> Any:
    rule = rule or {}
    normalized = _normalize_value(value, rule)
    replacements = rule.get("replacements", {})
    if replacements:
        if not isinstance(replacements, dict):
            raise ConfigurationError("snapshot replacements must be an object")
        text = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
        for pattern, replacement in replacements.items():
            text = re.sub(str(pattern), str(replacement), text)
        try:
            normalized = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ConfigurationError(
                "snapshot replacement produced invalid JSON"
            ) from exc
    return normalized


def compare(
    expected: Any,
    actual: Any,
    rule: dict[str, Any] | None = None,
) -> ComparisonResult:
    rule = rule or {}
    normalized_expected = normalize(expected, rule)
    normalized_actual = normalize(actual, rule)
    differences: list[Difference] = []
    _diff(
        normalized_expected,
        normalized_actual,
        (),
        differences,
        ignore_empty=bool(rule.get("ignore_empty", False)),
    )
    return ComparisonResult(
        expected=normalized_expected,
        actual=normalized_actual,
        differences=tuple(differences),
    )


def _fingerprint(value: Any, *, ignore_empty: bool = False) -> Any:
    """Hashable JSON identity; preserves duplicates and distinguishes bool/number."""
    if ignore_empty and value in (None, "", [], {}):
        return ("empty",)
    if isinstance(value, dict):
        return ("object", tuple(
            (k, _fingerprint(v, ignore_empty=ignore_empty)) for k, v in sorted(value.items())
        ))
    if isinstance(value, list):
        return ("array", tuple(_fingerprint(item, ignore_empty=ignore_empty) for item in value))
    return (json_type(value), value)


def _diff(
    expected: Any,
    actual: Any,
    path: tuple[str | int, ...],
    differences: list[Difference],
    *,
    ignore_empty: bool,
) -> None:
    if expected is _MISSING or actual is _MISSING:
        differences.append(
            Difference(
                path=_path_text(path),
                kind="missing_expected" if expected is _MISSING else "missing_actual",
                expected=None if expected is _MISSING else expected,
                actual=None if actual is _MISSING else actual,
            )
        )
        return
    if ignore_empty and expected in (None, "", [], {}) and actual in (None, "", [], {}):
        return
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            _diff(
                expected.get(key, _MISSING),
                actual.get(key, _MISSING),
                (*path, key),
                differences,
                ignore_empty=ignore_empty,
            )
        return
    if isinstance(expected, list) and isinstance(actual, list):
        before = [_fingerprint(item, ignore_empty=ignore_empty) for item in expected]
        after = [_fingerprint(item, ignore_empty=ignore_empty) for item in actual]
        if before != after and Counter(before) == Counter(after):
            differences.append(
                Difference(_path_text(path), "changed", expected, actual, "order_changed")
            )
            return
        for index in range(max(len(expected), len(actual))):
            _diff(
                expected[index] if index < len(expected) else _MISSING,
                actual[index] if index < len(actual) else _MISSING,
                (*path, index),
                differences,
                ignore_empty=ignore_empty,
            )
        return
    if json_type(expected) != json_type(actual) or expected != actual:
        differences.append(
            Difference(
                path=_path_text(path),
                kind="changed",
                expected=expected,
                actual=actual,
            )
        )


def format_differences(
    result: ComparisonResult,
    *,
    max_differences: int = 20,
    max_value_length: int = 300,
) -> str:
    lines = [f"snapshot differs at {len(result.differences)} path(s):"]
    for difference in result.differences[:max_differences]:
        expected = _limited_json(difference.expected, max_value_length)
        actual = _limited_json(difference.actual, max_value_length)
        lines.append(
            f"- {difference.path} [{difference.kind}]: "
            f"expected={expected}, actual={actual}"
        )
    omitted = len(result.differences) - max_differences
    if omitted > 0:
        lines.append(f"- ... {omitted} additional difference(s) omitted")
    return "\n".join(lines)


def _limited_json(value: Any, limit: int) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return text if len(text) <= limit else f"{text[:limit]}...<truncated>"
