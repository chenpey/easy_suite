from __future__ import annotations

import json

import pytest

from easytest.cases.loader import load_project_cases
from easytest.cli import main
from easytest.models import ConfigurationError
from easytest.runtime.runner import CaseRunner
from easytest.starter import init_project


def _policy(root, **overrides):
    document = {
        "schema_version": 1,
        "allowed_profiles": ["offline-strict"],
        "allowed_case_ids": ["http.demo"],
        "allowed_operations": ["http.ping"],
        "allowed_executors": ["http"],
        **overrides,
    }
    path = root / "trusted-policy.json"
    path.write_text(json.dumps(document))
    return path


def test_policy_allows_selected_offline_case_and_binds_input_hash(
    tmp_path,
    capsys,
):
    root = init_project(tmp_path / "project")
    policy = _policy(root)

    main(["validate", "--root", str(root), "--execution-policy", str(policy)])
    validated = json.loads(capsys.readouterr().out)
    main([
        "run",
        "--root",
        str(root),
        "--execution-policy",
        str(policy),
        "--no-report",
    ])
    executed = json.loads(capsys.readouterr().out)

    assert validated["data"]["input_hash"].startswith("sha256:")
    assert executed["data"]["input_hash"] == validated["data"]["input_hash"]
    assert executed["data"]["cases"][0]["input_hash"] == validated["data"]["input_hash"]


def test_policy_blocks_unapproved_live_http_origin_before_request(
    tmp_path,
    monkeypatch,
):
    root = init_project(tmp_path / "project")
    policy = _policy(
        root,
        allowed_profiles=["live"],
        allowed_http_methods=["GET"],
        allowed_http_origins=["https://allowed.example"],
    )
    called = False

    def request(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("network must not be reached")

    monkeypatch.setattr("requests.Session.request", request)
    with pytest.raises(ConfigurationError) as caught:
        main([
            "run",
            "--root",
            str(root),
            "--profile",
            "live",
            "--execution-policy",
            str(policy),
            "--no-report",
        ])

    assert caught.value.code == "EXECUTION_POLICY_VIOLATION"
    assert caught.value.field == "execution_policy.allowed_http_origins"
    assert called is False


def test_policy_allows_exact_http_method_and_origin(tmp_path, monkeypatch, capsys):
    root = init_project(tmp_path / "project")
    operations = json.loads((root / "config/operations.json").read_text())
    operations["operations"]["http.ping"].update(
        url="https://allowed.example/ping",
        allow_redirects=False,
    )
    (root / "config/operations.json").write_text(json.dumps(operations))
    policy = _policy(
        root,
        allowed_profiles=["live"],
        allowed_http_methods=["GET"],
        allowed_http_origins=["https://allowed.example"],
    )
    calls = []

    class Response:
        status_code = 200
        headers = {}
        url = "https://allowed.example/ping"
        text = ""

        @staticmethod
        def json():
            return {"ok": True}

        @staticmethod
        def close():
            return None

    def request(_self, method, url, **kwargs):
        calls.append((method, url, kwargs["allow_redirects"]))
        return Response()

    monkeypatch.setattr("requests.Session.request", request)
    main([
        "run",
        "--root",
        str(root),
        "--profile",
        "live",
        "--execution-policy",
        str(policy),
        "--no-report",
    ])

    assert json.loads(capsys.readouterr().out)["status"] == "passed"
    assert calls == [("GET", "https://allowed.example/ping", False)]


def test_policy_rechecks_environment_resolved_http_target_at_execution(
    tmp_path,
    monkeypatch,
):
    root = init_project(tmp_path / "project")
    operations = json.loads((root / "config/operations.json").read_text())
    operations["operations"]["http.ping"]["url"] = "${TARGET}/ping"
    operations["operations"]["http.ping"]["allow_redirects"] = False
    (root / "config/operations.json").write_text(json.dumps(operations))
    policy = _policy(
        root,
        allowed_profiles=["live"],
        allowed_http_methods=["GET"],
        allowed_http_origins=["https://allowed.example"],
    )
    monkeypatch.setenv("TARGET", "https://allowed.example")
    cases = load_project_cases(root / "cases", root=root)

    with CaseRunner(root, profile="live", execution_policy=policy) as runner:
        runner.preflight(cases, reuse_for_run=True)
        monkeypatch.setenv("TARGET", "https://blocked.example")
        with pytest.raises(ConfigurationError) as caught:
            runner.run(cases[0])

    assert caught.value.code == "EXECUTION_POLICY_VIOLATION"
    assert caught.value.field == "execution_policy.allowed_http_origins"


def test_environment_policy_cannot_be_overridden(tmp_path, monkeypatch):
    root = init_project(tmp_path / "project")
    forced = _policy(root)
    other = tmp_path / "other.json"
    other.write_text(forced.read_text())
    monkeypatch.setenv("EASYTEST_EXECUTION_POLICY", str(forced))

    with pytest.raises(ConfigurationError, match="cannot be overridden"):
        CaseRunner(root, execution_policy=other)
