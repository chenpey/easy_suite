from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import requests

from easytest.config import resolve_env
from easytest.executors.base import Executor
from easytest.models import ConfigurationError, ExecutionResult, RunContext
from easytest.transport.http import DEFAULT_MAX_RESPONSE_BYTES, HttpClient, response_limit
from easytest.validation import http_settings

def request_settings(
    operation: dict[str, Any], request: dict[str, Any],
    environment: Mapping[str, str | None] | None = None,
) -> dict[str, Any]:
    """Resolve only inherited configuration; request values are already rendered."""
    settings = {}
    for key, value in operation.items():
        if key not in request:
            settings[key] = resolve_env(value, environment)
        elif isinstance(value, dict) and isinstance(request[key], dict):
            settings[key] = request_settings(value, request[key], environment)
    return {**request, **settings}


class HttpExecutor(Executor):
    name = "http"

    def __init__(
        self,
        session: requests.Session | None = None,
        *,
        client: HttpClient | None = None,
    ) -> None:
        if session is not None and client is not None:
            raise ConfigurationError("pass either HTTP client or session, not both")
        self.client = client if client is not None else HttpClient(session)
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def reset_context(self, _context: RunContext | None = None) -> None:
        """Clear row-local browser state while retaining pooled connections."""
        self.client.session.cookies.clear()

    def execute(
        self,
        operation_name: str,
        operation: dict[str, Any],
        request: dict[str, Any],
        context: RunContext,
    ) -> ExecutionResult:
        http_settings(request)
        ceiling = response_limit(operation.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES))
        if "max_response_bytes" in request and response_limit(request["max_response_bytes"]) > ceiling:
            raise ConfigurationError(
                "HTTP request max_response_bytes exceeds operation limit",
                code="INVALID_VALUE", field="max_response_bytes",
            )
        settings = request_settings(operation, request, context.environment)
        http_settings(settings, operation=True, required=True)
        method = str(settings.get("method", "GET"))
        url = str(settings["url"])
        if "trust_env" in settings:
            self.client.configure_trust_env(
                settings["trust_env"], borrowed=not self._owns_client
            )
        options = {
            key: settings[key]
            for key in ("verify", "cookies", "files", "allow_redirects", "cert", "stream")
            if key in settings
        }

        output = self.client.request(
            method,
            url,
            path=settings.get("path"),
            headers=settings.get("headers"),
            query=settings.get("params"),
            data=settings.get("data"),
            json_body=settings.get("json"),
            retry=settings.get("retry"),
            expected_status=settings.get("expected_status"),
            raise_for_status=bool(settings.get("raise_for_status", False)),
            timeout=(
                tuple(settings["timeout"]) if isinstance(settings.get("timeout"), list)
                else settings.get("timeout", 10)
            ),
            max_response_bytes=settings.get("max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES),
            **options,
        )
        return ExecutionResult(
            executor=self.name,
            operation=operation_name,
            output=output,
        )
