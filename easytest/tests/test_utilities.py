from __future__ import annotations

from dataclasses import dataclass

import pytest
import requests

from easytest.models import ConfigurationError, ContractError
from easytest.transport.browser_auth import (
    BrowserCookieError,
    cookie_header,
    get_cookies,
)
from easytest.transport.http import HttpClient, RetryPolicy
from easytest.runtime.values import render_templates


@pytest.mark.parametrize(
    "value",
    ["${foo.${bar}}", "${foo${bar}}", "${${bar}}", "x${foo.${bar}}y"],
)
def test_nested_template_placeholders_are_rejected(value) -> None:
    with pytest.raises(ContractError, match="invalid template placeholder syntax"):
        render_templates(value, {"foo": {"x": 1}, "bar": "x"})


@dataclass
class _Cookie:
    name: str
    value: str


def test_cookie_adapter_uses_injected_loader_without_exposing_secrets() -> None:
    calls = []

    def loader(**kwargs):
        calls.append(kwargs)
        return [_Cookie("session", "secret"), _Cookie("locale", "zh")]

    cookies = get_cookies("https://service.example.com/path", loader=loader)

    assert cookies == {"session": "secret", "locale": "zh"}
    assert calls == [{"domain_name": "service.example.com"}]
    assert (
        cookie_header(
            "service.example.com",
            names={"locale"},
            loader=loader,
        )
        == "locale=zh"
    )


def test_cookie_adapter_rejects_invalid_domain() -> None:
    with pytest.raises(BrowserCookieError, match="invalid"):
        get_cookies("://", loader=lambda **_kwargs: [])


class _Response:
    def __init__(self, status_code: int, body=None) -> None:
        self.status_code = status_code
        self.headers = {}
        self.text = ""
        self.url = "https://example.invalid/resource"
        self.body = body if body is not None else {"status": status_code}
        self.closed = False

    def json(self):
        return self.body

    def iter_content(self, chunk_size):
        import json

        yield json.dumps(self.body).encode()

    def close(self) -> None:
        self.closed = True

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code), response=self)


class _Session:
    def __init__(self, outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls = 0
        self.closed = False
        self.trust_env = True

    def request(self, *_args, **_kwargs):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def close(self) -> None:
        self.closed = True


def test_http_client_retries_idempotent_request() -> None:
    first = _Response(503)
    session = _Session([first, _Response(200, {"ok": True})])
    client = HttpClient(session)

    result = client.request(
        "GET",
        "https://example.invalid/resource",
        retry=RetryPolicy(retries=1, backoff_seconds=0, jitter_seconds=0),
    )

    assert result["attempts"] == 2
    assert result["body"] == {"ok": True}
    assert first.closed is True


def test_http_client_does_not_retry_post_by_default() -> None:
    session = _Session([requests.ConnectionError("offline")])
    client = HttpClient(session)

    with pytest.raises(requests.ConnectionError, match="offline"):
        client.request(
            "POST",
            "https://example.invalid",
            retry={"retries": 3},
        )

    assert session.calls == 1


def test_retry_policy_rejects_ambiguous_or_negative_configuration() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        RetryPolicy.from_value({"retries": -1})
    with pytest.raises(TypeError, match="mapping"):
        RetryPolicy.from_value(1)
    with pytest.raises(TypeError, match="collection"):
        RetryPolicy(methods="GET")
    with pytest.raises(TypeError, match="integer"):
        RetryPolicy.from_value({"retries": "1"})
    with pytest.raises(TypeError, match="HTTP status integers"):
        RetryPolicy.from_value({"status_codes": ["503"]})
    with pytest.raises(TypeError, match="unknown retry policy fields"):
        RetryPolicy.from_value({"retry_count": 1})


def test_borrowed_session_preserves_settings_and_ownership():
    session = _Session([])
    session.trust_env = False
    with HttpClient(session) as client:
        assert client.session is session
        client.configure_trust_env(False)
        with pytest.raises(ConfigurationError, match="conflicts"):
            client.configure_trust_env(True)
    assert session.trust_env is False
    assert session.closed is False
    with pytest.raises(ConfigurationError, match="conflicts"):
        HttpClient(session, trust_env=True)
    assert session.trust_env is False


def test_owned_session_is_closed_only_once(monkeypatch):
    from unittest.mock import Mock

    session = Mock(trust_env=True)
    monkeypatch.setattr(requests, "Session", lambda: session)
    with HttpClient(trust_env=False) as client:
        assert session.trust_env is False
    client.close()
    session.close.assert_called_once()
