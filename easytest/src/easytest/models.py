from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from easytest.runtime.identifiers import generated_values, unique_id

JSON = dict[str, Any] | list[Any] | str | int | float | bool | None


class TableTestError(RuntimeError):
    """Base error for actionable framework failures."""

    code = "FRAMEWORK_ERROR"
    field = ""

    def __init__(self, message: str, *, code: str | None = None, field: str | None = None) -> None:
        super().__init__(message)
        self.code = code or type(self).code
        self.field = field or type(self).field


class ContractError(TableTestError):
    """Raised when XLSX or JSON does not match the case contract."""

    code = "INVALID_CONTRACT"
    field = "cases"


class ConfigurationError(TableTestError):
    """Raised when runtime configuration is incomplete or unsafe."""

    code = "INVALID_CONFIGURATION"
    field = "config"


class MockMissError(ConfigurationError):
    """Raised when a strict profile would enter a real executor."""

    code = "MOCK_MISS"
    field = "mock"


class CleanupError(TableTestError):
    """Raised when owned resources fail to close after a successful run."""

    code = "CLEANUP_FAILED"

    def __init__(self, errors: list[BaseException]) -> None:
        self.errors = tuple(errors)
        super().__init__(
            "resource cleanup failed: " + ", ".join(type(error).__name__ for error in errors)
        )


@dataclass(frozen=True)
class Step:
    id: str
    order: int
    executor: str
    operation: str
    request: dict[str, Any] = field(default_factory=dict)
    save_as: str | None = None
    mock: JSON = None
    snapshot: JSON = None
    expect: JSON = None
    source_row: int | None = None


@dataclass(frozen=True)
class DataRow:
    data_set: str
    id: str
    values: dict[str, Any]
    enabled: bool = True
    source_row: int | None = None


@dataclass(frozen=True)
class Case:
    id: str
    name: str = ""
    case_type: str = "scenario"
    enabled: bool = True
    tags: tuple[str, ...] = ()
    variables: dict[str, Any] = field(default_factory=dict)
    mock_profile: str | None = None
    snapshot_profile: str = "default"
    steps: tuple[Step, ...] = ()
    source: str = ""
    data_set: str | None = None
    data_id: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    data_source_row: int | None = None

    def __post_init__(self) -> None:
        if not self.name:
            object.__setattr__(self, "name", self.id)

    @property
    def execution_id(self) -> str:
        """Return the storage/test identity for one data-row execution."""
        return f"{self.id}.{self.data_id}" if self.data_id is not None else self.id


@dataclass
class ExecutionResult:
    executor: str
    operation: str
    output: Any
    artifacts: dict[str, Path] = field(default_factory=dict)
    mocked: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RunContext:
    case: Case
    root: Path
    run_mode: str
    variables: dict[str, Any]
    run_id: str = field(default_factory=lambda: unique_id("run_", random_length=8))
    generated: dict[str, Any] = field(default_factory=generated_values)
    step_outputs: dict[str, Any] = field(default_factory=dict)
    state: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    allow_db_write: bool = False
    environment: Mapping[str, str | None] | None = field(default=None, repr=False)

    def template_scope(self) -> dict[str, Any]:
        return {
            "variables": self.variables,
            "data": self.case.data,
            "generate": self.generated,
            "steps": self.step_outputs,
            "state": self.state,
        }
