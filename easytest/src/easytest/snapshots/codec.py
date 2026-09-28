from __future__ import annotations

import hashlib
import json
import re
import zlib
from pathlib import Path
from typing import Any

from easytest.models import ConfigurationError


SNAPSHOT_ZLIB_MAGIC = b"EASYTEST-SNAPSHOT-ZLIB-1\0"
SNAPSHOT_RAW_MAGIC = b"EASYTEST-SNAPSHOT-RAW-1\0"
SNAPSHOT_ARTIFACT_MAGIC = b"EASYTEST-SNAPSHOT-ARTIFACT-1\0"
DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
HARD_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024
ARTIFACT_NAME = re.compile(r"^[0-9a-f]{64}\.[a-z0-9]+$")
ARTIFACT_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".img"}


def snapshot_size_limit(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= HARD_MAX_SNAPSHOT_BYTES:
        raise ConfigurationError(
            f"snapshot_max_bytes must be an integer in 1..{HARD_MAX_SNAPSHOT_BYTES}",
            code="INVALID_VALUE",
            field="snapshot_max_bytes",
        )
    return value


def encode_snapshot(
    content: bytes,
    *,
    max_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
) -> bytes:
    limit = snapshot_size_limit(max_bytes)
    if len(content) > limit:
        raise ConfigurationError(
            f"snapshot content exceeds snapshot_max_bytes ({limit})",
            code="SNAPSHOT_TOO_LARGE",
            field="snapshot_max_bytes",
        )
    compressed = zlib.compress(content, level=6)
    if len(SNAPSHOT_ZLIB_MAGIC) + len(compressed) < len(SNAPSHOT_RAW_MAGIC) + len(content):
        return SNAPSHOT_ZLIB_MAGIC + compressed
    return SNAPSHOT_RAW_MAGIC + content


def decode_snapshot(
    content: bytes,
    *,
    max_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
) -> bytes:
    limit = snapshot_size_limit(max_bytes)
    if type(content) is not bytes:
        raise ValueError("snapshot payload must be bytes")
    if content.startswith(SNAPSHOT_RAW_MAGIC):
        result = content[len(SNAPSHOT_RAW_MAGIC):]
    elif content.startswith(SNAPSHOT_ZLIB_MAGIC):
        decoder = zlib.decompressobj()
        result = decoder.decompress(content[len(SNAPSHOT_ZLIB_MAGIC):], limit + 1)
        if len(result) > limit or decoder.unconsumed_tail:
            raise ConfigurationError(
                f"decoded snapshot exceeds snapshot_max_bytes ({limit})",
                code="SNAPSHOT_TOO_LARGE",
                field="snapshot_max_bytes",
            )
        result += decoder.flush(limit + 1 - len(result))
        if not decoder.eof or decoder.unused_data:
            raise ValueError("invalid compressed snapshot payload")
    else:
        raise ValueError("unknown snapshot payload codec")
    if len(result) > limit:
        raise ConfigurationError(
            f"decoded snapshot exceeds snapshot_max_bytes ({limit})",
            code="SNAPSHOT_TOO_LARGE",
            field="snapshot_max_bytes",
        )
    return result


def read_bounded_file(
    source: str | Path,
    *,
    max_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
    label: str = "snapshot content",
) -> bytes:
    limit = snapshot_size_limit(max_bytes)
    content = bytearray()
    with Path(source).open("rb") as stream:
        while chunk := stream.read(min(64 * 1024, limit + 1 - len(content))):
            content.extend(chunk)
            if len(content) > limit:
                raise ConfigurationError(
                    f"{label} exceeds snapshot_max_bytes ({limit})",
                    code="SNAPSHOT_TOO_LARGE",
                    field="snapshot_max_bytes",
                )
    return bytes(content)


def decode_artifact_reference(content: bytes) -> dict[str, Any] | None:
    if not content.startswith(SNAPSHOT_ARTIFACT_MAGIC):
        return None
    try:
        value = json.loads(content[len(SNAPSHOT_ARTIFACT_MAGIC):])
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid snapshot artifact reference") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"path", "sha256", "size"}
        or not isinstance(value["path"], str)
        or not isinstance(value["sha256"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"])
        or type(value["size"]) is not int
        or value["size"] < 0
    ):
        raise ValueError("invalid snapshot artifact reference")
    return value


def snapshot_artifact_target(
    artifact_dir: str | Path,
    reference: dict[str, Any],
) -> Path:
    root = Path(artifact_dir).resolve()
    relative = Path(reference["path"])
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != reference["sha256"][:2]
        or not ARTIFACT_NAME.fullmatch(relative.name)
        or relative.stem != reference["sha256"]
        or relative.suffix not in ARTIFACT_SUFFIXES
    ):
        raise ValueError("unsafe snapshot artifact reference")
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise ValueError("snapshot artifact escapes artifact directory")
    return target


def read_snapshot_artifact(
    artifact_dir: str | Path,
    reference: dict[str, Any],
    *,
    max_bytes: int = DEFAULT_MAX_SNAPSHOT_BYTES,
) -> bytes:
    limit = snapshot_size_limit(max_bytes)
    target = snapshot_artifact_target(artifact_dir, reference)
    if not target.is_file():
        raise ConfigurationError(f"snapshot artifact does not exist: {target}")
    if target.stat().st_size != reference["size"]:
        raise ConfigurationError(f"snapshot artifact size does not match: {target}")
    if reference["size"] > limit:
        raise ConfigurationError(
            f"snapshot artifact exceeds snapshot_max_bytes ({limit})",
            code="SNAPSHOT_TOO_LARGE",
            field="snapshot_max_bytes",
        )
    content = read_bounded_file(
        target,
        max_bytes=limit,
        label="snapshot artifact",
    )
    if hashlib.sha256(content).hexdigest() != reference["sha256"]:
        raise ConfigurationError(f"snapshot artifact checksum does not match: {target}")
    return content
