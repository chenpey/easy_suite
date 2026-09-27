from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from easytest.config import load_handler
from easytest.executors.base import Executor, normalize_handler_result
from easytest.models import ConfigurationError, ExecutionResult, RunContext
from easytest.runtime.values import resolve_path, state_write_parts


def _set_path(target: dict[str, Any], path: str, value: Any) -> None:
    parts = state_write_parts(path)
    current = target
    for part in parts[:-1]:
        child = current.setdefault(part, {})
        if not isinstance(child, dict):
            raise ConfigurationError(f"cannot set nested state below {part!r}")
        current = child
    current[parts[-1]] = value


class ScenarioExecutor(Executor):
    name = "scenario"

    def __init__(self, handlers: dict[str, Callable[..., Any]] | None = None) -> None:
        self.handlers = handlers or {}

    def execute(
        self,
        operation_name: str,
        operation: dict[str, Any],
        request: dict[str, Any],
        context: RunContext,
    ) -> ExecutionResult:
        builtin = str(operation.get("builtin", ""))
        if builtin == "set":
            path = str(request.get("path", operation.get("path", "")))
            value = request.get("value", operation.get("value"))
            _set_path(context.state, path, value)
            output = {"path": path, "value": value}
        elif builtin == "get":
            path = str(request.get("path", operation.get("path", "")))
            output = resolve_path(context.state, path)
        elif builtin == "wait":
            seconds = float(request.get("seconds", operation.get("seconds", 0)))
            if seconds < 0:
                raise ConfigurationError("wait seconds cannot be negative")
            time.sleep(seconds)
            output = {"waited_seconds": seconds}
        else:
            handler = self.handlers.get(operation_name)
            if handler is None and operation.get("handler"):
                handler = load_handler(str(operation["handler"]))
            if handler is None:
                raise ConfigurationError(
                    f"scenario operation {operation_name!r} requires builtin or handler"
                )
            return normalize_handler_result(
                executor=self.name,
                operation=operation_name,
                value=handler(request=request, context=context),
            )

        return ExecutionResult(
            executor=self.name,
            operation=operation_name,
            output=output,
        )
