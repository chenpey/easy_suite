from __future__ import annotations

import copy
import re
from typing import Any

from easytest.models import ContractError
from easytest.validation import DEFERRED, Deferred

_PLACEHOLDER = re.compile(r"\$\{([^{}]+)}")
_PATH_PART = re.compile(r"([^.[]+)|\[(\d+)]")


def merge_nested(
    base: dict[str, Any],
    override: dict[str, Any],
    *,
    isolate: bool = False,
) -> dict[str, Any]:
    merged = copy.deepcopy(base) if isolate else dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_nested(merged[key], value, isolate=isolate)
        else:
            merged[key] = copy.deepcopy(value) if isolate else value
    return merged


def path_parts(path: str) -> list[str | int]:
    if not isinstance(path, str):
        raise ContractError("path must be a string")
    normalized = path.strip()
    if normalized in {"", "$"}:
        return []
    if normalized.startswith("$."):
        normalized = normalized[2:]
    elif normalized.startswith("$"):
        normalized = normalized[1:]
    if not re.fullmatch(r"(?:[^.\[\]{}$]+|\[\d+])(?:\.[^.\[\]{}$]+|\[\d+])*", normalized):
        raise ContractError(f"invalid path syntax: {path!r}")
    return [
        int(match.group(2)) if match.group(2) is not None else match.group(1)
        for match in _PATH_PART.finditer(normalized)
    ]


def state_write_parts(path: str) -> list[str]:
    parts = path_parts(path)
    if not parts:
        raise ContractError("scenario set path must select a field")
    if any(isinstance(part, int) for part in parts):
        raise ContractError("scenario set path does not support array indexes")
    return parts


def resolve_path(value: Any, path: str) -> Any:
    current = value
    for key in path_parts(path):
        if isinstance(current, Deferred):
            return DEFERRED
        try:
            current = current[key]
        except (KeyError, IndexError, TypeError) as exc:
            raise ContractError(
                f"path {path!r} does not exist near {key!r}"
            ) from exc
    return current


def render_templates(value: Any, scope: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: render_templates(item, scope) for key, item in value.items()}
    if isinstance(value, list):
        return [render_templates(item, scope) for item in value]
    if not isinstance(value, str):
        return value
    if "${" in _PLACEHOLDER.sub("", value):
        raise ContractError("invalid template placeholder syntax")

    whole = _PLACEHOLDER.fullmatch(value)
    if whole:
        return copy.deepcopy(resolve_path(scope, whole.group(1)))

    matches = list(_PLACEHOLDER.finditer(value))
    resolved_values = [resolve_path(scope, match.group(1)) for match in matches]
    # Inspect every reference, even if another reference is dynamic.
    if any(isinstance(item, Deferred) for item in resolved_values):
        return DEFERRED

    def replace(match: re.Match[str]) -> str:
        resolved = resolve_path(scope, match.group(1))
        if isinstance(resolved, (dict, list)):
            raise ContractError(
                f"placeholder {match.group(0)!r} resolves to structured data "
                "and must occupy the whole cell"
            )
        return "" if resolved is None else str(resolved)

    return _PLACEHOLDER.sub(replace, value)
