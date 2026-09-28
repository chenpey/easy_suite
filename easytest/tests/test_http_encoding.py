import json
from io import BytesIO
from urllib.parse import parse_qs

import pytest
import requests

from easytest.transport.http import HttpClient


@pytest.fixture
def captured(monkeypatch):
    prepared = []

    def send(_session, request, **_options):
        prepared.append(request)
        response = requests.Response()
        response.status_code = 200
        response._content = b'{"ok":true}'
        response._content_consumed = True
        response.url = request.url
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    return prepared


@pytest.mark.parametrize("data", [{"name": "demo"}, [("name", "demo")]])
def test_http_data_encodes_form(captured, data):
    with HttpClient(trust_env=False) as client:
        client.request("POST", "https://example.invalid", data=data)
    assert len(captured) == 1
    assert captured[0].headers["Content-Type"] == "application/x-www-form-urlencoded"
    assert parse_qs(captured[0].body) == {"name": ["demo"]}


def test_http_json_body_encodes_json(captured):
    with HttpClient(trust_env=False) as client:
        client.request("POST", "https://example.invalid", json_body={"name": "demo"})
    assert captured[0].headers["Content-Type"] == "application/json"
    assert json.loads(captured[0].body) == {"name": "demo"}


def test_http_multipart_keeps_regular_fields_and_file(captured):
    with BytesIO(b"FILE_CONTENT") as stream, HttpClient(trust_env=False) as client:
        client.request("POST", "https://example.invalid", data={"name": "demo"},
                       files={"upload": ("demo.txt", stream, "text/plain")})
    request = captured[0]
    assert request.headers["Content-Type"].startswith("multipart/form-data; boundary=")
    assert b'name="name"\r\n\r\ndemo\r\n' in request.body
    assert b'name="upload"; filename="demo.txt"' in request.body
    assert b"FILE_CONTENT" in request.body
