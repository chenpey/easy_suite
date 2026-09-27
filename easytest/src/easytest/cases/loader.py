from __future__ import annotations

import hashlib
import json
from pathlib import Path

from easytest._version import __version__
from easytest.cases.compiler import compile_workbook, workbook_document
from easytest.cases.schema import parse_document
from easytest.models import Case, ContractError


def _document_origin(document: object, source: Path) -> Path:
    if not isinstance(document, dict):
        return source
    mode = document.get("source_mode")
    if mode == "json":
        forbidden = {"source", "source_sha256", "compiler_version"} & document.keys()
        if forbidden:
            raise ContractError(
                f"JSON-only source cannot define generated metadata: {sorted(forbidden)}",
                code="INVALID_SOURCE_METADATA", field="source_mode",
            )
        return source
    if mode != "xlsx":
        if mode is None and "source" in document:
            message = (
                f"legacy compiled JSON lacks source metadata: {source}; "
                "recompile its XLSX source"
            )
            code = "COMPILED_JSON_OUT_OF_DATE"
        else:
            message = (
                f"JSON-only cases must explicitly set source_mode to 'json': {source}"
            )
            code = "JSON_SOURCE_MODE_REQUIRED"
        raise ContractError(message, code=code, field="source_mode")

    name = document.get("source")
    if (
        not isinstance(name, str) or Path(name).name != name
        or Path(name).suffix.lower() != ".xlsx"
        or name != source.with_suffix(".xlsx").name
    ):
        raise ContractError(
            "XLSX-generated JSON must name its sibling .xlsx source",
            code="INVALID_SOURCE_METADATA", field="source",
        )
    origin = source.parent / name
    if not origin.is_file():
        raise ContractError(
            f"orphan compiled JSON: {source}; source workbook is missing: {origin}. "
            "Remove/rename its JSON with the workbook.",
            code="ORPHAN_COMPILED_JSON", field="source",
        )
    expected_hash = document.get("source_sha256")
    if (
        not isinstance(expected_hash, str) or len(expected_hash) != 64
        or any(character not in "0123456789abcdef" for character in expected_hash)
    ):
        raise ContractError(
            f"compiled JSON has invalid source hash: {source}; recompile {origin}",
            code="COMPILED_JSON_OUT_OF_DATE", field="source_sha256",
        )
    actual_hash = hashlib.sha256(origin.read_bytes()).hexdigest()
    if actual_hash != expected_hash or document.get("compiler_version") != __version__:
        raise ContractError(
            f"compiled JSON is out of date: {source}; recompile {origin}",
            code="COMPILED_JSON_OUT_OF_DATE", field="source",
        )
    return origin


def load_cases(path: str | Path) -> list[Case]:
    source = Path(path).resolve()
    if source.suffix.lower() != ".json":
        raise ContractError(
            f"runtime only accepts compiled .json files, not {source.suffix or 'directories'}"
        )
    try:
        document = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ContractError(f"compiled case file does not exist: {source}") from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"invalid compiled JSON {source}: {exc}") from exc
    origin = _document_origin(document, source)
    return parse_document(document, source=str(origin))


def discover_cases(paths: list[str | Path]) -> list[Case]:
    cases: list[Case] = []
    seen_ids: dict[str, str] = {}
    for path in paths:
        for case in load_cases(path):
            if case.id in seen_ids:
                raise ContractError(
                    f"duplicate case id {case.id!r}: {seen_ids[case.id]} and {case.source}"
                )
            seen_ids[case.id] = case.source
            if case.enabled:
                cases.append(case)
    return cases


def load_project_cases(
    paths: str | Path | list[str | Path] = "cases", *, root: str | Path = ".",
    write_compiled: bool = True, case_ids: list[str] | None = None,
) -> list[Case]:
    """Load sources, optionally compiling XLSX only in memory for read-only checks."""
    inputs = [paths] if isinstance(paths, (str, Path)) else paths
    files: dict[Path, Path] = {}
    for value in inputs:
        source = Path(value)
        if not source.is_absolute():
            source = Path(root) / source
        source = source.resolve()
        if not source.exists():
            raise ContractError(f"case source does not exist: {source}")
        candidates = sorted(source.rglob("*")) if source.is_dir() else [source]
        found = False
        for candidate in candidates:
            if not candidate.is_file() or candidate.name.startswith("~$"):
                continue
            suffix = candidate.suffix.lower()
            if suffix == ".xlsx":
                files[candidate.with_suffix(".json")] = candidate
                found = True
            elif suffix == ".json":
                files.setdefault(candidate, candidate)
                found = True
        if not found:
            raise ContractError(f"no XLSX or JSON case files found: {source}")
    cases = []
    seen_ids = {}
    for _, source in sorted(files.items()):
        if source.suffix.lower() == ".xlsx":
            loaded = (
                load_cases(compile_workbook(source)) if write_compiled
                else parse_document(workbook_document(source), source=str(source))
            )
        else:
            loaded = load_cases(source)
        for case in loaded:
            if case.id in seen_ids:
                raise ContractError(
                    f"duplicate case id {case.id!r}: {seen_ids[case.id]} and {case.source}"
                )
            seen_ids[case.id] = case.source
            if case.enabled:
                cases.append(case)
    if not cases:
        raise ContractError(
            "no enabled cases found; check case sources and enabled fields",
            code="EMPTY_SELECTION", field="enabled",
        )
    if case_ids is None:
        return cases
    if not case_ids or any(not isinstance(item, str) or not item.strip() for item in case_ids):
        raise ContractError("case ID selection cannot be empty", code="EMPTY_SELECTION", field="case_id")
    wanted = set(case_ids)
    unknown = wanted - {case.id for case in cases}
    if unknown:
        raise ContractError(
            f"unknown or disabled case IDs: {sorted(unknown)}",
            code="UNKNOWN_CASE_ID", field="case_id",
        )
    # Repeated flags do not execute a case twice; preserve source order.
    return [case for case in cases if case.id in wanted]
