from __future__ import annotations

from collections.abc import Callable
from typing import Any

from easytest.config import load_handler, resolve_env
from easytest.executors.base import Executor, normalize_handler_result
from easytest.models import ConfigurationError, ExecutionResult, RunContext


class RpcExecutor(Executor):
    name = "rpc"

    def __init__(self, handlers: dict[str, Callable[..., Any]] | None = None) -> None:
        self.handlers = handlers or {}

    def execute(
        self,
        operation_name: str,
        operation: dict[str, Any],
        request: dict[str, Any],
        context: RunContext,
    ) -> ExecutionResult:
        handler = self.handlers.get(operation_name)
        if handler is None and operation.get("handler"):
            handler = load_handler(str(operation["handler"]))
        if handler is None:
            raise ConfigurationError(
                f"RPC operation {operation_name!r} requires a configured or injected handler"
            )
        auth = resolve_env(operation.get("auth", {}), context.environment)
        endpoint = resolve_env(operation.get("endpoint"), context.environment)
        value = handler(
            request=request,
            endpoint=endpoint,
            auth=auth,
            context=context,
        )
        return normalize_handler_result(
            executor=self.name,
            operation=operation_name,
            value=value,
        )
