from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, fields, is_dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from itertools import islice
from pathlib import Path
from typing import Any

from easytest.serialization import to_jsonable


REDACTED = "***REDACTED***"
_SECRET_ASSIGNMENT = re.compile(
    r"\b("
    r"api[_-]?key|authorization|client[_-]?secret|cookie|password|passwd|"
    r"proxy[_-]?authorization|refresh[_-]?token|secret|token|x[_-]?jwt[_-]?token"
    r")\b(\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|bearer\s+[^\s,;&]+|[^\s,;&]+)",
    re.IGNORECASE,
)
DEFAULT_SECRET_KEYS = frozenset(
    {
        "apikey",
        "authorization",
        "clientsecret",
        "cookie",
        "credential",
        "dbpassword",
        "jwt",
        "password",
        "proxyauthorization",
        "refreshtoken",
        "secret",
        "setcookie",
        "token",
        "xjwttoken",
    }
)
DEFAULT_PII_KEYS = frozenset(
    {
        "accountnumber",
        "address",
        "credituid",
        "cuid",
        "deviceid",
        "email",
        "fullname",
        "iban",
        "ipaddress",
        "mobile",
        "openid",
        "phone",
        "userid",
        "walletuid",
        "walletunifieduid",
    }
)


def _normalized_key(key: Any) -> str:
    return "".join(character for character in str(key).lower() if character.isalnum())


def _matches_key(key: Any, candidates: frozenset[str]) -> bool:
    normalized = _normalized_key(key)
    return normalized in candidates or any(
        normalized.endswith(candidate) for candidate in candidates
    )


def _masked_identifier(value: Any) -> str:
    if not isinstance(value, (str, int, float, bool)) or (
        isinstance(value, str) and len(value) > 1000
    ):
        return REDACTED
    digest = hashlib.sha256(str(value).encode()).hexdigest()[:12]
    return f"<redacted:sha256:{digest}>"


def _limited_text(value: Any, limit: int) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    # A prefix may expose an incomplete JSON secret or assignment.
    return f"<truncated-string:{len(text)}>"


def _redact_text(value: str) -> str:
    return _SECRET_ASSIGNMENT.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}",
        value,
    )


def redact(
    value: Any,
    *,
    secret_keys: frozenset[str] = DEFAULT_SECRET_KEYS,
    pii_keys: frozenset[str] = DEFAULT_PII_KEYS,
    max_depth: int = 6,
    max_items: int = 50,
    max_string_length: int = 1000,
    _depth: int = 0,
    _key: Any = None,
) -> Any:
    """Inspect retained values only; never stringify arbitrary objects or large payloads."""
    active: set[int] = set()
    remaining = max(1, max_items) * max(1, max_depth) * 10

    def visit(item: Any, depth: int, key: Any = None) -> Any:
        nonlocal remaining
        if key is not None and _matches_key(key, secret_keys):
            return REDACTED
        if key is not None and _matches_key(key, pii_keys):
            return _masked_identifier(item)
        if remaining <= 0:
            return "<max-nodes>"
        remaining -= 1
        if item is None or isinstance(item, (bool, int, float)):
            return item
        if depth >= max_depth:
            return f"<max-depth:{type(item).__name__}>"
        if isinstance(item, str):
            if len(item) > max_string_length:
                return _limited_text(item, max_string_length)
            stripped = item.strip()
            if stripped.startswith(("{", "[")):
                try:
                    parsed = json.loads(stripped)
                except (ValueError, RecursionError):
                    return "<unparsed-json>"
                return visit(parsed, depth + 1)
            return _limited_text(_redact_text(item), max_string_length)
        if id(item) in active:
            raise ValueError("cyclic observability value")
        active.add(id(item))
        try:
            if isinstance(item, Mapping):
                result = {}
                for name in islice(item, max_items):
                    if remaining <= 0:
                        break
                    label = str(name) if isinstance(name, (str, int, float, bool)) else "<key>"
                    label = _limited_text(_redact_text(label), max_string_length)
                    result[label] = (
                        REDACTED if _matches_key(name, secret_keys)
                        else visit(item[name], depth + 1, name)
                    )
                if len(item) > len(result):
                    result["_truncated_items"] = len(item) - len(result)
                return result
            if is_dataclass(item) and not isinstance(item, type):
                result = {}
                names = fields(item)
                for attribute in islice(names, max_items):
                    if remaining <= 0:
                        break
                    name = attribute.name
                    result[name] = (
                        REDACTED if _matches_key(name, secret_keys)
                        else visit(getattr(item, name), depth + 1, name)
                    )
                if len(names) > len(result):
                    result["_truncated_items"] = len(names) - len(result)
                return result
            if isinstance(item, (bytes, bytearray, memoryview)):
                size = item.nbytes if isinstance(item, memoryview) else len(item)
                if size > max_string_length:
                    return f"<truncated-bytes:{size}>"
                return visit(to_jsonable(bytes(item)), depth + 1)
            if isinstance(item, Sequence):
                result = []
                for index in range(min(len(item), max_items)):
                    if remaining <= 0:
                        break
                    result.append(visit(item[index], depth + 1))
                if len(item) > len(result):
                    result.append(f"<truncated-items:{len(item) - len(result)}>")
                return result
            if isinstance(item, Enum):
                return visit(item.value, depth + 1)
            if isinstance(item, (date, datetime, Path)):
                return visit(to_jsonable(item), depth + 1)
            if isinstance(item, Decimal):
                # Scientific notation avoids allocating millions of zeroes.
                return visit(str(item), depth + 1)
            return f"<{type(item).__name__}>"
        finally:
            active.remove(id(item))

    return visit(value, _depth, _key)


@dataclass
class EventRecorder:
    emit_stdout: bool = False
    max_event_length: int = 12000
    logger: logging.Logger = field(
        default_factory=lambda: logging.getLogger("easytest.events")
    )
    events: list[dict[str, Any]] = field(default_factory=list)

    def emit(self, event: str, **fields: Any) -> dict[str, Any]:
        try:
            payload = redact(
                {
                    **fields,
                    "timestamp": datetime.now(UTC).isoformat(),
                    "event": event,
                }
            )
            rendered = json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            if len(rendered) > self.max_event_length:
                payload = {
                    "timestamp": payload["timestamp"],
                    "event": event,
                    "truncated": True,
                    "payload_sha256": hashlib.sha256(rendered.encode()).hexdigest(),
                    "preview": rendered[: self.max_event_length // 2],
                }
                rendered = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        except Exception:
            safe_event = event if event in {
                "case.start", "case.done", "case.error",
                "step.start", "step.done", "step.error",
            } else "observability.error"
            payload = {
                "event": safe_event,
                "detail": "[REDACTED_DUE_TO_ERROR]",
            }
            rendered = (
                '{"event":"' + safe_event + '","detail":"[REDACTED_DUE_TO_ERROR]"}'
            )
        self.events.append(payload)
        try:
            self.logger.info(rendered)
        except Exception:
            pass
        if self.emit_stdout:
            try:
                print(rendered, flush=True)
            except Exception:
                pass
        return payload

    def as_ndjson(self) -> str:
        return "\n".join(
            json.dumps(event, ensure_ascii=False, sort_keys=True)
            for event in self.events
        )
