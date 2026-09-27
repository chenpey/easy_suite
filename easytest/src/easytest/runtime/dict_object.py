from __future__ import annotations

from collections.abc import Mapping
from typing import Any


_MISSING = object()


class DictObject(dict):
    """Dictionary with recursive attribute access and fail-fast missing keys."""

    def __init__(
        self,
        *args: Any,
        default: Any = _MISSING,
        max_depth: int = 20,
        **kwargs: Any,
    ) -> None:
        if max_depth < 0:
            raise ValueError("max_depth must be non-negative")
        object.__setattr__(self, "_default", default)
        object.__setattr__(self, "_max_depth", max_depth)
        raw = dict(*args, **kwargs)
        super().__init__()
        seen = {id(raw)}
        for key, value in raw.items():
            dict.__setitem__(
                self,
                key,
                _convert(
                    value,
                    default=default,
                    max_depth=max_depth,
                    depth=1,
                    seen=seen,
                ),
            )

    def __getattr__(self, key: str) -> Any:
        if key in self:
            return self[key]
        if self._default is not _MISSING:
            return self._default
        raise AttributeError(f"{type(self).__name__!s} has no key {key!r}")

    def __setattr__(self, key: str, value: Any) -> None:
        if key.startswith("_"):
            object.__setattr__(self, key, value)
            return
        self[key] = value

    def __delattr__(self, key: str) -> None:
        try:
            del self[key]
        except KeyError as exc:
            raise AttributeError(f"{type(self).__name__!s} has no key {key!r}") from exc

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(
            key,
            _convert(value, default=self._default, max_depth=self._max_depth),
        )

    def update(self, *args: Any, **kwargs: Any) -> None:
        values = dict(*args, **kwargs)
        for key, value in values.items():
            self[key] = value


def _convert(
    value: Any,
    *,
    default: Any,
    max_depth: int,
    depth: int = 0,
    seen: set[int] | None = None,
) -> Any:
    if depth > max_depth:
        raise ValueError(f"maximum conversion depth exceeded: {max_depth}")
    if not isinstance(value, (Mapping, list, tuple)):
        return value

    seen = seen or set()
    identity = id(value)
    if identity in seen:
        raise ValueError("cyclic data cannot be converted to DictObject")
    seen.add(identity)
    try:
        if isinstance(value, Mapping):
            result = DictObject(default=default, max_depth=max_depth)
            for key, item in value.items():
                dict.__setitem__(
                    result,
                    key,
                    _convert(
                        item,
                        default=default,
                        max_depth=max_depth,
                        depth=depth + 1,
                        seen=seen,
                    ),
                )
            return result
        converted = [
            _convert(
                item,
                default=default,
                max_depth=max_depth,
                depth=depth + 1,
                seen=seen,
            )
            for item in value
        ]
        return tuple(converted) if isinstance(value, tuple) else converted
    finally:
        seen.remove(identity)


def dict_to_obj(
    value: Any,
    default: Any = _MISSING,
    *,
    max_depth: int = 20,
) -> Any:
    return _convert(value, default=default, max_depth=max_depth)


def obj_to_dict(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: obj_to_dict(item) for key, item in value.items()}
    if isinstance(value, list):
        return [obj_to_dict(item) for item in value]
    if isinstance(value, tuple):
        return tuple(obj_to_dict(item) for item in value)
    return value
