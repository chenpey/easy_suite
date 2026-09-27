from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from easytest.config import ProjectConfig
from easytest.models import Case, ConfigurationError, RunContext


ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def test_project_config_strips_recursive_note_keys(tmp_path: Path) -> None:
    shutil.copytree(ROOT / "config", tmp_path / "config")
    runtime_path = tmp_path / "config/runtime.json"
    runtime = json.loads(runtime_path.read_text())
    runtime["__note_runtime__"] = "human-readable note"
    runtime["database"]["connections"]["default"]["__note_connection__"] = "note"
    runtime_path.write_text(json.dumps(runtime))

    config = ProjectConfig(tmp_path)

    assert "__note_runtime__" not in config.runtime
    assert (
        "__note_connection__"
        not in config.runtime["database"]["connections"]["default"]
    )


def test_run_context_exposes_stable_generated_template_values() -> None:
    case = Case(
        id="generated.case",
        name="Generated values",
        case_type="scenario",
        enabled=True,
        tags=(),
        variables={},
        mock_profile=None,
        snapshot_profile="default",
        steps=(),
    )
    context = RunContext(
        case=case,
        root=ROOT,
        run_mode="read",
        variables={},
    )

    first_scope = context.template_scope()
    second_scope = context.template_scope()

    assert first_scope["generate"] is context.generated
    assert second_scope["generate"] == first_scope["generate"]
    assert {
        "uuid",
        "timestamp",
        "timestamp_ms",
        "request_id",
        "order_id",
    } <= context.generated.keys()
    assert context.run_id.startswith("run_")


def _minimal_config(root, **files):
    directory = root / "config"
    directory.mkdir()
    files.setdefault("operations", {"operations": {
        "http.ping": {"executor": "http", "url": "https://example.invalid"}
    }})
    for name, document in files.items():
        (directory / f"{name}.json").write_text(json.dumps(document))
    return ProjectConfig(root)


def test_only_operations_configuration_is_required(tmp_path, monkeypatch):
    monkeypatch.delenv("RUN_MODE", raising=False)
    config = _minimal_config(tmp_path)
    assert config.resolve_run()["run_mode"] == "read"
    assert config.resolve_run()["fail_on_mock_miss"] is False
    assert config.mock_profile(None) == {}
    with pytest.raises(ConfigurationError, match="unknown profile"):
        config.resolve_run(profile="missing")
    with pytest.raises(ConfigurationError, match="unknown snapshot rule"):
        config.snapshot_rule("default", "response_default")
    with pytest.raises(ConfigurationError, match="unknown mock profile"):
        config.mock_profile("missing")


def test_profile_priority_false_override_and_base_not_mutated(tmp_path, monkeypatch):
    monkeypatch.setenv("RUN_MODE", "write")
    config = _minimal_config(
        tmp_path,
        runtime={"run_mode": "read", "allow_db_write": True, "observability": {
            "emit_stdout": True, "max_event_length": 4000,
        }},
        profiles={"profiles": {"offline": {
            "mock_profile": "responses", "fail_on_mock_miss": False,
            "allow_db_write": False,
            "runtime": {"run_mode": "baseline", "observability": {"emit_stdout": False}},
        }}},
        mock_profiles={"profiles": {"responses": {}}},
    )
    settings = config.resolve_run(profile="offline")
    assert settings["run_mode"] == "baseline"
    assert settings["fail_on_mock_miss"] is False
    assert settings["allow_db_write"] is False
    assert settings["runtime"]["observability"] == {
        "emit_stdout": False, "max_event_length": 4000,
    }
    assert config.runtime["observability"]["emit_stdout"] is True
    assert config.resolve_run(profile="offline", run_mode="read")["run_mode"] == "read"
    assert config.resolve_run(profile="offline", allow_db_write=True)["allow_db_write"] is True
    assert config.resolve_run()["run_mode"] == "write"
    monkeypatch.delenv("RUN_MODE")
    assert config.resolve_run()["run_mode"] == "read"


@pytest.mark.parametrize("profile", [
    {"fail_on_mock_miss": "false"}, {"fail_on_mock_miss": None},
    {"allow_db_write": 0}, {"allow_db_write": None}, {"mock_profile": "missing"},
    {"mock_profile": False}, {"unknown": True},
    {"runtime": {"CONFIRM_BASELINE": "1"}}, {"runtime": None},
    {"runtime": {"observability": {"emit_stdout": "false"}}},
    {"runtime": {"observability": {"max_event_length": True}}},
    {"runtime": {"observability": {"unknown": 1}}},
    {"runtime": {"run_mode": None}},
])
def test_invalid_profile_fields_fail_before_running(tmp_path, profile):
    with pytest.raises(ConfigurationError):
        _minimal_config(tmp_path, profiles={"profiles": {"bad": profile}})


@pytest.mark.parametrize("runtime", [
    {"database": []}, {"observability": None}, {"allow_db_write": "false"},
    {"run_mode": False}, {"default_profile": None},
])
def test_invalid_runtime_fields_are_actionable(tmp_path, runtime):
    with pytest.raises(ConfigurationError):
        _minimal_config(tmp_path, runtime=runtime)


def test_default_profile_can_be_explicitly_replaced(tmp_path):
    config = _minimal_config(
        tmp_path, runtime={"default_profile": "offline"},
        profiles={"profiles": {
            "offline": {"fail_on_mock_miss": True}, "live": {},
        }},
    )
    assert config.resolve_run()["fail_on_mock_miss"] is True
    assert config.resolve_run(profile="live")["fail_on_mock_miss"] is False


@pytest.mark.parametrize("keep", [1, 20, None])
def test_snapshot_history_keep_accepts_positive_integer_or_unlimited(tmp_path, keep):
    config = _minimal_config(tmp_path, runtime={"snapshot_history_keep": keep})
    assert config.runtime["snapshot_history_keep"] == keep


@pytest.mark.parametrize("keep", [0, -1, True, False, 1.5, "20"])
def test_snapshot_history_keep_rejects_invalid_values(tmp_path, keep):
    with pytest.raises(ConfigurationError, match="snapshot_history_keep"):
        _minimal_config(tmp_path, runtime={"snapshot_history_keep": keep})
