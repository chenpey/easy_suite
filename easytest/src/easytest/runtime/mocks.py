from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from easytest.config import ProjectConfig
from easytest.models import ConfigurationError, ExecutionResult, RunContext
from easytest.runtime.values import merge_nested
from easytest.validation import mock_settings


@dataclass(frozen=True)
class MockDecision:
    request: dict[str, Any]
    result: ExecutionResult | None


class MockEngine:
    def __init__(self, config: ProjectConfig) -> None:
        self.config = config

    def resolve(
        self,
        *,
        step_mock: Any,
        profile_name: str | None,
        operation_name: str,
    ) -> dict[str, Any] | None:
        selected = step_mock
        if selected in (None, ""):
            selected = self.config.mock_profile(profile_name).get(operation_name)
        if selected in (None, "", False):
            return None
        if isinstance(selected, str):
            return self.config.mock_preset(selected)
        if not isinstance(selected, dict):
            raise ConfigurationError("mock must be a preset name, object, or empty")
        if "preset" in selected:
            base = self.config.mock_preset(str(selected["preset"]))
            return merge_nested(
                base,
                {key: value for key, value in selected.items() if key != "preset"},
                isolate=True,
            )
        return dict(selected)

    def apply(
        self,
        *,
        spec: dict[str, Any] | None,
        request: dict[str, Any],
        context: RunContext,
        executor: str,
        operation: str,
        invocation_key: str,
    ) -> MockDecision:
        if spec is None:
            return MockDecision(request=request, result=None)
        mock_settings(spec)

        kind = str(spec.get("kind", "response")).lower()
        if kind == "inject":
            injected = spec.get("request", {})
            if not isinstance(injected, dict):
                raise ConfigurationError("inject mock request must be an object")
            return MockDecision(
                request=merge_nested(request, injected, isolate=True),
                result=None,
            )
        if kind == "timeout":
            delay = min(max(float(spec.get("delay_seconds", 0)), 0), 1)
            if delay:
                time.sleep(delay)
            raise TimeoutError(str(spec.get("message", f"mock timeout: {operation}")))
        if kind == "exception":
            exceptions = {
                "RuntimeError": RuntimeError,
                "ValueError": ValueError,
                "ConnectionError": ConnectionError,
            }
            exception_name = str(spec.get("exception", "RuntimeError"))
            try:
                exception_type = exceptions[exception_name]
            except KeyError as exc:
                raise ConfigurationError(
                    f"unsupported mock exception type: {exception_name}"
                ) from exc
            raise exception_type(
                str(spec.get("message", f"mock exception: {operation}"))
            )
        if kind == "state":
            updates = spec.get("updates", {})
            if not isinstance(updates, dict):
                raise ConfigurationError("state mock updates must be an object")
            context.state.update(copy.deepcopy(updates))
            output = copy.deepcopy(spec.get("response", updates))
        elif kind == "sequence":
            values = spec.get("values")
            if not isinstance(values, list) or not values:
                raise ConfigurationError(
                    "sequence mock values must be a non-empty list"
                )
            counters = context.state.setdefault("_mock_sequence", {})
            index = int(counters.get(invocation_key, 0))
            counters[invocation_key] = index + 1
            if index >= len(values):
                if not spec.get("repeat_last", True):
                    raise ConfigurationError(
                        f"mock sequence exhausted: {invocation_key}"
                    )
                index = len(values) - 1
            output = copy.deepcopy(values[index])
        elif kind == "service_rejected":
            output = copy.deepcopy(
                spec.get(
                    "response",
                    {
                        "code": "SERVICE_REJECTED",
                        "message": "request rejected by mock service",
                    },
                )
            )
        elif kind == "response":
            output = copy.deepcopy(spec.get("response"))
        else:
            raise ConfigurationError(f"unsupported mock kind: {kind}")

        raw_artifacts = spec.get("artifacts", {})
        if not isinstance(raw_artifacts, dict):
            raise ConfigurationError("mock artifacts must be an object")
        artifacts = {}
        for name, path_value in raw_artifacts.items():
            path = Path(str(path_value))
            artifacts[str(name)] = path if path.is_absolute() else context.root / path
        return MockDecision(
            request=request,
            result=ExecutionResult(
                executor=executor,
                operation=operation,
                output=output,
                artifacts=artifacts,
                mocked=True,
            ),
        )
