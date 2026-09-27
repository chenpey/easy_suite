from __future__ import annotations

import base64
from collections.abc import Mapping, Sequence
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any


def to_jsonable(value: Any) -> Any:
    """Convert common transport/database values into deterministic JSON data."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return {
                "$binary": base64.b64encode(value).decode("ascii"),
                "encoding": "base64",
            }
    if isinstance(value, memoryview):
        return to_jsonable(value.tobytes())
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return to_jsonable(value.value)
    if is_dataclass(value) and not isinstance(value, type):
        return to_jsonable(asdict(value))
    if isinstance(value, Mapping):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, Sequence):
        return [to_jsonable(item) for item in value]
    return str(value)
