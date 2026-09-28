import sqlite3
import time
from pathlib import Path

import pytest
from Crypto.Cipher import AES

import easytest.transport.browser_auth as get_cookies_module

MAC_V24_COOKIE = bytes.fromhex(
    "763130be5b0de5c13feb8641b10fe7278f21bc5d9484378380694b31ff825d53"
    "25779c7571370f2fa2414dbb931e9be3a59da1"
)
LINUX_V10_V24_COOKIE = bytes.fromhex(
    "7631301bb654833fa6f8a731528db92d657dc37c87544a81ba7875d068127354"
    "3b4e4f3c4235047bd285bebceda6cf35ce1efc"
)
LINUX_V11_V24_COOKIE = bytes.fromhex(
    "7631311dff3609858afe22d1aff064c080c971b1deafc7f14033c2c16d5843be"
    "da585075d28256e4fe2d56530827dbfa1a889f"
)
WINDOWS_V10_V24_COOKIE = bytes.fromhex(
    "763130000102030405060708090a0b5394ff40ee0d0a96ffdba39d8f81fdddc4"
    "deb4f7bef0042ffb174c70c6de70bb48278fc3ee25aa359232f80f141437f69c"
    "4398051d120e5786a3106b72f7"
)
EXPECTED_COOKIE_VALUE = "I7!?A中文✓"
MAC_V23_COOKIE = bytes.fromhex("763130f2295ee26eafb74a00737695ac40e565")
MAC_INVALID_PADDING_COOKIE = bytes.fromhex(
    "763130c9f9d215dfe3fcea9f5f48b78c27252a61339f8511ba847e3060c0caa0"
    "8c030c40ff95d513a6f5ff88ba2800c2a43542"
)
MAC_INVALID_UTF8_COOKIE = bytes.fromhex(
    "763130c9f9d215dfe3fcea9f5f48b78c27252a61339f8511ba847e3060c0caa0"
    "8c030cff26e1f9c8eb647ea90f4abb4cee7273"
)


@pytest.fixture(autouse=True)
def clear_cookie_caches() -> None:
    for name in (
        "_derive_key",
        "_get_macos_password",
        "_get_linux_v11_password",
        "_get_windows_key",
    ):
        function = getattr(get_cookies_module, name, None)
        if function is not None and hasattr(function, "cache_clear"):
            function.cache_clear()


def _create_cookie_db(base: Path, profile: str = "Default", *, version: int = 24) -> Path:
    db_path = base / profile / "Network" / "Cookies"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE cookies (
            creation_utc INTEGER NOT NULL,
            host_key TEXT NOT NULL,
            top_frame_site_key TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL DEFAULT '/',
            expires_utc INTEGER NOT NULL DEFAULT 0,
            is_secure INTEGER NOT NULL DEFAULT 0,
            has_expires INTEGER NOT NULL DEFAULT 0,
            encrypted_value BLOB NOT NULL DEFAULT X''
        );
        """
    )
    connection.execute("INSERT INTO meta(key, value) VALUES ('version', ?)", (str(version),))
    connection.commit()
    connection.close()
    return db_path


def _insert_cookie(
    db_path: Path,
    *,
    host_key: str,
    name: str,
    value: str = "",
    encrypted_value: bytes = b"",
    path: str = "/",
    expires_utc: int = 0,
    is_secure: bool = False,
    top_frame_site_key: str = "",
    creation_utc: int = 1,
) -> None:
    connection = sqlite3.connect(db_path)
    connection.execute(
        """
        INSERT INTO cookies(
            creation_utc, host_key, top_frame_site_key, name, value, path,
            expires_utc, is_secure, has_expires, encrypted_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            creation_utc,
            host_key,
            top_frame_site_key,
            name,
            value,
            path,
            expires_utc,
            int(is_secure),
            int(bool(expires_utc)),
            encrypted_value,
        ),
    )
    connection.commit()
    connection.close()


def _configure_browser(monkeypatch: pytest.MonkeyPatch, base: Path, platform_name: str) -> None:
    config = {
        "base": str(base),
        "state": "Local State",
        "keychain": ("Chrome Safe Storage", "Chrome"),
        "linux_application": "chrome",
        "linux_keyring": "Chrome",
    }
    monkeypatch.setitem(get_cookies_module.BROWSER_PATHS["chrome"], platform_name, config)
    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: platform_name)


def _webkit_timestamp(seconds_from_now: int) -> int:
    return (
        get_cookies_module._WEBKIT_EPOCH_OFFSET_US
        + time.time_ns() // 1_000
        + seconds_from_now * 1_000_000
    )


def test_cross_platform_known_answer_vectors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "darwin")
    monkeypatch.setattr(
        get_cookies_module, "_get_macos_password", lambda _browser: b"test safe storage"
    )
    assert (
        get_cookies_module._decrypt_cookie_value(MAC_V24_COOKIE, "chrome", ".example.com", 24)
        == EXPECTED_COOKIE_VALUE
    )

    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "linux")
    assert (
        get_cookies_module._decrypt_cookie_value(LINUX_V10_V24_COOKIE, "chrome", ".example.com", 24)
        == EXPECTED_COOKIE_VALUE
    )
    monkeypatch.setattr(
        get_cookies_module, "_get_linux_v11_password", lambda _browser: b"linux secret"
    )
    assert (
        get_cookies_module._decrypt_cookie_value(LINUX_V11_V24_COOKIE, "chrome", ".example.com", 24)
        == EXPECTED_COOKIE_VALUE
    )

    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "windows")
    monkeypatch.setattr(get_cookies_module, "_get_windows_key", lambda _browser: bytes(range(32)))
    assert (
        get_cookies_module._decrypt_cookie_value(
            WINDOWS_V10_V24_COOKIE, "chrome", ".example.com", 24
        )
        == EXPECTED_COOKIE_VALUE
    )


def test_strict_decryption_rejects_wrong_host_and_v20(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "darwin")
    monkeypatch.setattr(
        get_cookies_module, "_get_macos_password", lambda _browser: b"test safe storage"
    )

    with pytest.raises(get_cookies_module.CookieDecryptionError, match="host_key"):
        get_cookies_module._decrypt_cookie_value(MAC_V24_COOKIE, "chrome", ".wrong.example.com", 24)

    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "windows")
    with pytest.raises(get_cookies_module.UnsupportedCookieEncryptionError, match="v20"):
        get_cookies_module._decrypt_cookie_value(
            b"v20" + b"encrypted", "chrome", ".example.com", 24
        )

    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "linux")
    with pytest.raises(get_cookies_module.UnsupportedCookieEncryptionError, match="v12"):
        get_cookies_module._decrypt_cookie_value(
            b"v12" + b"encrypted", "chrome", ".example.com", 24
        )


def test_macos_v23_and_strict_cbc_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "darwin")
    monkeypatch.setattr(
        get_cookies_module, "_get_macos_password", lambda _browser: b"test-password"
    )

    assert (
        get_cookies_module._decrypt_cookie_value(MAC_V23_COOKIE, "chrome", ".example.com", 23)
        == "cookie-value"
    )
    with pytest.raises(get_cookies_module.CookieDecryptionError, match="padding"):
        get_cookies_module._decrypt_cookie_value(
            MAC_INVALID_PADDING_COOKIE, "chrome", ".example.com", 24
        )
    with pytest.raises(get_cookies_module.CookieDecryptionError, match="UTF-8"):
        get_cookies_module._decrypt_cookie_value(
            MAC_INVALID_UTF8_COOKIE, "chrome", ".example.com", 24
        )


def test_windows_legacy_dpapi_receives_the_complete_blob(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    blob = b"\x01\x00legacy-dpapi-value"
    received: list[bytes] = []
    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "windows")

    def decrypt_dpapi(encrypted_value: bytes) -> bytes:
        received.append(encrypted_value)
        return b"legacy-value"

    monkeypatch.setattr(get_cookies_module, "_windows_dpapi_decrypt", decrypt_dpapi)

    assert (
        get_cookies_module._decrypt_cookie_value(blob, "chrome", ".example.com", 23)
        == "legacy-value"
    )
    assert received == [blob]


def test_strict_decryption_rejects_tampered_ciphertext(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(get_cookies_module, "_get_platform", lambda: "windows")
    monkeypatch.setattr(get_cookies_module, "_get_windows_key", lambda _browser: bytes(range(32)))
    tampered = WINDOWS_V10_V24_COOKIE[:-1] + bytes([WINDOWS_V10_V24_COOKIE[-1] ^ 1])

    with pytest.raises(get_cookies_module.CookieDecryptionError, match="解密失败"):
        get_cookies_module._decrypt_cookie_value(tampered, "chrome", ".example.com", 24)


def test_windows_gcm_accepts_an_authenticated_empty_value() -> None:
    key = bytes(range(32))
    nonce = bytes(range(12))
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(b"")

    assert get_cookies_module._decrypt_windows_gcm(nonce + ciphertext + tag, key) == b""


def test_profiles_are_listed_and_read_independently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    default_db = _create_cookie_db(base)
    profile_db = _create_cookie_db(base, "Profile 2")
    _insert_cookie(default_db, host_key="example.com", name="session", value="default")
    _insert_cookie(profile_db, host_key="example.com", name="session", value="profile-2")
    _configure_browser(monkeypatch, base, "darwin")

    assert get_cookies_module.list_browser_profiles("chrome") == ["Default", "Profile 2"]
    assert get_cookies_module.get_cookies("https://example.com", browser="chrome") == {
        "session": "default"
    }
    assert get_cookies_module.get_cookies(
        "https://example.com", browser="chrome", profile="Profile 2"
    ) == {"session": "profile-2"}


def test_unknown_or_unsafe_profile_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")

    for profile in ("Profile 9", "../Default", str(base / "Default")):
        with pytest.raises(get_cookies_module.CookieDatabaseError, match="Profile"):
            get_cookies_module.get_cookies("https://example.com", browser="chrome", profile=profile)


def test_url_scope_filters_domain_path_secure_expiry_and_partition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")
    _insert_cookie(db_path, host_key="api.example.com", name="host", value="host")
    _insert_cookie(db_path, host_key=".example.com", name="parent", value="parent")
    _insert_cookie(db_path, host_key=".sibling.example.com", name="sibling", value="sibling")
    _insert_cookie(
        db_path, host_key=".example.com", name="private", value="private", path="/private"
    )
    _insert_cookie(
        db_path, host_key=".example.com", name="wrong_path", value="wrong", path="/private-x"
    )
    _insert_cookie(db_path, host_key=".example.com", name="secure", value="secure", is_secure=True)
    _insert_cookie(
        db_path,
        host_key=".example.com",
        name="expired",
        value="expired",
        expires_utc=_webkit_timestamp(-1),
    )
    _insert_cookie(
        db_path,
        host_key=".example.com",
        name="near_expiry",
        value="near",
        expires_utc=_webkit_timestamp(60),
    )
    _insert_cookie(
        db_path,
        host_key=".example.com",
        name="partitioned",
        value="partitioned",
        top_frame_site_key="https://top.example",
    )

    https_cookies = get_cookies_module.get_cookies(
        "https://user:password@api.example.com:8443/private/data", browser="chrome"
    )
    assert https_cookies == {
        "host": "host",
        "parent": "parent",
        "private": "private",
        "secure": "secure",
        "near_expiry": "near",
    }

    http_cookies = get_cookies_module.get_cookies(
        "http://api.example.com/private/data", browser="chrome"
    )
    assert "secure" not in http_cookies


def test_same_name_cookie_selection_is_deterministic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")
    _insert_cookie(
        db_path,
        host_key="api.example.com",
        name="token",
        value="host-root",
        creation_utc=1,
    )
    _insert_cookie(
        db_path,
        host_key=".example.com",
        name="token",
        value="parent-private",
        path="/private",
        creation_utc=2,
    )

    assert (
        get_cookies_module.get_cookies("https://api.example.com/private/data", browser="chrome")[
            "token"
        ]
        == "parent-private"
    )
    assert (
        get_cookies_module.get_cookies("https://api.example.com/public", browser="chrome")["token"]
        == "host-root"
    )


def test_snapshot_reads_committed_wal_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")
    writer = sqlite3.connect(db_path)
    assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
    writer.execute("PRAGMA wal_autocheckpoint=0")
    writer.execute(
        """
        INSERT INTO cookies(
            creation_utc, host_key, top_frame_site_key, name, value, path,
            expires_utc, is_secure, has_expires, encrypted_value
        ) VALUES (1, 'example.com', '', 'fresh', 'wal-value', '/', 0, 0, 0, X'')
        """
    )
    writer.commit()

    try:
        assert get_cookies_module.get_cookies("https://example.com", browser="chrome") == {
            "fresh": "wal-value"
        }
    finally:
        writer.close()


def test_snapshot_context_does_not_replace_body_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")

    with pytest.raises(ValueError, match="sentinel"):
        with get_cookies_module._open_cookie_snapshot(db_path):
            raise ValueError("sentinel")


def test_encrypted_cookie_key_failure_is_not_reported_as_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")
    _insert_cookie(
        db_path,
        host_key=".example.com",
        name="session",
        encrypted_value=MAC_V24_COOKIE,
    )

    def fail_key(_browser: str) -> bytes:
        raise get_cookies_module.CookieKeyError("key unavailable")

    monkeypatch.setattr(get_cookies_module, "_get_macos_password", fail_key)
    with pytest.raises(get_cookies_module.CookieKeyError, match="key unavailable"):
        get_cookies_module.get_cookies("https://example.com", browser="chrome")


def test_corrupt_plaintext_and_encrypted_value_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")
    _insert_cookie(
        db_path,
        host_key=".example.com",
        name="session",
        value="stale-plaintext",
        encrypted_value=MAC_V24_COOKIE,
    )

    with pytest.raises(get_cookies_module.CookieDatabaseError, match="同时包含"):
        get_cookies_module.get_cookies("https://example.com", browser="chrome")


@pytest.mark.parametrize("version", [None, 25])
def test_unknown_database_version_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: int | None
) -> None:
    base = tmp_path / "browser"
    db_path = _create_cookie_db(base)
    _configure_browser(monkeypatch, base, "darwin")
    connection = sqlite3.connect(db_path)
    if version is None:
        connection.execute("DELETE FROM meta WHERE key = 'version'")
    else:
        connection.execute("UPDATE meta SET value = ? WHERE key = 'version'", (str(version),))
    connection.commit()
    connection.close()

    with pytest.raises(get_cookies_module.CookieDatabaseError, match="版本"):
        get_cookies_module.get_cookies("https://example.com", browser="chrome")


def test_invalid_url_is_rejected() -> None:
    with pytest.raises(ValueError, match="http"):
        get_cookies_module.get_cookies("example.com")


def test_single_cookie_getter_was_removed() -> None:
    assert not hasattr(get_cookies_module, "get_cookie_value")
