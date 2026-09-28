import gzip
import hashlib
import json
from dataclasses import asdict, replace
from io import BytesIO

import pytest
import requests
from urllib3.response import HTTPResponse

from easytest.models import ConfigurationError
from easytest.transport.http import HttpClient, ResponseTooLarge


class Adapter(requests.adapters.BaseAdapter):
    def __init__(self, bodies, *, redirect=False, compressed=False):
        self.bodies = iter(bodies)
        self.redirect = redirect
        self.compressed = compressed
        self.calls = []
        self.responses = []

    def send(self, request, **kwargs):
        self.calls.append((request, kwargs))
        response = requests.Response()
        response.url = request.url
        response.request = request
        response.status_code = 302 if self.redirect and len(self.calls) == 1 else 200
        response.headers = requests.structures.CaseInsensitiveDict(
            {"Location": "/final"} if response.status_code == 302 else {}
        )
        if self.compressed:
            response.headers["Content-Encoding"] = "gzip"
        response.raw = HTTPResponse(
            body=BytesIO(next(self.bodies)), headers=response.headers, preload_content=False,
        )
        self.responses.append(response)
        return response

    def close(self):
        pass


def client_for(adapter):
    session = requests.Session()
    session.trust_env = False
    session.mount("https://", adapter)
    return HttpClient(session)


@pytest.mark.parametrize("stream", [True, False])
def test_response_exact_limit_decodes_json_and_hashes(stream):
    body = b'{"ok":true}'
    adapter = Adapter([body])
    with client_for(adapter) as client:
        output = client.request("GET", "https://example.invalid", max_response_bytes=len(body), stream=stream)
    assert output["body"] == {"ok": True}
    assert output["response_bytes"] == len(body)
    assert output["sha256"] == hashlib.sha256(body).hexdigest()
    assert output["hash_scope"] == "complete"
    assert not output["truncated"]
    assert adapter.calls[0][1]["stream"] is True
    assert adapter.responses[0].raw.closed


@pytest.mark.parametrize("compressed", [False, True])
def test_response_over_limit_stops_and_closes_without_retry(compressed):
    body = b"x" * 100000
    adapter = Adapter([gzip.compress(body) if compressed else body], compressed=compressed)
    with client_for(adapter) as client, pytest.raises(ResponseTooLarge) as caught:
        client.request("GET", "https://example.invalid", max_response_bytes=32, retry=3)
    data = caught.value.response_metadata
    assert caught.value.code == "HTTP_RESPONSE_TOO_LARGE"
    assert data["body"] is None
    assert data["observed_bytes"] == 33
    assert data["hash_scope"] == "observed_prefix"
    assert data["sha256"] == hashlib.sha256(body[:33]).hexdigest()
    assert len(adapter.calls) == 1
    assert adapter.responses[0].raw.closed


def test_oversized_redirect_body_is_bounded_before_following():
    adapter = Adapter([b"x" * 1000, b"ok"], redirect=True)
    with client_for(adapter) as client, pytest.raises(ResponseTooLarge):
        client.request("GET", "https://example.invalid", max_response_bytes=32)
    assert len(adapter.calls) == 1
    assert adapter.responses[0].raw.closed


def test_small_redirect_and_non_json_text_remain_supported():
    adapter = Adapter([b"redirect", "你好".encode()], redirect=True)
    with client_for(adapter) as client:
        result = client.request("GET", "https://example.invalid", max_response_bytes=32)
    assert result["body"] == "你好"
    assert len(adapter.calls) == 2
    assert all(response.raw.closed for response in adapter.responses)


@pytest.mark.parametrize("limit", [0, -1, True, 1.5, "10", None, 64 * 1024 * 1024 + 1])
def test_invalid_limit_fails_before_transport(limit):
    adapter = Adapter([])
    with client_for(adapter) as client, pytest.raises(ConfigurationError, match="max_response_bytes"):
        client.request("GET", "https://example.invalid", max_response_bytes=limit)
    assert adapter.calls == []


@pytest.mark.parametrize("failure", [requests.ConnectionError("read failed"), KeyboardInterrupt()])
def test_stream_failure_closes_response(monkeypatch, failure):
    response = requests.Response()
    response.status_code = 200
    response.raw = HTTPResponse(body=BytesIO(b"unused"), preload_content=False)

    def chunks(*_args, **_kwargs):
        yield b"first"
        raise failure

    monkeypatch.setattr(response, "iter_content", chunks)
    session = requests.Session()
    monkeypatch.setattr(session, "request", lambda *_a, **_k: response)
    with HttpClient(session) as client, pytest.raises(type(failure)):
        client.request("GET", "https://example.invalid")
    assert response.raw.closed


def test_direct_executor_cannot_raise_operation_limit(tmp_path):
    from easytest.executors.http import HttpExecutor
    from easytest.models import Case, RunContext

    adapter = Adapter([b"ok"])
    context = RunContext(Case("direct"), tmp_path, "read", {})
    with client_for(adapter) as client:
        executor = HttpExecutor(client=client)
        with pytest.raises(ConfigurationError, match="exceeds"):
            executor.execute(
                "direct", {"url": "https://example.invalid", "max_response_bytes": 16},
                {"max_response_bytes": 32}, context,
            )
    assert adapter.calls == []


@pytest.mark.parametrize("limit", [8, 32, 0])
def test_dynamic_limit_is_deferred_then_checked_before_transport(tmp_path, monkeypatch, limit):
    from easytest.models import Case, Step
    from easytest.runtime.runner import CaseRunner
    from easytest.starter import init_project

    root = init_project(tmp_path / "project")
    path = root / "config/runtime.json"
    runtime = json.loads(path.read_text())
    runtime["http"] = {"max_response_bytes": 16}
    path.write_text(json.dumps(runtime))
    case = Case("dynamic", steps=(
        Step("settings", 1, "http", "http.ping",
             mock={"kind": "response", "response": {"limit": limit}}),
        Step("request", 2, "http", "http.ping",
             request={"max_response_bytes": "${steps.settings.limit}"}),
    ))
    adapter = Adapter([b"ok"])
    monkeypatch.setattr(requests.Session, "get_adapter", lambda *_a, **_kw: adapter)
    with CaseRunner(root, profile="live") as runner:
        assert runner.preflight([case]).case_count == 1
        if limit == 8:
            assert runner.run(case)["request"].output["body"] == "ok"
            assert len(adapter.calls) == 1
        else:
            with pytest.raises(ConfigurationError, match="max_response_bytes"):
                runner.run(case)
            assert runner.last_report.steps[0].status == "passed"
            assert runner.last_report.steps[1].status == "failed"
            assert adapter.calls == []


@pytest.mark.parametrize("entrypoint", ["runner", "cli", "notebook"])
def test_oversize_entrypoints_report_failure_before_assertions_and_snapshots(
    tmp_path, monkeypatch, capsys, entrypoint,
):
    from easytest.cases.loader import load_project_cases
    from easytest.cli import main
    from easytest.notebook import NotebookSession
    from easytest.runtime.runner import CaseRunner
    from easytest.snapshots.manager import SnapshotManager
    from easytest.starter import init_project

    root = init_project(tmp_path / "project")
    path = root / "config/runtime.json"
    runtime = json.loads(path.read_text())
    runtime["http"] = {"max_response_bytes": 16}
    path.write_text(json.dumps(runtime))
    adapter = Adapter([b"private-response-body" * 50])
    monkeypatch.setattr(requests.Session, "get_adapter", lambda *_args, **_kwargs: adapter)
    reached = []
    monkeypatch.setattr("easytest.runtime.runner.assert_expectations", lambda *_a: reached.append("assertion"))
    monkeypatch.setattr(SnapshotManager, "process", lambda *_a, **_kw: reached.append("snapshot"))

    if entrypoint == "cli":
        with pytest.raises(ResponseTooLarge):
            main(["run", "--root", str(root), "--profile", "live",
                  "--result", "artifacts/result.json"])
        result = json.loads(capsys.readouterr().out)
        assert result["status"] == "failed"
        assert result == json.loads((root / "artifacts/result.json").read_text())
        record = result["data"]["cases"][0]
        assert (root / "artifacts/report.html").is_file()
    elif entrypoint == "notebook":
        with NotebookSession(root, profile="live") as session:
            with pytest.raises(ResponseTooLarge):
                session.run_step(executor="http", operation="http.ping")
            record = asdict(session.runner.last_report)
            assert session.write_report().is_file()
    else:
        case = load_project_cases(root / "cases", write_compiled=False)[0]
        case = replace(case, steps=(*case.steps, replace(case.steps[0], id="later", order=2)))
        with CaseRunner(root, profile="live") as runner:
            with pytest.raises(ResponseTooLarge):
                runner.run(case)
            record = asdict(runner.last_report)
        assert record["steps"][1]["status"] == "not_run"

    assert record["status"] == "failed"
    step = record["steps"][0]
    assert step["phase"] == "execute"
    assert step["errors"][0]["code"] == "HTTP_RESPONSE_TOO_LARGE"
    assert step["response"]["observed_bytes"] == 17
    assert step["response"]["hash_scope"] == "observed_prefix"
    assert "private-response-body" not in json.dumps(record)
    assert reached == []
    assert len(adapter.calls) == 1
    assert adapter.responses[0].raw.closed
