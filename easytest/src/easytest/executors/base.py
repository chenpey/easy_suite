from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from easytest.models import ExecutionResult, RunContext


class Executor(ABC):
    name: str

    def close(self) -> None:
        return None

    @abstractmethod
    def execute(
        self,
        operation_name: str,
        operation: dict[str, Any],
        request: dict[str, Any],
        context: RunContext,
    ) -> ExecutionResult:
        raise NotImplementedError


def normalize_handler_result(
    *,
    executor: str,
    operation: str,
    value: Any,
) -> ExecutionResult:
    """Only ExecutionResult denotes framework metadata; dictionaries are data."""
    if isinstance(value, ExecutionResult):
        return value
    return ExecutionResult(executor=executor, operation=operation, output=value)
