from __future__ import annotations

import secrets
import string
import time
import uuid
from collections.abc import Callable
from typing import Any


def timestamp_seconds() -> int:
    return time.time_ns() // 1_000_000_000


def timestamp_ms() -> int:
    return time.time_ns() // 1_000_000


def unique_id(prefix: str = "", *, random_length: int = 12) -> str:
    if random_length < 1:
        raise ValueError("random_length must be positive")
    alphabet = string.ascii_letters + string.digits
    suffix = "".join(secrets.choice(alphabet) for _ in range(random_length))
    return f"{prefix}{timestamp_ms()}{suffix}"


def generated_values(
    generators: dict[str, Callable[[], Any]] | None = None,
) -> dict[str, Any]:
    values: dict[str, Callable[[], Any]] = {
        "uuid": lambda: uuid.uuid4().hex,
        "timestamp": timestamp_seconds,
        "timestamp_ms": timestamp_ms,
        "request_id": lambda: unique_id("req_"),
        "order_id": lambda: unique_id("ord_"),
    }
    values.update(generators or {})
    return {name: generator() for name, generator in values.items()}
