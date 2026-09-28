from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

import easytest.util.get_path as get_path_module

if TYPE_CHECKING:
    from pathlib import Path


def test_find_dir_path_prefers_current_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    nested = project / "cases" / "api"
    config = project / "config"
    nested.mkdir(parents=True)
    config.mkdir()
    monkeypatch.chdir(nested)

    assert get_path_module.find_dir_path("config") == config


def test_get_root_path_is_current_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    assert get_path_module.get_root_path() == tmp_path.resolve()


def test_get_path_creates_and_resolves_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "tmp/test"
    directory.mkdir(parents=True)
    monkeypatch.setattr(get_path_module, "find_dir_path", lambda _: directory)

    created = get_path_module.get_path("tmp/test", "context.json", create=True)

    assert created == directory / "context.json"
    assert created.exists()


def test_get_path_finds_file_without_extension(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "config"
    directory.mkdir()
    expected = directory / "common.json"
    expected.touch()
    monkeypatch.setattr(get_path_module, "find_dir_path", lambda _: directory)

    assert get_path_module.get_path("config", "common") == expected
