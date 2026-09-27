from __future__ import annotations

from typing import Any

from easytest.models import ContractError
from easytest.runtime.values import path_parts, resolve_path
from easytest.snapshots.comparison import json_equal
from easytest.validation import Deferred, template_shape


class ExpectationError(AssertionError):
    """An assertion failure whose values can be safely rendered by path."""

    def __init__(
        self, path: str, operator: str, expected: Any, actual: Any, *,
        reason: str = "mismatch",
    ) -> None:
        self.path = path
        self.operator = operator
        self.expected = expected
        self.actual = actual
        self.reason = reason
        super().__init__(f"expectation failed at {path}: {operator} ({reason})")


def _contains(container: Any, value: Any) -> bool:
    if isinstance(container, (list, dict)):
        return any(json_equal(item, value) for item in container)
    if isinstance(container, str) and isinstance(value, str):
        return value in container
    return False


def expectation_checks(expectation: Any) -> list[dict[str, Any]]:
    if expectation in (None, ""):
        return []
    if isinstance(expectation, Deferred):
        return []
    if not isinstance(expectation, dict):
        raise ContractError("expect must be a JSON object")

    if "checks" in expectation:
        if expectation.keys() != {"checks"}:
            raise ContractError("expect.checks cannot be combined with other fields")
        checks = expectation["checks"]
    else:
        if "path" in expectation:
            checks = [expectation]
        else:
            checks = [
                {"path": path, "equals": value} for path, value in expectation.items()
            ]
    if isinstance(checks, Deferred):
        return []
    if not isinstance(checks, list):
        raise ContractError("expect.checks must be a list")
    if not checks:
        raise ContractError("expect must contain at least one comparison")

    for check in checks:
        if isinstance(check, Deferred):
            continue
        if not isinstance(check, dict) or "path" not in check:
            raise ContractError("each expectation check must contain path")
        unknown = check.keys() - {"path", "equals", "contains", "in"}
        if unknown:
            raise ContractError(
                f"unknown expectation fields: {sorted(unknown)}",
                code="UNKNOWN_FIELD", field=f"expect.{sorted(unknown)[0]}",
            )
        if not check.keys() & {"equals", "contains", "in"}:
            raise ContractError("each expectation check requires equals, contains, or in")
        if not isinstance(check["path"], Deferred):
            if not isinstance(check["path"], str) or not check["path"].strip():
                raise ContractError("expectation path must be a non-empty string")
            path_parts(check["path"])
        if "in" in check and not isinstance(check["in"], (list, dict, str, Deferred)):
            raise ContractError("expectation 'in' requires a list, object, or string")
    return checks


def validate_expectations(expectation: Any) -> None:
    try:
        expectation_checks(template_shape(expectation))
    except ContractError as exc:
        if exc.field == "cases":
            exc.field = "expect"
        raise


def assert_expectations(output: Any, expectation: Any) -> None:
    for check in expectation_checks(expectation):
        path = check["path"]
        for operator in ("equals", "contains", "in"):
            if operator not in check:
                continue
            expected = check[operator]
            try:
                actual = resolve_path(output, path)
            except ContractError as exc:
                raise ExpectationError(
                    path, operator, expected, None, reason="missing_path",
                ) from exc
            matched = (
                json_equal(expected, actual) if operator == "equals"
                else _contains(actual, expected) if operator == "contains"
                else _contains(expected, actual)
            )
            if not matched:
                raise ExpectationError(path, operator, expected, actual)
