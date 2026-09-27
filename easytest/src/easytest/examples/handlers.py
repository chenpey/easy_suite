from __future__ import annotations

from typing import Any

from easytest.models import RunContext


def rpc_calculate_limit(
    *,
    request: dict[str, Any],
    endpoint: str,
    auth: dict[str, Any],
    context: RunContext,
) -> dict[str, Any]:
    """Example adapter shape; replace its body with the project's RPC client."""
    raise NotImplementedError(
        "configure the real RPC client or select a mock profile; "
        f"operation endpoint={endpoint!r}"
    )


def open_dashboard(
    *,
    request: dict[str, Any],
    context: RunContext,
) -> dict[str, Any]:
    """Example adapter shape; a real implementation should return screenshot artifacts."""
    raise NotImplementedError(
        "configure the packaged UI client or select a mock profile"
    )
