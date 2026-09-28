"""配置文件读取与进程内缓存。"""

import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Any

from easytest.util.dict_obj import dict_to_obj
from easytest.util.get_path import get_path

NOTE_KEY_PREFIX = "__note_"
NOTE_KEY_SUFFIX = "__"
CONFIG_CACHE_SIZE = 32

_CONFIG_CACHE_LOCK = RLock()
_PACKAGE_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config_defaults"


def _is_note_key(key: Any) -> bool:
    """判断是否为 ``__note_xxx__`` 格式的 JSON 伪注释键。"""
    if not isinstance(key, str):
        return False
    return (
        key.startswith(NOTE_KEY_PREFIX)
        and key.endswith(NOTE_KEY_SUFFIX)
        and len(key) > len("__note___")
    )


def _strip_note_keys(value: Any) -> Any:
    """递归删除字典和列表中的 JSON 伪注释键。"""
    if isinstance(value, dict):
        return {key: _strip_note_keys(item) for key, item in value.items() if not _is_note_key(key)}
    if isinstance(value, list):
        return [_strip_note_keys(item) for item in value]
    return value


def _file_version(path: Path) -> tuple[int, int, int]:
    """返回可用于缓存失效的文件版本。"""
    stat = path.stat()
    return stat.st_ino, stat.st_mtime_ns, stat.st_size


@lru_cache(maxsize=CONFIG_CACHE_SIZE)
def _load_config_snapshot(config_file_path: str, _version: tuple[int, int, int]) -> Any:
    """读取并清理配置；文件版本仅用于构成缓存键。"""
    try:
        with open(config_file_path, "r", encoding="utf-8") as file:
            config = json.load(file)
    except json.JSONDecodeError as exc:
        raise json.JSONDecodeError(
            f"Config file {config_file_path} is not valid JSON: {exc.msg}",
            doc=exc.doc,
            pos=exc.pos,
        ) from exc

    return _strip_note_keys(config)


def _load_config(config_file_path: Path) -> Any:
    """线程安全地读取当前文件版本，避免并发首次访问重复解析。"""
    version = _file_version(config_file_path)
    with _CONFIG_CACHE_LOCK:
        return _load_config_snapshot(str(config_file_path), version)


def _clear_config_cache() -> None:
    """清空当前进程的配置缓存，主要供测试和显式刷新使用。"""
    with _CONFIG_CACHE_LOCK:
        _load_config_snapshot.cache_clear()


def _copy_result(value: Any) -> Any:
    """返回独立结果，避免调用方修改缓存中的可变快照。"""
    if isinstance(value, dict):
        return dict_to_obj(value)
    if isinstance(value, list):
        return deepcopy(value)
    return value


def _ensure_not_note_key(layer_name: str, key: str | None) -> None:
    if _is_note_key(key):
        raise ValueError(f"{layer_name} cannot be a note key: {key}")


def _resolve_config_file(config_name: str) -> Path:
    try:
        return Path(get_path("config", f"{config_name}.json"))
    except FileNotFoundError:
        package_default = _PACKAGE_CONFIG_DIR / f"{config_name}.json"
        if package_default.is_file():
            return package_default
        raise


def get_config(
    config_name: str,
    first_layer: str | None = None,
    second_layer: str | None = None,
    third_layer: str | None = None,
) -> Any:
    """读取配置文件或最多三级的配置项。

    配置快照按文件版本缓存在当前进程中。返回的字典和列表与缓存相互隔离，
    可以由调用方安全修改；外部文件发生变化后，下次调用会自动重新加载。
    """
    _ensure_not_note_key("first_layer", first_layer)
    _ensure_not_note_key("second_layer", second_layer)
    _ensure_not_note_key("third_layer", third_layer)

    config_file_path = _resolve_config_file(config_name)
    config = _load_config(config_file_path)

    if first_layer is None:
        return _copy_result(config)
    if first_layer not in config:
        raise KeyError(
            f"Cannot find first_layer key: {first_layer} in config file for {config_name}"
        )

    config_content = config[first_layer]
    if second_layer is None:
        return _copy_result(config_content)
    if not isinstance(config_content, dict) or second_layer not in config_content:
        raise KeyError(
            f"Cannot find second_layer key: {second_layer} in {first_layer} for {config_name}"
        )

    config_content = config_content[second_layer]
    if third_layer is None:
        return _copy_result(config_content)
    if not isinstance(config_content, dict) or third_layer not in config_content:
        key_path = f"{first_layer}.{second_layer}"
        raise KeyError(
            f"Cannot find third_layer key: {third_layer} in {key_path} for {config_name}"
        )

    return _copy_result(config_content[third_layer])
