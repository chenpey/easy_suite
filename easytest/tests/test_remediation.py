from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from unittest.mock import Mock

import pytest
import requests

from easytest.cases.loader import load_cases
from easytest.cli import main
from easytest.config import ProjectConfig
from easytest.executors.http import HttpExecutor
from easytest.models import ConfigurationError, ContractError, ExecutionResult, RunContext
from easytest.runtime.observability import REDACTED, redact
from easytest.runtime.runner import CaseRunner
from easytest.snapshots.manager import SnapshotManager
from easytest.starter import init_project
from easytest.transport.http import HttpClient


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.delenv("RUN_MODE", raising=False)
    root = init_project(tmp_path / "project")
    (root / "config/snapshots.json").write_text(json.dumps({
        "profiles": {"default": {"response_default": {}}},
    }))
    return root, load_cases(root / "cases/demo.json")[0]


def test_assertion_secrets_never_enter_events_logs_or_reports(project, caplog, capsys):
    root, case = project
    (root / "config/runtime.json").write_text(json.dumps({
        "default_profile": "offline-strict", "observability": {"emit_stdout": True},
    }))
    secrets = ["SYNTHETIC_ACTUAL_SECRET", "SYNTHETIC_EXPECTED_SECRET"]
    case = replace(case, steps=(replace(case.steps[0],
        mock={"response": {"token": secrets[0]}},
        expect={"$.token": secrets[1]},
    ),))
    caplog.set_level("INFO", logger="easytest.events")
    with CaseRunner(root) as runner:
        with pytest.raises(AssertionError):
            runner.run(case)
        event = next(event for event in runner.last_events if event["event"] == "step.error")
        assert event["error"]["kind"] == "assertion"
        serialized = json.dumps(runner.last_events) + str(runner.last_report)
    serialized += caplog.text + capsys.readouterr().out
    assert all(secret not in serialized for secret in secrets)


@pytest.mark.parametrize("case_id", [".", ".."])
def test_dot_case_ids_blocked_in_runner_and_direct_snapshot_manager(project, case_id):
    root, case = project
    case = replace(case, id=case_id)
    with CaseRunner(root, run_mode="write") as runner:
        with pytest.raises(ContractError, match="case.id"):
            runner.run(case)
    context = RunContext(case, root, "write", {})
    with pytest.raises(ConfigurationError, match="unsafe case id"):
        SnapshotManager(ProjectConfig(root)).process(
            spec={"name": "escaped"}, result=ExecutionResult("http", "ping", {}),
            context=context, step_id="ping",
        )
    assert not (root / "escaped.json").exists()


@pytest.mark.parametrize("mode", ["read", "write", "baseline"])
@pytest.mark.parametrize("link_kind", ["directory", "file"])
def test_snapshot_symlinks_cannot_escape_root(project, tmp_path, monkeypatch, mode, link_kind):
    root, case = project
    monkeypatch.setenv("CONFIRM_BASELINE", "1")
    outside = tmp_path / "outside"
    outside.mkdir()
    target = outside / "ping.json"
    target.write_text('{"secret":"unchanged"}')
    snapshots = root / "snapshots"
    snapshots.mkdir()
    case_dir = snapshots / case.id
    if link_kind == "directory":
        case_dir.symlink_to(outside, target_is_directory=True)
    else:
        case_dir.mkdir()
        (case_dir / "ping.json").symlink_to(target)
    case = replace(case, steps=(replace(case.steps[0], snapshot={}),))
    with CaseRunner(root, run_mode=mode) as runner:
        with pytest.raises(ConfigurationError, match="escapes"):
            runner.run(case)
        with pytest.raises(ConfigurationError, match="escapes"):
            runner.snapshots.process(
                spec={}, result=ExecutionResult("http", "ping", {}),
                context=RunContext(case, root, mode, {}), step_id="ping",
            )
    assert target.read_text() == '{"secret":"unchanged"}'


def test_redaction_does_not_visit_discarded_or_sensitive_values():
    class Guarded(Mapping):
        def __iter__(self):
            return iter(["token", *[f"row{i}" for i in range(100)]])

        def __len__(self):
            return 101

        def __getitem__(self, key):
            assert key == "row0", "redaction read a sensitive or discarded value"
            return 7

    assert redact(Guarded(), max_items=2) == {
        "token": REDACTED, "row0": 7, "_truncated_items": 99,
    }

    class Huge(Sequence):
        def __len__(self):
            return 100_000

        def __getitem__(self, index):
            assert type(index) is int and index < 50
            return {"n": index}

    output = redact(Huge())
    assert len(output) == 51
    assert output[-1] == "<truncated-items:99950>"


def test_redaction_handles_dataclasses_depth_and_large_encoded_json():
    class Secret:
        def __str__(self):
            raise AssertionError("must not stringify")

    @dataclass
    class Record:
        token: object
        value: int

    assert redact(Record(Secret(), 7)) == {"token": REDACTED, "value": 7}
    assert redact({"email": Secret()}) == {"email": REDACTED}
    assert redact({"unknown": Secret()}) == {"unknown": "<Secret>"}
    payload = json.dumps({"password": "HIDDEN", "rows": [0] * 100_000})
    assert redact(payload).startswith("<truncated-string:")
    assert redact(b"x" * 100_000) == "<truncated-bytes:100000>"
    encoded = json.dumps({"next": json.dumps({"password": "HIDDEN"})})
    assert redact(encoded, max_depth=2) == {"next": "<max-depth:str>"}
    nested = {}
    for _ in range(2000):
        nested = {"child": nested}
    assert "max-depth" in json.dumps(redact(nested))
    cyclic = {}
    cyclic["self"] = cyclic
    with pytest.raises(ValueError, match="cyclic"):
        redact(cyclic)


def test_project_environment_isolation_reaches_http_rpc_and_database(tmp_path, monkeypatch):
    for name in ("EASYTEST_SITE", "EASYTEST_KEY", "RUN_MODE", "CONFIRM_BASELINE"):
        monkeypatch.delenv(name, raising=False)
    runners = []
    clients = []
    try:
        for suffix in ("a", "b"):
            root = init_project(tmp_path / suffix)
            (root / ".env").write_text(
                f"EASYTEST_SITE=https://{suffix}.invalid\nEASYTEST_KEY={suffix}-secret\n"
                "RUN_MODE=write\nCONFIRM_BASELINE=1\n"
            )
            (root / "config/runtime.json").write_text(json.dumps({
                "database": {"connections": {"default": {
                    "driver": "mysql", "host": "${EASYTEST_SITE}", "password_env": "EASYTEST_KEY",
                }}},
            }))
            (root / "config/operations.json").write_text(json.dumps({"operations": {
                "http.ping": {"executor": "http", "url": "${EASYTEST_SITE}/http",
                              "headers": {"Authorization": "${EASYTEST_KEY}"}},
                "rpc.ping": {"executor": "rpc", "endpoint": "${EASYTEST_SITE}/rpc",
                             "auth": {"token": "${EASYTEST_KEY}"}},
            }}))
            client = Mock()
            client.request.return_value = {"status_code": 200, "body": {"ok": True}}
            clients.append(client)
            runners.append(CaseRunner(
                root, profile="live", executors={"http": HttpExecutor(client=client)},
                rpc_handlers={"rpc.ping": lambda **kw: [kw["endpoint"], kw["auth"]]},
            ))
        assert "EASYTEST_SITE" not in os.environ
        assert "RUN_MODE" not in os.environ
        for suffix, runner, client in zip(("a", "b"), runners, clients, strict=True):
            assert runner.config.connection("default")["password"] == f"{suffix}-secret"
            assert runner.config.connection("default")["host"] == f"https://{suffix}.invalid"
            assert runner.run_mode == "write"
            SnapshotManager._require_baseline_confirmation("baseline", runner.config.environment)
            case = load_cases(runner.root / "cases/demo.json")[0]
            rpc = replace(case.steps[0], id="rpc", order=2, executor="rpc", operation="rpc.ping",
                          expect=None)
            results = runner.run(replace(case, steps=(*case.steps, rpc)))
            assert results["rpc"].output == [f"https://{suffix}.invalid/rpc", {"token": f"{suffix}-secret"}]
            assert client.request.call_args.args[1] == f"https://{suffix}.invalid/http"
            assert client.request.call_args.kwargs["headers"]["Authorization"] == f"{suffix}-secret"
        monkeypatch.setenv("EASYTEST_SITE", "https://process.invalid")
        assert all(r.config.connection("default")["host"] == "https://process.invalid" for r in runners)
        (runners[0].root / ".env").write_text("EASYTEST_SITE=https://changed.invalid\nEASYTEST_KEY=changed\n")
        monkeypatch.delenv("EASYTEST_SITE")
        assert ProjectConfig(runners[0].root).connection("default")["host"] == "https://changed.invalid"
        assert runners[1].config.connection("default")["host"] == "https://b.invalid"
    finally:
        for runner in runners:
            runner.close()


def test_dotenv_interpolation_uses_process_priority_without_mutation(project, monkeypatch):
    root, _ = project
    monkeypatch.setenv("EASYTEST_BASE", "process")
    monkeypatch.delenv("EASYTEST_DERIVED", raising=False)
    (root / ".env").write_text("EASYTEST_BASE=local\nEASYTEST_DERIVED=${EASYTEST_BASE}/path\n")
    assert ProjectConfig(root).environment["EASYTEST_DERIVED"] == "process/path"
    assert "EASYTEST_DERIVED" not in os.environ


@pytest.mark.parametrize("path", ["$.value", "value", "$.nested.value"])
def test_scenario_written_paths_are_readable(project, path):
    root, case = project
    (root / "config/operations.json").write_text(json.dumps({"operations": {
        "state.set": {"executor": "scenario", "builtin": "set"},
        "state.get": {"executor": "scenario", "builtin": "get"},
    }}))
    setter = replace(case.steps[0], executor="scenario", operation="state.set",
                     request={"path": path, "value": 7}, expect=None)
    getter = replace(setter, id="get", order=2, operation="state.get", request={"path": path},
                     expect={"$": 7})
    with CaseRunner(root, profile="live") as runner:
        assert runner.run(replace(case, steps=(setter, getter)))["get"].output == 7


@pytest.mark.parametrize("path", ["$", "items[0].value", "$.items[0]"])
def test_unsupported_state_writes_fail_before_any_execution(project, path):
    root, case = project
    operations = json.loads((root / "config/operations.json").read_text())
    operations["operations"]["state.set"] = {"executor": "scenario", "builtin": "set"}
    (root / "config/operations.json").write_text(json.dumps(operations))
    later = replace(case.steps[0], id="set", order=2, executor="scenario", operation="state.set",
                    request={"path": path, "value": 7}, expect=None)
    client = Mock()
    with CaseRunner(root, profile="live", executors={"http": HttpExecutor(client=client)}) as runner:
        with pytest.raises(ContractError, match="scenario set path"):
            runner.run(replace(case, steps=(*case.steps, later)))
    client.request.assert_not_called()


@pytest.mark.parametrize("failure", ["expected_status", "raise_for_status", "json", "text", "success"])
def test_http_always_closes_response_and_keeps_borrowed_session(failure):
    response = Mock(status_code=500, headers={}, url="https://example.invalid")
    response.json.return_value = {"ok": True}
    response.iter_content.return_value = [b'{"ok":true}']
    session = Mock()
    session.request.return_value = response
    options = {"stream": True}
    if failure == "expected_status":
        options["expected_status"] = 200
    elif failure == "raise_for_status":
        options["raise_for_status"] = True
        response.raise_for_status.side_effect = requests.HTTPError("status")
    elif failure == "json":
        response.json.side_effect = requests.ConnectionError("read")
    elif failure == "text":
        from unittest.mock import PropertyMock
        response.json.side_effect = ValueError("not json")
        type(response).text = PropertyMock(side_effect=requests.ConnectionError("read"))
    with HttpClient(session) as client:
        if failure == "success":
            assert client.request("GET", response.url, **options)["body"] == {"ok": True}
        else:
            with pytest.raises(requests.RequestException):
                client.request("GET", response.url, **options)
    response.close.assert_called_once()
    session.close.assert_not_called()


def test_retry_closes_each_response():
    responses = [Mock(status_code=503), Mock(status_code=200, headers={}, url="https://example.invalid")]
    responses[1].json.return_value = {}
    responses[1].iter_content.return_value = [b"{}"]
    session = Mock()
    session.request.side_effect = responses
    with HttpClient(session) as client:
        output = client.request("GET", "https://example.invalid", retry={
            "retries": 1, "backoff_seconds": 0, "jitter_seconds": 0,
        })
    assert output["attempts"] == 2
    for response in responses:
        response.close.assert_called_once()


@pytest.mark.parametrize("command", ["validate", "run"])
@pytest.mark.parametrize("failure", [False, True])
def test_cli_json_envelope_for_success_and_preflight_failure(project, capsys, command, failure):
    root, _ = project
    if failure:
        path = root / "cases/demo.json"
        document = json.loads(path.read_text())
        document["cases"][0]["steps"][0]["operation"] = "missing"
        path.write_text(json.dumps(document))
    args = [command, "cases/demo.json", "--root", str(root)]
    if command == "run":
        args += ["--result", "artifacts/result.json", "--no-report"]
    if failure:
        with pytest.raises(ConfigurationError):
            main(args)
    else:
        main(args)
    result = json.loads(capsys.readouterr().out)
    assert set(result) == {"schema_version", "command", "status", "data", "errors", "artifacts"}
    assert result["status"] == ("failed" if failure else "valid" if command == "validate" else "passed")
    assert bool(result["errors"]) is failure
    if failure:
        assert result["errors"][0]["case_id"] == "http.demo"
        assert result["errors"][0]["step_id"] == "ping"
        assert result["errors"][0]["source_row"] == "2"
    if command == "run":
        assert json.loads((root / "artifacts/result.json").read_text()) == result
    else:
        assert not (root / "artifacts").exists()


def test_cli_event_stream_does_not_mix_with_json_result(project, capsys):
    root, _ = project
    (root / "config/runtime.json").write_text(json.dumps({
        "default_profile": "offline-strict", "observability": {"emit_stdout": True},
    }))
    main(["run", "--root", str(root), "--no-report"])
    captured = capsys.readouterr()
    assert json.loads(captured.out)["status"] == "passed"
    assert '"event":"step.done"' in captured.err


def test_cli_result_write_failure_still_emits_failed_json(project, capsys):
    root, _ = project
    (root / "blocked").write_text("file")
    with pytest.raises(OSError):
        main(["run", "--root", str(root), "--no-report", "--result", "blocked/result.json"])
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "failed"
    assert result["errors"][-1]["phase"] == "json_result"
    assert result["artifacts"]["result"] is None


@pytest.mark.parametrize("failure", [AssertionError("PRIVATE"), KeyboardInterrupt()])
def test_cli_failure_and_interrupt_keep_pending_cases_and_safe_result(project, capsys, monkeypatch, failure):
    root, _ = project
    path = root / "cases/demo.json"
    document = json.loads(path.read_text())
    document["cases"].append({**document["cases"][0], "id": "next"})
    path.write_text(json.dumps(document))

    def fail(_self, _case):
        print("handler diagnostic")
        raise failure

    monkeypatch.setattr(CaseRunner, "run", fail)
    with pytest.raises(type(failure)) as caught:
        main(["run", "cases/demo.json", "--root", str(root), "--no-report",
              "--result", "artifacts/result.json"])
    assert caught.value is failure
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert "PRIVATE" not in output.out
    assert "handler diagnostic" in output.err
    statuses = [case["status"] for case in result["data"]["cases"]]
    assert statuses == (["failed", "failed"] if isinstance(failure, Exception) else ["interrupted", "not_run"])
    assert result["status"] == statuses[0]
    assert json.loads((root / "artifacts/result.json").read_text()) == result


@pytest.mark.parametrize("source", ["missing.json", "cases/demo.json"])
def test_cli_initialization_and_collection_errors_are_json(project, capsys, source):
    root, _ = project
    if source == "cases/demo.json":
        (root / "config/operations.json").unlink()
    with pytest.raises((ConfigurationError, ContractError)):
        main(["run", source, "--root", str(root), "--no-report"])
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "failed"
    assert result["errors"][0]["phase"] == (
        "initialization" if source == "cases/demo.json" else "collection"
    )


def test_handler_analysis_cache_is_scoped_to_one_preflight(project, monkeypatch):
    import importlib
    module = importlib.import_module("easytest.runtime.preflight")
    root, case = project
    source = root / "cached_actions.py"
    source.write_text("def one(**kwargs):\n    return 1\ndef two(**kwargs):\n    return 2\n")
    monkeypatch.syspath_prepend(str(root))
    (root / "config/operations.json").write_text(json.dumps({"operations": {
        name: {"executor": "scenario", "handler": f"cached_actions:{name}"}
        for name in ("one", "two")
    }}))
    case = replace(case, steps=tuple(
        replace(case.steps[0], id=name, order=index, executor="scenario", operation=name, expect=None)
        for index, name in enumerate(("one", "two"), 1)
    ))
    analyze = Mock(wraps=module._module_symbols)
    parse = Mock(wraps=module.ast.parse)
    module._python_symbols.cache_clear()
    monkeypatch.setattr(module, "_module_symbols", analyze)
    monkeypatch.setattr(module.ast, "parse", parse)
    with CaseRunner(root, profile="live") as runner:
        runner.preflight([case])
        assert analyze.call_count == 1
        assert parse.call_count == 1
        runner.preflight([case])
        assert analyze.call_count == 2
        assert parse.call_count == 1
        source.write_text("def one(**kwargs):\n    return 1\n")
        with pytest.raises(ConfigurationError, match="symbol is not defined"):
            runner.preflight([case])
        assert analyze.call_count == 3
        assert parse.call_count == 2
