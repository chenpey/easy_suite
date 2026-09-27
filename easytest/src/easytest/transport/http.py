from __future__ import annotations

import random
import time
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from typing import Any

import requests

from easytest.models import ConfigurationError

DEFAULT_RETRY_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DEFAULT_RETRY_STATUS_CODES = frozenset({429, 502, 503, 504})


@dataclass(frozen=True)
class RetryPolicy:
    retries: int = 0
    backoff_seconds: float = 0.25
    jitter_seconds: float = 0.1
    methods: frozenset[str] = field(default_factory=lambda: DEFAULT_RETRY_METHODS)
    status_codes: frozenset[int] = field(
        default_factory=lambda: DEFAULT_RETRY_STATUS_CODES
    )

    def __post_init__(self) -> None:
        if self.retries < 0:
            raise ValueError("retry count must be non-negative")
        if self.backoff_seconds < 0 or self.jitter_seconds < 0:
            raise ValueError("retry delays must be non-negative")
        if isinstance(self.methods, (str, bytes)):
            raise TypeError("retry methods must be a collection of method names")
        if isinstance(self.status_codes, (str, bytes)):
            raise TypeError("retry status codes must be a collection of integers")
        object.__setattr__(
            self,
            "methods",
            frozenset(str(method).upper() for method in self.methods),
        )
        object.__setattr__(
            self,
            "status_codes",
            frozenset(int(status) for status in self.status_codes),
        )

    @classmethod
    def from_value(cls, value: RetryPolicy | Mapping[str, Any] | int | None):
        if value is None:
            return cls()
        if isinstance(value, cls):
            return value
        if isinstance(value, int):
            return cls(retries=value)
        if not isinstance(value, Mapping):
            raise TypeError("retry policy must be an integer or mapping")
        return cls(
            retries=int(value.get("retries", 0)),
            backoff_seconds=float(value.get("backoff_seconds", 0.25)),
            jitter_seconds=float(value.get("jitter_seconds", 0.1)),
            methods=frozenset(
                str(method).upper()
                for method in value.get("methods", DEFAULT_RETRY_METHODS)
            ),
            status_codes=frozenset(
                int(status)
                for status in value.get("status_codes", DEFAULT_RETRY_STATUS_CODES)
            ),
        )


class HttpClient:
    def __init__(
        self,
        session: requests.Session | None = None,
        *,
        trust_env: bool | None = None,
    ) -> None:
        if trust_env is not None and not isinstance(trust_env, bool):
            raise ConfigurationError("HTTP trust_env must be a boolean")
        self.session = session if session is not None else requests.Session()
        self._owns_session = session is None
        self._closed = False
        if trust_env is not None:
            self.configure_trust_env(trust_env)

    def configure_trust_env(self, value: bool, *, borrowed: bool = False) -> None:
        if not isinstance(value, bool):
            raise ConfigurationError("HTTP trust_env must be a boolean")
        if not self._owns_session or borrowed:
            if self.session.trust_env != value:
                raise ConfigurationError("trust_env conflicts with borrowed HTTP client/session")
        else:
            self.session.trust_env = value

    def close(self) -> None:
        if self._owns_session and not self._closed:
            self._closed = True
            self.session.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def request(
        self,
        method: str,
        url: str,
        *,
        path: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        query: Mapping[str, Any] | None = None,
        data: Any = None,
        json_body: Any = None,
        retry: RetryPolicy | Mapping[str, Any] | int | None = None,
        expected_status: int | Collection[int] | None = None,
        raise_for_status: bool = False,
        timeout: float | tuple[float, float] = 10,
        **kwargs: Any,
    ) -> dict[str, Any]:
        method = method.upper()
        if path:
            try:
                url = url.format_map(dict(path))
            except KeyError as exc:
                raise ValueError(f"missing URL path parameter: {exc.args[0]}") from exc

        policy = RetryPolicy.from_value(retry)
        attempts = policy.retries + 1 if method in policy.methods else 1
        request_kwargs = {"timeout": timeout, **kwargs}
        if headers:
            request_kwargs["headers"] = dict(headers)
        if query:
            request_kwargs["params"] = dict(query)
        if json_body is not None:
            request_kwargs["json"] = json_body
        if data is not None:
            request_kwargs["data"] = data

        started = time.perf_counter()
        response = None
        for attempt in range(1, attempts + 1):
            try:
                response = self.session.request(method, url, **request_kwargs)
                if (
                    response.status_code in policy.status_codes
                    and attempt < attempts
                ):
                    response.close()
                    self._sleep(policy, attempt)
                    continue
                break
            except (requests.ConnectionError, requests.Timeout):
                if attempt >= attempts:
                    raise
                self._sleep(policy, attempt)

        if response is None:
            raise RuntimeError("HTTP request ended without a response")
        try:
            if expected_status is not None:
                if isinstance(expected_status, (str, bytes)):
                    raise TypeError(
                        "expected_status must be an integer or collection of integers"
                    )
                allowed = (
                    {expected_status}
                    if isinstance(expected_status, int)
                    else {int(value) for value in expected_status}
                )
                if response.status_code not in allowed:
                    raise requests.HTTPError(
                        f"unexpected HTTP status {response.status_code}; "
                        f"expected {sorted(allowed)}",
                        response=response,
                    )
            elif raise_for_status:
                response.raise_for_status()

            try:
                body: Any = response.json()
            except ValueError:
                body = response.text
            return {
                "status_code": response.status_code,
                "headers": dict(response.headers),
                "body": body,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
                "url": getattr(response, "url", url),
                "attempts": attempt,
            }
        finally:
            response.close()

    @staticmethod
    def _sleep(policy: RetryPolicy, attempt: int) -> None:
        delay = policy.backoff_seconds * (2 ** (attempt - 1))
        delay += random.uniform(0, policy.jitter_seconds)
        time.sleep(delay)


def send_http(
    method: str,
    url: str,
    path: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    query: dict[str, Any] | None = None,
    data: Any = None,
    retry_count: int = 0,
    full_response: bool = False,
    verify: bool = True,
    timeout: int | float = 180,
    *,
    retry_methods: Collection[str] = DEFAULT_RETRY_METHODS,
    trust_env: bool = True,
    json_body: Any = None,
) -> dict[str, Any]:
    """Send HTTP; data is form/raw content, json_body is explicit JSON."""
    retry = RetryPolicy(
        retries=retry_count,
        methods=frozenset(method.upper() for method in retry_methods),
    )
    with HttpClient(trust_env=trust_env) as client:
        response = client.request(
            method,
            url,
            path=path,
            headers=headers,
            query=query,
            data=data,
            json_body=json_body,
            retry=retry,
            timeout=timeout,
            verify=verify,
        )
    if full_response:
        return response
    return {
        "status_code": response["status_code"],
        "body": response["body"],
        "elapsed_ms": response["elapsed_ms"],
        "attempts": response["attempts"],
    }
