from __future__ import annotations

import re
from typing import Any

from easytest.models import Case, ConfigurationError, ContractError, Step
from easytest.runtime.assertions import validate_expectations
from easytest.validation import mock_settings, snapshot_settings, template_shape

SCHEMA_VERSION = 1
CASE_TYPES = {"scenario", "http", "rpc"}
EXECUTORS = {"scenario", "http", "rpc", "database", "ui"}
_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


def _fields(value: dict, allowed: set[str], field: str) -> None:
    unknown = value.keys() - allowed
    if unknown:
        raise ContractError(
            f"unknown fields in {field}: {sorted(unknown)}",
            code="UNKNOWN_FIELD", field=f"{field}.{sorted(unknown)[0]}",
        )


def _mapping(value: Any, field: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ContractError(f"{field} must be a JSON object", code="INVALID_TYPE", field=field)
    return value


def _optional_text(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ContractError("text fields must be strings")
    return value.strip()


def _identifier(value: Any, field: str) -> str:
    text = _optional_text(value)
    if not text or text in {".", ".."} or not _ID_PATTERN.fullmatch(text):
        raise ContractError(
            f"{field} must match {_ID_PATTERN.pattern}; got {value!r}",
            code="INVALID_IDENTIFIER", field=field,
        )
    return text


def _tags(value: Any) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if isinstance(value, str):
        value = [item.strip() for item in value.split(",") if item.strip()]
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractError("tags must be a comma-separated string or JSON string list")
    return tuple(dict.fromkeys(item.strip() for item in value if item.strip()))


def parse_document(document: dict[str, Any], source: str = "") -> list[Case]:
    if not isinstance(document, dict):
        raise ContractError("compiled case document must be a JSON object")
    _fields(document, {
        "schema_version", "source_mode", "source", "source_sha256",
        "compiler_version", "cases",
    }, "document")
    if type(document.get("schema_version")) is not int or document["schema_version"] != SCHEMA_VERSION:
        raise ContractError(
            f"schema_version must be {SCHEMA_VERSION}; got {document.get('schema_version')!r}"
        )

    rows = document.get("cases")
    if not isinstance(rows, list) or not rows:
        raise ContractError(
            "compiled case document must contain a non-empty cases list"
        )

    cases = []
    for index, row in enumerate(rows):
        origin = source or str(document.get("source", ""))
        try:
            cases.append(_parse_case(row, origin))
        except ContractError as error:
            location = {"source": origin, "case_id": row.get("id") if isinstance(row, dict) else None}
            error.easytest_location = {**location, **getattr(error, "easytest_location", {})}
            if error.field == "cases":
                error.field = f"cases[{index}]"
            raise
    ids = [case.id for case in cases]
    if len(ids) != len(set(ids)):
        raise ContractError("case ids must be unique within one compiled document")
    return cases


def _parse_case(row: Any, source: str) -> Case:
    row = _mapping(row, "case")
    _fields(row, {
        "id", "name", "type", "enabled", "tags", "variables", "mock_profile",
        "snapshot_profile", "steps",
    }, "case")
    case_id = _identifier(row.get("id"), "case.id")
    case_type = str(row.get("type", "")).strip().lower()
    if case_type not in CASE_TYPES:
        raise ContractError(f"case {case_id}: type must be one of {sorted(CASE_TYPES)}")

    raw_steps = row.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ContractError(f"case {case_id}: steps must be a non-empty list")
    parsed_steps = []
    for index, item in enumerate(raw_steps):
        try:
            parsed_steps.append(_parse_step(item, case_id))
        except ContractError as error:
            row_number = item.get("source_row") if isinstance(item, dict) else None
            error.easytest_location = {
                "source": source, "case_id": case_id, "source_row": row_number,
                "step_id": item.get("id") if isinstance(item, dict) else None,
                "operation": item.get("operation") if isinstance(item, dict) else None,
            }
            if error.field == "cases":
                error.field = f"steps[{index}]"
            error.add_note(f"Source={source}, sheet=steps, row={row_number or 'unknown'}")
            raise
    steps = tuple(sorted(parsed_steps, key=lambda step: step.order))
    step_ids = [step.id for step in steps]
    orders = [step.order for step in steps]
    if len(step_ids) != len(set(step_ids)):
        raise ContractError(f"case {case_id}: step ids must be unique")
    if len(orders) != len(set(orders)):
        raise ContractError(f"case {case_id}: step order values must be unique")
    output_keys = [step.save_as or step.id for step in steps]
    if len(output_keys) != len(set(output_keys)):
        raise ContractError(f"case {case_id}: step output names (save_as or id) must be unique")

    enabled = row.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ContractError(f"case {case_id}: enabled must be a boolean")

    return Case(
        id=case_id,
        name=_optional_text(row.get("name")) or case_id,
        case_type=case_type,
        enabled=enabled,
        tags=_tags(row.get("tags")),
        variables=_mapping(row.get("variables"), f"case {case_id}.variables"),
        mock_profile=_optional_text(row.get("mock_profile")),
        snapshot_profile=_optional_text(row.get("snapshot_profile")) or "default",
        steps=steps,
        source=source,
    )


def _parse_step(row: Any, case_id: str) -> Step:
    row = _mapping(row, f"case {case_id}.step")
    _fields(row, {
        "id", "order", "executor", "operation", "request", "save_as",
        "mock", "snapshot", "expect", "source_row",
    }, f"case {case_id}.step")
    step_id = _identifier(row.get("id"), f"case {case_id}.step.id")
    order = row.get("order")
    if type(order) is not int:
        raise ContractError(
            f"case {case_id}, step {step_id}: order must be an integer"
        )
    if order < 1:
        raise ContractError(f"case {case_id}, step {step_id}: order must be positive")

    executor = str(row.get("executor", "")).strip().lower()
    if executor not in EXECUTORS:
        raise ContractError(
            f"case {case_id}, step {step_id}: executor must be one of {sorted(EXECUTORS)}"
        )
    operation = _identifier(
        row.get("operation"), f"case {case_id}, step {step_id}.operation"
    )
    source_row = row.get("source_row")
    if source_row is not None and (type(source_row) is not int or source_row < 2):
        raise ContractError(f"case {case_id}, step {step_id}: source_row must be an integer >= 2")
    validate_expectations(row.get("expect"))
    try:
        mock_settings(template_shape(row.get("mock")))
        snapshot_settings(template_shape(row.get("snapshot")), spec=True)
    except ConfigurationError as exc:
        raise ContractError(str(exc), code=exc.code, field=exc.field) from exc

    return Step(
        id=step_id,
        order=order,
        executor=executor,
        operation=operation,
        request=_mapping(row.get("request"), f"case {case_id}, step {step_id}.request"),
        save_as=_optional_text(row.get("save_as")),
        mock=row.get("mock"),
        snapshot=row.get("snapshot"),
        expect=row.get("expect"),
        source_row=source_row,
    )
