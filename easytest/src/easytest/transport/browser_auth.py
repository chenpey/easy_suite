from __future__ import annotations

from collections.abc import Callable, Iterable
from http.cookiejar import Cookie
from urllib.parse import urlparse

from easytest.models import ConfigurationError


class BrowserCookieError(ConfigurationError):
    """Raised when browser cookies cannot be loaded safely."""


CookieLoader = Callable[..., Iterable[Cookie]]


def _domain(value: str) -> str:
    parsed = urlparse(value if "://" in value else f"https://{value}")
    if not parsed.hostname:
        raise BrowserCookieError(f"invalid cookie URL or domain: {value!r}")
    return parsed.hostname


def _browser_loader(browser: str) -> CookieLoader:
    try:
        import browser_cookie3
    except ImportError as exc:
        raise BrowserCookieError(
            "browser cookie access requires: uv sync --extra browser-auth"
        ) from exc

    loaders = {
        "chrome": browser_cookie3.chrome,
        "chromium": browser_cookie3.chromium,
        "edge": browser_cookie3.edge,
        "firefox": browser_cookie3.firefox,
    }
    try:
        return loaders[browser.lower()]
    except KeyError as exc:
        raise BrowserCookieError(
            f"unsupported browser {browser!r}; expected one of {sorted(loaders)}"
        ) from exc


def get_cookies(
    url: str,
    browser: str = "chrome",
    *,
    loader: CookieLoader | None = None,
) -> dict[str, str]:
    """Read cookies for one domain through the optional browser-cookie3 adapter."""
    domain = _domain(url)
    selected_loader = loader or _browser_loader(browser)
    try:
        cookie_jar = selected_loader(domain_name=domain)
    except Exception as exc:
        raise BrowserCookieError(
            f"failed to read {browser} cookies for {domain}"
        ) from exc

    result: dict[str, str] = {}
    for cookie in cookie_jar:
        name = getattr(cookie, "name", None)
        value = getattr(cookie, "value", None)
        if name and value is not None:
            result[str(name)] = str(value)
    return result


def get_cookie_value(
    domain: str,
    name: str,
    browser: str = "chrome",
    *,
    loader: CookieLoader | None = None,
) -> str | None:
    return get_cookies(domain, browser, loader=loader).get(name)


def cookie_header(
    url: str,
    browser: str = "chrome",
    *,
    names: set[str] | None = None,
    loader: CookieLoader | None = None,
) -> str:
    cookies = get_cookies(url, browser, loader=loader)
    if names is not None:
        cookies = {key: value for key, value in cookies.items() if key in names}
    return "; ".join(f"{key}={value}" for key, value in sorted(cookies.items()))
