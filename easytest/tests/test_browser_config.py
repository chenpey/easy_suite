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
def config_root(tmp_path: Path) -> Path:
    directory = tmp_path / "config"
    directory.mkdir()
    path = directory / "sample.json"
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
    return tmp_path


def test_get_config_strips_note_keys_recursively(config_root: Path) -> None:
    config = get_config_module.get_config("sample", root=config_root)

    assert "__note_global__" not in config
    assert "__note_app__" not in config.app
    assert "__note_db__" not in config.app.db
    assert "__note_item__" not in config.app["items"][0]
    assert config.app.db.port == 3306


def test_get_config_supports_layer_selection(config_root: Path) -> None:
    app = get_config_module.get_config("sample", "app", root=config_root)
    database = get_config_module.get_config("sample", "app", "db", root=config_root)
    port = get_config_module.get_config("sample", "app", "db", "port", root=config_root)

    assert app.host == "localhost"
    assert database.port == 3306
    assert port == 3306


def test_get_config_reuses_snapshot_without_sharing_mutable_results(config_root: Path) -> None:
    first = get_config_module.get_config("sample", root=config_root)
    cache_after_first = get_config_module._load_config_snapshot.cache_info()

    first.app.host = "changed by caller"
    first.app["items"][0].name = "changed by caller"
    second = get_config_module.get_config("sample", root=config_root)
    cache_after_second = get_config_module._load_config_snapshot.cache_info()

    assert second.app.host == "localhost"
    assert second.app["items"][0].name == "first"
    assert cache_after_second.hits == cache_after_first.hits + 1


def test_get_config_invalidates_cache_when_file_changes(config_root: Path) -> None:
    assert get_config_module.get_config(
        "sample", "app", "db", "port", root=config_root
    ) == 3306

    config_path = config_root / "config/sample.json"
    raw_config = json.loads(config_path.read_text(encoding="utf-8"))
    raw_config["app"]["db"]["port"] = 54321
    config_path.write_text(json.dumps(raw_config, ensure_ascii=False), encoding="utf-8")

    assert get_config_module.get_config(
        "sample", "app", "db", "port", root=config_root
    ) == 54321


def test_note_keys_cannot_be_targeted(config_root: Path) -> None:
    with pytest.raises(ValueError):
        get_config_module.get_config("sample", "__note_global__", root=config_root)


def test_get_config_preserves_non_object_root_support(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "config"
    directory.mkdir()
    path = directory / "list.json"
    path.write_text('[{"value": 1}]', encoding="utf-8")

    first = get_config_module.get_config("list", root=tmp_path)
    first[0]["value"] = 2

    assert get_config_module.get_config("list", root=tmp_path) == [{"value": 1}]


def test_get_config_falls_back_to_packaged_defaults() -> None:
    assert get_config_module.get_config("common", "browser") == "chrome"


def test_get_config_does_not_search_parent_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent_config = tmp_path / "config"
    parent_config.mkdir()
    (parent_config / "common.json").write_text('{"browser":"edge"}')
    nested = tmp_path / "nested"
    nested.mkdir()
    monkeypatch.chdir(nested)

    assert get_config_module.get_config("common", "browser") == "chrome"
