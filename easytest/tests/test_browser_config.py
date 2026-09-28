"""配置读取和缓存测试。"""

import json
from collections.abc import Iterator
from pathlib import Path

import pytest

import easytest.util.get_config as get_config_module


@pytest.fixture(autouse=True)
def clear_config_cache() -> Iterator[None]:
    get_config_module._clear_config_cache()
    yield
    get_config_module._clear_config_cache()


@pytest.fixture
def config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "sample.json"
    path.write_text(
        json.dumps(
            {
                "__note_global__": "top level note",
                "app": {
                    "__note_app__": "app note",
                    "host": "localhost",
                    "db": {
                        "__note_db__": "db note",
                        "port": 3306,
                    },
                    "items": [
                        {
                            "__note_item__": "item note",
                            "name": "first",
                        }
                    ],
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(get_config_module, "get_path", lambda *_args, **_kwargs: str(path))
    return path


def test_get_config_strips_note_keys_recursively(config_path: Path) -> None:
    config = get_config_module.get_config("sample")

    assert "__note_global__" not in config
    assert "__note_app__" not in config.app
    assert "__note_db__" not in config.app.db
    assert "__note_item__" not in config.app["items"][0]
    assert config.app.db.port == 3306


def test_get_config_supports_layer_selection(config_path: Path) -> None:
    app = get_config_module.get_config("sample", "app")
    database = get_config_module.get_config("sample", "app", "db")
    port = get_config_module.get_config("sample", "app", "db", "port")

    assert app.host == "localhost"
    assert database.port == 3306
    assert port == 3306


def test_get_config_reuses_snapshot_without_sharing_mutable_results(config_path: Path) -> None:
    first = get_config_module.get_config("sample")
    cache_after_first = get_config_module._load_config_snapshot.cache_info()

    first.app.host = "changed by caller"
    first.app["items"][0].name = "changed by caller"
    second = get_config_module.get_config("sample")
    cache_after_second = get_config_module._load_config_snapshot.cache_info()

    assert second.app.host == "localhost"
    assert second.app["items"][0].name == "first"
    assert cache_after_second.hits == cache_after_first.hits + 1


def test_get_config_invalidates_cache_when_file_changes(config_path: Path) -> None:
    assert get_config_module.get_config("sample", "app", "db", "port") == 3306

    raw_config = json.loads(config_path.read_text(encoding="utf-8"))
    raw_config["app"]["db"]["port"] = 54321
    config_path.write_text(json.dumps(raw_config, ensure_ascii=False), encoding="utf-8")

    assert get_config_module.get_config("sample", "app", "db", "port") == 54321


def test_note_keys_cannot_be_targeted(config_path: Path) -> None:
    with pytest.raises(ValueError):
        get_config_module.get_config("sample", "__note_global__")


def test_get_config_preserves_non_object_root_support(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "list.json"
    path.write_text('[{"value": 1}]', encoding="utf-8")
    monkeypatch.setattr(get_config_module, "get_path", lambda *_args, **_kwargs: str(path))

    first = get_config_module.get_config("list")
    first[0]["value"] = 2

    assert get_config_module.get_config("list") == [{"value": 1}]


def test_get_config_falls_back_to_packaged_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing_project_config(*_args: object, **_kwargs: object) -> str:
        raise FileNotFoundError("project config not found")

    monkeypatch.setattr(get_config_module, "get_path", missing_project_config)

    assert get_config_module.get_config("common", "browser") == "chrome"
