from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

import easytest.util.get_path as get_path_module

if TYPE_CHECKING:
    from pathlib import Path


def test_find_dir_path_is_scoped_to_explicit_root(tmp_path: Path) -> None:
    project = tmp_path / "project"
    nested = project / "cases" / "api"
    config = project / "config"
    nested.mkdir(parents=True)
    config.mkdir()

    assert get_path_module.find_dir_path("config", root=project) == config
    with pytest.raises(FileNotFoundError):
        get_path_module.find_dir_path("config", root=nested)


def test_get_root_path_is_current_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    assert get_path_module.get_root_path() == tmp_path.resolve()


def test_get_path_creates_and_resolves_files(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "tmp/test"
    directory.mkdir(parents=True)

    created = get_path_module.get_path(
        "tmp/test",
        "context.json",
        create=True,
        root=tmp_path,
    )

    assert created == directory / "context.json"
    assert created.exists()


def test_get_path_finds_file_without_extension(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "config"
    directory.mkdir()
    expected = directory / "common.json"
    expected.touch()
    assert get_path_module.get_path("config", "common", root=tmp_path) == expected


def test_get_path_rejects_root_escape(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="escapes configured root"):
        get_path_module.get_path("../outside", root=tmp_path)
