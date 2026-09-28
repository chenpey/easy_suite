"""从本机 Chromium Profile 中读取适用于目标 URL 的 Cookie。"""

import base64
import binascii
import hmac
import ipaddress
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from Crypto.Cipher import AES
from Crypto.Hash import SHA1
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Util.Padding import unpad

from easytest.util.get_config import get_config

COMMON_CONFIG_NAME = "common"
COOKIE_BROWSER_CONFIG_KEY = "browser"
DEFAULT_PROFILE = "Default"

_PBKDF2_SALT = b"saltysalt"
_CBC_IV = b" " * AES.block_size
_WEBKIT_EPOCH_OFFSET_US = 11_644_473_600 * 1_000_000
_WINDOWS_NONCE_LENGTH = 12
_GCM_TAG_LENGTH = 16
_DB_BACKUP_ATTEMPTS = 3
_DB_BACKUP_TIMEOUT_SECONDS = 5.0
_DB_RETRY_DELAY_SECONDS = 0.05
_KEY_COMMAND_TIMEOUT_SECONDS = 5.0
_MAX_SUPPORTED_DATABASE_VERSION = 24


class CookieError(RuntimeError):
    """Cookie 读取失败的基类。"""


class CookieKeyError(CookieError):
    """无法取得浏览器加密密钥。"""


class CookieDatabaseError(CookieError):
    """无法定位或一致读取 Cookie 数据库。"""


class CookieDecryptionError(CookieError):
    """Cookie 密文未通过严格解密或完整性校验。"""


class UnsupportedCookieEncryptionError(CookieDecryptionError):
    """当前进程不能安全处理该浏览器加密格式。"""


def _build_windows_base(vendor_parts: list[str]) -> str:
    local_app_data = os.getenv("LOCALAPPDATA", "")
    return os.path.join(local_app_data, *vendor_parts) if local_app_data else ""


BROWSER_PATHS: dict[str, dict[str, dict[str, Any]]] = {
    "chrome": {
        "darwin": {
            "base": "~/Library/Application Support/Google/Chrome",
            "keychain": ("Chrome Safe Storage", "Chrome"),
        },
        "windows": {
            "vendor": ["Google", "Chrome", "User Data"],
            "state": "Local State",
        },
        "linux": {
            "base": "~/.config/google-chrome",
            "linux_application": "chrome",
            "linux_keyring": "Chrome",
        },
    },
    "edge": {
        "darwin": {
            "base": "~/Library/Application Support/Microsoft Edge",
            "keychain": ("Microsoft Edge Safe Storage", "Microsoft Edge"),
        },
        "windows": {
            "vendor": ["Microsoft", "Edge", "User Data"],
            "state": "Local State",
        },
        "linux": {
            "base": "~/.config/microsoft-edge",
            "linux_application": "microsoft-edge",
            # Chromium 系浏览器在 KWallet 中通常沿用 Chromium 名称。
            "linux_keyring": "Chromium",
        },
    },
}


def _get_platform() -> str:
    return platform.system().lower()


def get_default_browser() -> str:
    """读取默认浏览器；底层配置缓存会按文件版本自动失效。"""
    browser = get_config(COMMON_CONFIG_NAME, COOKIE_BROWSER_CONFIG_KEY)
    if not isinstance(browser, str) or not browser.strip():
        raise ValueError(
            f"{COMMON_CONFIG_NAME}.json 中的 {COOKIE_BROWSER_CONFIG_KEY} 必须是非空字符串"
        )
    return browser.strip().lower()


def _resolve_browser(browser: str | None) -> str:
    resolved = browser if browser is not None else get_default_browser()
    if not isinstance(resolved, str) or not resolved.strip():
        raise ValueError("browser 必须是非空字符串")
    resolved = resolved.strip().lower()
    if resolved not in BROWSER_PATHS:
        raise ValueError(f"不支持的浏览器: {resolved}")
    return resolved


def _get_config(browser: str) -> dict[str, Any]:
    browser = _resolve_browser(browser)
    platform_name = _get_platform()
    config = BROWSER_PATHS[browser].get(platform_name)
    if config is None:
        raise NotImplementedError(f"当前平台 {platform_name} 不支持浏览器 {browser}")

    resolved = dict(config)
    if platform_name == "windows" and "vendor" in resolved:
        resolved["base"] = _build_windows_base(resolved["vendor"])
    return resolved


def _browser_base(browser: str) -> Path:
    base = _get_config(browser).get("base")
    if not isinstance(base, str) or not base:
        raise CookieDatabaseError(f"无法确定 {browser} 的用户数据目录")
    return Path(base).expanduser()


def _profile_sort_key(profile: str) -> tuple[int, int, str]:
    if profile == DEFAULT_PROFILE:
        return 0, 0, ""
    number = profile.removeprefix("Profile ")
    if number.isdigit() and profile.startswith("Profile "):
        return 1, int(number), ""
    return 2, 0, profile.casefold()


def _discover_profile_databases(browser: str) -> dict[str, Path]:
    base = _browser_base(browser)
    if not base.is_dir():
        raise CookieDatabaseError(f"{browser} 用户数据目录不存在: {base}")

    databases: dict[str, Path] = {}
    for profile_dir in base.iterdir():
        if profile_dir.is_symlink() or not profile_dir.is_dir():
            continue
        for relative_path in (Path("Network/Cookies"), Path("Cookies")):
            db_path = profile_dir / relative_path
            if db_path.is_file():
                databases[profile_dir.name] = db_path
                break
    return databases


def list_browser_profiles(browser: str | None = None) -> list[str]:
    """返回存在 Cookie 数据库的 Profile 目录名。"""
    browser = _resolve_browser(browser)
    return sorted(_discover_profile_databases(browser), key=_profile_sort_key)


def _resolve_profile_db(browser: str, profile: str) -> Path:
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError("profile 必须是非空字符串")
    profile = profile.strip()
    databases = _discover_profile_databases(browser)
    db_path = databases.get(profile)
    if db_path is None:
        available = ", ".join(sorted(databases, key=_profile_sort_key)) or "无"
        raise CookieDatabaseError(f"找不到 Profile [{profile}]；可用 Profile: {available}")
    return db_path


@lru_cache(maxsize=8)
def _derive_key(password: bytes, iterations: int) -> bytes:
    return PBKDF2(
        password,
        _PBKDF2_SALT,
        dkLen=16,
        count=iterations,
        hmac_hash_module=SHA1,
    )


@lru_cache(maxsize=4)
def _get_macos_password(browser: str) -> bytes:
    try:
        import keyring
    except ImportError as exc:  # pragma: no cover - 仅非 macOS 错误安装会触发
        raise CookieKeyError("macOS 读取 Cookie 需要 keyring") from exc

    service, account = _get_config(browser)["keychain"]
    try:
        password = keyring.get_password(service, account)
    except Exception as exc:
        raise CookieKeyError(f"无法从 macOS Keychain 读取 {browser} 密钥") from exc
    if not password:
        raise CookieKeyError(f"macOS Keychain 中不存在 {browser} Safe Storage 密钥")
    return password.encode("utf-8")


def _run_key_command(command: list[str]) -> bytes | None:
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=_KEY_COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    password = result.stdout.rstrip(b"\r\n")
    return password or None


@lru_cache(maxsize=4)
def _get_linux_v11_password(browser: str) -> bytes:
    config = _get_config(browser)
    secret_tool = shutil.which("secret-tool")
    if secret_tool:
        password = _run_key_command(
            [secret_tool, "lookup", "application", config["linux_application"]]
        )
        if password:
            return password

    kwallet_query = shutil.which("kwallet-query")
    if kwallet_query:
        keyring_name = config["linux_keyring"]
        password = _run_key_command(
            [
                kwallet_query,
                "--read-password",
                f"{keyring_name} Safe Storage",
                "--folder",
                f"{keyring_name} Keys",
                "kdewallet",
            ]
        )
        if password:
            return password

    raise CookieKeyError(
        f"无法从 Linux Secret Service/KWallet 读取 {browser} v11 密钥；"
        "请确认 secret-tool 或 kwallet-query 可用且钱包已解锁"
    )


def _read_local_state(browser: str) -> dict[str, Any]:
    config = _get_config(browser)
    state_path = _browser_base(browser) / config["state"]
    try:
        with open(state_path, encoding="utf-8") as file:
            content = json.load(file)
    except (OSError, json.JSONDecodeError) as exc:
        raise CookieKeyError(f"无法读取 {browser} Local State: {state_path}") from exc
    if not isinstance(content, dict):
        raise CookieKeyError(f"{browser} Local State 格式无效")
    return content


@lru_cache(maxsize=4)
def _get_windows_key(browser: str) -> bytes:
    try:
        encoded_key = _read_local_state(browser)["os_crypt"]["encrypted_key"]
        encrypted_key = base64.b64decode(encoded_key, validate=True)
    except (KeyError, TypeError, ValueError, binascii.Error) as exc:
        raise CookieKeyError(f"{browser} Local State 中的 encrypted_key 无效") from exc
    if not encrypted_key.startswith(b"DPAPI"):
        raise CookieKeyError(f"{browser} Local State 密钥缺少 DPAPI 前缀")

    key = _windows_dpapi_decrypt(encrypted_key[5:])
    if len(key) != 32:
        raise CookieKeyError(f"{browser} Windows AES 密钥长度应为 32 字节")
    return key


def _windows_dpapi_decrypt(encrypted_value: bytes) -> bytes:
    try:
        import win32crypt
    except ImportError as exc:  # pragma: no cover - 仅非 Windows 错误安装会触发
        raise CookieKeyError("Windows 读取 Cookie 需要 pywin32") from exc
    try:
        return win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1]
    except Exception as exc:
        raise CookieDecryptionError("Windows DPAPI Cookie 解密失败") from exc


def _decrypt_cbc(ciphertext: bytes, key: bytes) -> bytes:
    if not ciphertext or len(ciphertext) % AES.block_size:
        raise CookieDecryptionError("AES-CBC 密文长度无效")
    try:
        padded = AES.new(key, AES.MODE_CBC, _CBC_IV).decrypt(ciphertext)
        return unpad(padded, AES.block_size, style="pkcs7")
    except ValueError as exc:
        raise CookieDecryptionError("AES-CBC 解密失败或 PKCS#7 padding 无效") from exc


def _decrypt_windows_gcm(payload: bytes, key: bytes) -> bytes:
    minimum_length = _WINDOWS_NONCE_LENGTH + _GCM_TAG_LENGTH
    if len(payload) < minimum_length:
        raise CookieDecryptionError("Windows AES-GCM 密文长度无效")
    nonce = payload[:_WINDOWS_NONCE_LENGTH]
    ciphertext = payload[_WINDOWS_NONCE_LENGTH:-_GCM_TAG_LENGTH]
    tag = payload[-_GCM_TAG_LENGTH:]
    try:
        return AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ciphertext, tag)
    except ValueError as exc:
        raise CookieDecryptionError("Windows AES-GCM Cookie 解密失败") from exc


def _decrypt_cookie_bytes(encrypted_value: bytes, browser: str) -> bytes:
    platform_name = _get_platform()
    version = encrypted_value[:3]

    if version == b"v20":
        raise UnsupportedCookieEncryptionError(
            "Windows App-Bound v20 Cookie 只能由受信任的浏览器进程解密"
        )

    if platform_name == "darwin":
        if version != b"v10":
            raise UnsupportedCookieEncryptionError(f"macOS 不支持 Cookie 加密前缀 {version!r}")
        key = _derive_key(_get_macos_password(browser), 1003)
        return _decrypt_cbc(encrypted_value[3:], key)

    if platform_name == "linux":
        if version == b"v10":
            password = b"peanuts"
        elif version == b"v11":
            password = _get_linux_v11_password(browser)
        else:
            raise UnsupportedCookieEncryptionError(f"Linux 不支持 Cookie 加密前缀 {version!r}")
        return _decrypt_cbc(encrypted_value[3:], _derive_key(password, 1))

    if platform_name == "windows":
        if version == b"v10":
            return _decrypt_windows_gcm(encrypted_value[3:], _get_windows_key(browser))
        if version.startswith(b"v"):
            raise UnsupportedCookieEncryptionError(f"Windows 不支持 Cookie 加密前缀 {version!r}")
        return _windows_dpapi_decrypt(encrypted_value)

    raise NotImplementedError(f"当前平台 {platform_name} 不支持 Chromium Cookie 解密")


def _decrypt_cookie_value(
    encrypted_value: bytes,
    browser: str,
    host_key: str,
    database_version: int,
) -> str:
    plaintext = _decrypt_cookie_bytes(bytes(encrypted_value), browser)
    if database_version >= 24:
        expected_hash = sha256(host_key.encode("utf-8")).digest()
        actual_hash = plaintext[: len(expected_hash)]
        if not hmac.compare_digest(actual_hash, expected_hash):
            raise CookieDecryptionError(f"Cookie host_key 摘要校验失败: {host_key}")
        plaintext = plaintext[len(expected_hash) :]
    try:
        return plaintext.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise CookieDecryptionError(f"Cookie 值不是有效 UTF-8: {host_key}") from exc


def _is_retryable_database_error(error: BaseException) -> bool:
    if isinstance(error, TimeoutError):
        return True
    message = str(error).lower()
    return isinstance(error, sqlite3.OperationalError) and (
        "locked" in message or "busy" in message
    )


def _create_cookie_snapshot(db_path: Path) -> sqlite3.Connection:
    last_error: BaseException | None = None
    for attempt in range(_DB_BACKUP_ATTEMPTS):
        source: sqlite3.Connection | None = None
        snapshot: sqlite3.Connection | None = None
        try:
            source = sqlite3.connect(
                f"{db_path.resolve().as_uri()}?mode=ro",
                uri=True,
                timeout=0.25,
                isolation_level=None,
            )
            snapshot = sqlite3.connect(":memory:", isolation_level=None)
            deadline = time.monotonic() + _DB_BACKUP_TIMEOUT_SECONDS

            def ensure_deadline(_status: int, _remaining: int, _total: int) -> None:
                if time.monotonic() > deadline:
                    raise TimeoutError("Cookie 数据库快照超时")

            source.backup(
                snapshot,
                pages=256,
                progress=ensure_deadline,
                sleep=_DB_RETRY_DELAY_SECONDS,
            )
            snapshot.row_factory = sqlite3.Row
            snapshot.execute("PRAGMA query_only = ON")
            return snapshot
        except (sqlite3.Error, TimeoutError) as exc:
            last_error = exc
            if snapshot is not None:
                snapshot.close()
            if not _is_retryable_database_error(exc) or attempt == _DB_BACKUP_ATTEMPTS - 1:
                break
            time.sleep(_DB_RETRY_DELAY_SECONDS * (attempt + 1))
        finally:
            if source is not None:
                source.close()

    raise CookieDatabaseError(f"无法一致读取 Cookie 数据库: {db_path}") from last_error


@contextmanager
def _open_cookie_snapshot(db_path: Path) -> Iterator[sqlite3.Connection]:
    """建立包含 WAL 已提交内容的内存快照，且上下文只 yield 一次。"""
    snapshot = _create_cookie_snapshot(db_path)
    try:
        yield snapshot
    finally:
        snapshot.close()


def _get_database_version(connection: sqlite3.Connection) -> int:
    try:
        row = connection.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
        if row is None:
            raise CookieDatabaseError("Cookie 数据库缺少版本信息")
        version = int(row[0])
    except (sqlite3.Error, TypeError, ValueError) as exc:
        raise CookieDatabaseError("无法读取 Cookie 数据库版本") from exc
    if version > _MAX_SUPPORTED_DATABASE_VERSION:
        raise CookieDatabaseError(f"不支持 Cookie 数据库版本: {version}")
    return version


def _get_cookie_columns(connection: sqlite3.Connection) -> set[str]:
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(cookies)")}
    except sqlite3.Error as exc:
        raise CookieDatabaseError("无法读取 cookies schema") from exc
    required = {
        "creation_utc",
        "host_key",
        "name",
        "value",
        "path",
        "expires_utc",
        "is_secure",
        "encrypted_value",
    }
    missing = required - columns
    if missing:
        raise CookieDatabaseError(f"cookies schema 缺少字段: {', '.join(sorted(missing))}")
    return columns


def _parse_target_url(url: str) -> tuple[str, str, str]:
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url 必须是非空字符串")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
    except ValueError as exc:
        raise ValueError(f"URL 格式无效: {url}") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise ValueError("url 必须是包含 hostname 的 http/https URL")

    hostname = hostname.rstrip(".").lower()
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        try:
            hostname = hostname.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise ValueError(f"URL hostname 无效: {hostname}") from exc
    return parsed.scheme.lower(), hostname, parsed.path or "/"


def _host_key_candidates(hostname: str) -> tuple[str, ...]:
    try:
        ipaddress.ip_address(hostname)
        return (hostname,)
    except ValueError:
        pass
    if "." not in hostname:
        return (hostname,)

    labels = hostname.split(".")
    domain_keys = [f".{'.'.join(labels[index:])}" for index in range(len(labels) - 1)]
    return tuple([hostname, *domain_keys])


def _domain_matches(hostname: str, host_key: str) -> bool:
    normalized = host_key.lower()
    if not normalized.startswith("."):
        return hostname == normalized
    domain = normalized[1:]
    return hostname == domain or hostname.endswith(f".{domain}")


def _path_matches(request_path: str, cookie_path: str) -> bool:
    if not cookie_path.startswith("/"):
        cookie_path = "/"
    if request_path == cookie_path:
        return True
    if not request_path.startswith(cookie_path):
        return False
    return cookie_path.endswith("/") or request_path[len(cookie_path) :].startswith("/")


def _row_priority(row: sqlite3.Row, hostname: str) -> tuple[int, int, int, int, int]:
    creation_utc = int(row["creation_utc"] or 0)
    host_key = str(row["host_key"])
    return (
        len(str(row["path"])),
        int(host_key == hostname),
        len(host_key.lstrip(".")),
        -creation_utc,
        -int(row["rowid"]),
    )


def _read_plaintext_value(value: Any, host_key: str) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            return bytes(value).decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise CookieDecryptionError(f"明文 Cookie 值不是有效 UTF-8: {host_key}") from exc
    raise CookieDatabaseError(f"Cookie value 类型无效: {type(value).__name__}")


def get_cookies(
    url: str,
    browser: str | None = None,
    *,
    profile: str = DEFAULT_PROFILE,
) -> dict[str, str]:
    """读取单个 Profile 中适用于目标 URL 的 Cookie。

    已过期、Secure 与 scheme 不匹配、path/domain 不匹配以及缺少顶层站点
    上下文的 partitioned Cookie 会被排除。同名 Cookie 在字典接口限制下按最长
    path、host-only 优先和创建时间确定性选择一个。
    """
    scheme, hostname, request_path = _parse_target_url(url)
    browser = _resolve_browser(browser)
    db_path = _resolve_profile_db(browser, profile)
    host_keys = _host_key_candidates(hostname)
    placeholders = ", ".join("?" for _ in host_keys)

    try:
        with _open_cookie_snapshot(db_path) as connection:
            database_version = _get_database_version(connection)
            columns = _get_cookie_columns(connection)
            partition_filter = ""
            if "top_frame_site_key" in columns:
                partition_filter = " AND COALESCE(top_frame_site_key, '') = ''"
            rows = connection.execute(
                f"""
                SELECT rowid, creation_utc, host_key, name, value, path,
                       expires_utc, is_secure, encrypted_value
                FROM cookies
                WHERE host_key IN ({placeholders}){partition_filter}
                """,
                host_keys,
            )

            now_webkit_us = _WEBKIT_EPOCH_OFFSET_US + time.time_ns() // 1_000
            selected: dict[str, sqlite3.Row] = {}
            for row in rows:
                host_key = str(row["host_key"])
                cookie_path = str(row["path"])
                expires_utc = int(row["expires_utc"] or 0)
                if not _domain_matches(hostname, host_key):
                    continue
                if not _path_matches(request_path, cookie_path):
                    continue
                if bool(row["is_secure"]) and scheme != "https":
                    continue
                if expires_utc and expires_utc <= now_webkit_us:
                    continue

                name = str(row["name"])
                current = selected.get(name)
                if current is None or _row_priority(row, hostname) > _row_priority(
                    current, hostname
                ):
                    selected[name] = row
    except CookieError:
        raise
    except sqlite3.Error as exc:
        raise CookieDatabaseError(f"查询 Cookie 数据库失败: {db_path}") from exc

    cookies: dict[str, str] = {}
    for name, row in selected.items():
        host_key = str(row["host_key"])
        encrypted_value = bytes(row["encrypted_value"] or b"")
        if encrypted_value:
            if row["value"] not in ("", b"", None):
                raise CookieDatabaseError(f"Cookie [{name}] 同时包含明文与密文，数据库记录已损坏")
            cookies[name] = _decrypt_cookie_value(
                encrypted_value,
                browser,
                host_key,
                database_version,
            )
        else:
            cookies[name] = _read_plaintext_value(row["value"], host_key)
    return cookies
