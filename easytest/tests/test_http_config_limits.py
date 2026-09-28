import json
from dataclasses import replace

import pytest

from easytest.cases.loader import load_project_cases
from easytest.config import ProjectConfig
from easytest.models import ConfigurationError
from easytest.runtime.preflight import preflight
from easytest.starter import init_project


def write_json(path, value):
    path.write_text(json.dumps(value))


@pytest.mark.parametrize("header", ["Authorization", "Cookie", "X-Api-Key", "X-Access-Token", "X-Secret-Value"])
def test_literal_http_secret_is_rejected_without_echo(tmp_path, header):
    root = init_project(tmp_path / "project")
    operations = root / "config/operations.json"
    value = json.loads(operations.read_text())
    value["operations"]["http.ping"]["headers"] = {header: "private-credential"}
    write_json(operations, value)
    with pytest.raises(ConfigurationError) as caught:
        ProjectConfig(root)
    assert caught.value.code == "HTTP_SECRET_SOURCE"
    assert header in caught.value.field
    assert "private-credential" not in str(caught.value)


def test_env_secret_source_needs_no_credentials_for_offline_preflight(tmp_path):
    root = init_project(tmp_path / "project")
    path = root / "config/operations.json"
    value = json.loads(path.read_text())
    value["operations"]["http.ping"]["headers"] = {"Authorization": "Bearer ${UNSET_EASYTEST_CREDENTIAL}"}
    write_json(path, value)
    config = ProjectConfig(root)
    cases = load_project_cases(root / "cases", write_compiled=False)
    assert preflight(cases, config, config.resolve_run()).case_count == len(cases)


@pytest.mark.parametrize("limit", [0, -1, True, "32", 64 * 1024 * 1024 + 1])
def test_runtime_http_limit_is_strict(tmp_path, limit):
    root = init_project(tmp_path / "project")
    path = root / "config/runtime.json"
    value = json.loads(path.read_text())
    value["http"] = {"max_response_bytes": limit}
    write_json(path, value)
    with pytest.raises(ConfigurationError, match="max_response_bytes"):
        ProjectConfig(root)


def test_operation_and_request_can_only_lower_ceiling(tmp_path):
    root = init_project(tmp_path / "project")
    runtime = root / "config/runtime.json"
    value = json.loads(runtime.read_text())
    value["http"] = {"max_response_bytes": 100}
    write_json(runtime, value)
    config = ProjectConfig(root)
    assert config.operation("http.ping", "http")["max_response_bytes"] == 100
    cases = load_project_cases(root / "cases", write_compiled=False)
    case = cases[0]
    for limit in [50, 100]:
        changed = replace(case, steps=(replace(case.steps[0], request={"max_response_bytes": limit}),))
        assert preflight([changed], config, config.resolve_run()).case_count == 1
    changed = replace(case, steps=(replace(case.steps[0], request={"max_response_bytes": 101}),))
    with pytest.raises(ConfigurationError, match="exceeds"):
        preflight([changed], config, config.resolve_run())
    operations = root / "config/operations.json"
    value = json.loads(operations.read_text())
    value["operations"]["http.ping"]["max_response_bytes"] = 101
    write_json(operations, value)
    with pytest.raises(ConfigurationError, match="exceeds"):
        ProjectConfig(root)


def test_step_literal_header_is_rejected_during_preflight(tmp_path):
    root = init_project(tmp_path / "project")
    config = ProjectConfig(root)
    case = load_project_cases(root / "cases", write_compiled=False)[0]
    changed = replace(case, steps=(replace(
        case.steps[0], request={"headers": {"Authorization": "secret-value"}},
    ),))
    with pytest.raises(ConfigurationError) as caught:
        preflight([changed], config, config.resolve_run())
    assert caught.value.code == "HTTP_SECRET_SOURCE"


@pytest.mark.parametrize("settings", [{"secret_keys": "password"}, {"pii_keys": [""]}, {"unknown": []}])
def test_custom_redaction_settings_are_strict(tmp_path, settings):
    root = init_project(tmp_path / "project")
    path = root / "config/runtime.json"
    value = json.loads(path.read_text())
    value["redaction"] = settings
    write_json(path, value)
    with pytest.raises(ConfigurationError):
        ProjectConfig(root)
