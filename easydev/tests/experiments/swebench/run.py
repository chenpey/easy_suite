#!/usr/bin/env python3
"""Run and grade a small, reproducible SWE-bench Lite agent experiment."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

EXPERIMENTS_ROOT = Path(__file__).resolve().parents[1]
if str(EXPERIMENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_ROOT))

from process_control import (  # noqa: E402
    terminate_process,
    wait_for_process,
)
from protocol import (  # noqa: E402
    RESULT_PROTOCOL,
    TOKEN_FIELDS,
    is_valid_event,
    is_valid_invocation,
    is_valid_result,
    is_valid_stored_result,
    load_task_contracts,
)


DEFAULT_TASKS = [
    "pallets__flask-4045",
    "pallets__flask-5063",
    "psf__requests-3362",
    "pylint-dev__pylint-5859",
    "pytest-dev__pytest-8906",
]

DEFAULT_ARMS = ["baseline", "checklist", "easydev"]

CHECKLIST_PROMPT = """Before editing, inspect the relevant implementation and tests.
Keep the change minimal, preserve public behavior outside the request, and do not
weaken or modify tests. Run targeted tests and relevant regression tests. Review
the final diff for edge cases, compatibility, and accidental files. In the final
message, report the actual checks run and any unresolved risk."""

EASYDEV_PROMPT = """使用 easydev auto 完成下面的仓库任务。遵守 Skill 的完成边界；
不要修改或创建测试来放宽验收；不要访问网络；只修改解决任务所需的产品代码。
最终说明实际验证、独立审查状态和仍未验证的风险。"""

COMMON_PROMPT = """Evaluation constraints for every arm:
- Modify product source only. Do not add, remove, or edit tests.
- Hidden evaluator tests are not in the repository and will be applied after your run.
- Do not access the network or inspect benchmark metadata outside the repository.
- Run whatever existing read-only checks and tests are useful.
- Finish with the actual commands and results you observed."""

TEST_SUMMARY_RE = re.compile(
    r"^(?P<nodeid>.*?::.*?)\s+"
    r"(?P<status>PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b",
    re.MULTILINE,
)


def log(message: str) -> None:
    print(message, flush=True)


def run_command(
    args: Sequence[str],
    cwd: Path,
    *,
    env: Optional[Dict[str, str]] = None,
    timeout: int = 120,
    check: bool = False,
) -> subprocess.CompletedProcess:
    command = list(args)
    effective_env = env
    if command and Path(command[0]).name == "git":
        command[1:1] = [
            "-c",
            f"core.hooksPath={os.devnull}",
            "-c",
            "core.fsmonitor=false",
        ]
        effective_env = os.environ.copy() if env is None else dict(env)
        effective_env["GIT_CONFIG_NOSYSTEM"] = "1"
        effective_env["GIT_CONFIG_GLOBAL"] = os.devnull
        effective_env["GIT_ATTR_SYSTEM"] = os.devnull
        effective_env["GIT_ATTR_GLOBAL"] = os.devnull
        effective_env.pop("GIT_CONFIG_COUNT", None)
        effective_env.pop("GIT_CONFIG_PARAMETERS", None)
        for key in list(effective_env):
            if key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
                effective_env.pop(key, None)
    result = subprocess.run(
        command,
        cwd=str(cwd),
        env=effective_env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(args)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


@contextmanager
def _trusted_git_config(workspace: Path, content: bytes) -> Iterator[None]:
    git_dir = workspace / ".git"
    if git_dir.is_symlink() or not git_dir.is_dir():
        raise RuntimeError("Git metadata directory changed before capture")

    config_path = git_dir / "config"
    backup_path = git_dir / f".runner-config-{uuid.uuid4().hex}"
    had_config = os.path.lexists(config_path)
    if had_config:
        os.replace(config_path, backup_path)
    temporary_path: Optional[Path] = None
    try:
        fd, name = tempfile.mkstemp(prefix=".runner-config-", dir=git_dir)
        temporary_path = Path(name)
        with os.fdopen(fd, "wb") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, config_path)
        temporary_path = None
        yield
    finally:
        try:
            if os.path.lexists(config_path):
                if config_path.is_dir() and not config_path.is_symlink():
                    shutil.rmtree(config_path)
                else:
                    config_path.unlink()
        finally:
            if had_config and os.path.lexists(backup_path):
                os.replace(backup_path, config_path)
            if temporary_path is not None and os.path.lexists(temporary_path):
                temporary_path.unlink()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    temporary: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as target:
            temporary = Path(target.name)
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def read_json_object(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_tasks(dataset: Path, task_ids: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    rows = json.loads(dataset.read_text(encoding="utf-8"))
    by_id = {row["instance_id"]: row for row in rows}
    missing = [task_id for task_id in task_ids if task_id not in by_id]
    if missing:
        raise SystemExit(f"missing tasks in dataset: {', '.join(missing)}")

    tasks: Dict[str, Dict[str, Any]] = {}
    for task_id in task_ids:
        row = dict(by_id[task_id])
        row["FAIL_TO_PASS"] = json.loads(row["FAIL_TO_PASS"])
        row["PASS_TO_PASS"] = json.loads(row["PASS_TO_PASS"])
        tasks[task_id] = row
    return tasks


def _inside_destination(destination: Path, candidate: Path) -> bool:
    # realpath keeps both sides comparable when /tmp is a symlink to /private/tmp,
    # and it does not require the candidate to exist yet (member order is arbitrary).
    root = os.path.realpath(destination)
    resolved = os.path.realpath(candidate)
    return resolved == root or resolved.startswith(root.rstrip(os.sep) + os.sep)


def _link_escape_reason(destination: Path, member: tarfile.TarInfo) -> Optional[str]:
    """Why a link member would leave destination, or None when it stays inside."""
    linkname = member.linkname
    if not linkname or "\x00" in linkname:
        return "empty or invalid link target"
    if os.path.isabs(linkname):
        return "link escapes destination"
    target = destination / member.name
    # A symlink target is relative to the directory holding the link; a hardlink
    # target is relative to the archive root (tar semantics).
    base = target.parent if member.issym() else destination
    if _inside_destination(destination, base / linkname):
        return None
    return "link escapes destination"


def _extract_filter() -> Dict[str, str]:
    # filter="data" drops absolute or escaping members and unsafe metadata, but
    # tarfile.extract only accepts the keyword where data_filter exists (3.12+).
    return {"filter": "data"} if hasattr(tarfile, "data_filter") else {}


def extract_template(template: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    # Validate and extract one member at a time in archive order: links created by
    # earlier members are on disk when later members are checked, so a later
    # member cannot reach outside through a link the archive itself just created.
    # The per-member checks also cover Python versions without data_filter.
    extract_kwargs = _extract_filter()
    # Directories are created at the default mode and get their archived mode and
    # mtime after every member is written: a read-only archive directory (0555)
    # must not block the files it contains, which is what tarfile.extractall does
    # with its set_attrs=False pass followed by a reverse-order attrs pass.
    # Each entry keeps the path resolved now, not the member name: a later member
    # that changes an intermediate component can move what the name means, and
    # the delayed attribute calls must still land on the directory created here.
    directories: List[Tuple[Path, int, int, str]] = []
    with tarfile.open(template, "r") as archive:
        for member in archive.getmembers():
            if not _inside_destination(destination, destination / member.name):
                raise RuntimeError(f"unsafe tar member: {member.name}")
            if member.isdir():
                path = (destination / member.name).resolve()
                if not _inside_destination(destination, path):
                    raise RuntimeError(f"unsafe tar member: {member.name}")
                path.mkdir(parents=True, exist_ok=True)
                directories.append((path, member.mode, int(member.mtime), member.name))
                continue
            if member.issym() or member.islnk():
                reason = _link_escape_reason(destination, member)
                if reason is not None:
                    raise RuntimeError(
                        f"unsafe tar member (link): {member.name} ({reason})"
                    )
            archive.extract(member, destination, **extract_kwargs)
    # Archive order says nothing about depth, and a read-only parent (0500, 0400)
    # blocks the attributes of its children, so apply deepest first. Containment is
    # re-checked for every recorded path before the first attribute call: the
    # attribute calls follow links, and the recorded path is the one that must sit
    # inside the destination. An archive member cannot reach this branch today (a
    # resolved path holds no link that a later member can retarget, and extraction
    # cannot turn an existing directory into one), so the guard keeps a later
    # refactor from applying attributes to a path that left the destination.
    for path, _, _, name in directories:
        if not _inside_destination(destination, path):
            raise RuntimeError(f"unsafe tar member: {name}")
    for path, mode, mtime, _ in sorted(
        directories, key=lambda entry: len(entry[0].parts), reverse=True
    ):
        # A directory whose attributes cannot be applied does not stop the rest,
        # matching extractall; member errors above are never swallowed.
        try:
            os.chmod(path, mode & 0o7777)
            os.utime(path, (mtime, mtime))
        except OSError:
            pass


def prepare_runtime_files(workdir: Path, task_id: str) -> None:
    # pytest's source tree expects this generated file in an installed checkout.
    if task_id.startswith("pytest-dev__"):
        version_file = workdir / "src" / "_pytest" / "_version.py"
        version_file.write_text(
            "__version__ = version = '7.1.2'\n"
            "__version_tuple__ = version_tuple = (7, 1, 2)\n",
            encoding="utf-8",
        )


def init_repo(workdir: Path, task_id: str) -> str:
    prepare_runtime_files(workdir, task_id)
    run_command(["git", "init", "-q"], workdir, check=True)
    run_command(["git", "config", "user.email", "bench@example.com"], workdir, check=True)
    run_command(["git", "config", "user.name", "bench"], workdir, check=True)
    run_command(["git", "config", "commit.gpgsign", "false"], workdir, check=True)
    exclude = workdir / ".git" / "info" / "exclude"
    exclude.write_text(
        "\n".join(
            [
                ".agents/skills/",
                ".pytest_cache/",
                "__pycache__/",
                "*.pyc",
                ".coverage",
                ".venv/",
                "",
            ]
        ),
        encoding="utf-8",
    )
    run_command(["git", "add", "-A"], workdir, check=True)
    run_command(["git", "commit", "-qm", "benchmark base"], workdir, check=True)
    result = run_command(["git", "rev-parse", "HEAD"], workdir, check=True)
    return result.stdout.strip()


def apply_patch(workdir: Path, patch_text: str, label: str) -> None:
    patch_path = workdir.parent / f"{label}.patch"
    patch_path.write_text(patch_text, encoding="utf-8")
    check = run_command(
        ["git", "apply", "--check", str(patch_path)], workdir, timeout=60
    )
    if check.returncode != 0:
        raise RuntimeError(
            f"{label} patch does not apply:\n{check.stdout}\n{check.stderr}"
        )
    result = run_command(["git", "apply", str(patch_path)], workdir, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"{label} patch failed:\n{result.stdout}\n{result.stderr}")


def copy_easydev(skill_root: Path, workdir: Path) -> None:
    destination = workdir / ".agents" / "skills" / "easydev"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(skill_root / "SKILL.md", destination / "SKILL.md")
    shutil.copytree(
        skill_root / "references",
        destination / "references",
        dirs_exist_ok=True,
    )


def build_prompt(arm: str, problem: str) -> str:
    if arm == "baseline":
        prefix = ""
    elif arm == "checklist":
        prefix = CHECKLIST_PROMPT + "\n\n"
    elif arm == "easydev":
        prefix = EASYDEV_PROMPT + "\n\n"
    else:
        raise ValueError(f"unknown arm: {arm}")
    return f"{prefix}{COMMON_PROMPT}\n\nTask:\n{problem}"


def parse_events(events_path: Path) -> Dict[str, Any]:
    usage: Dict[str, int] = {}
    tool_calls = 0
    final_message = ""
    events = 0
    malformed_event_lines = 0
    easydev_mentions = 0
    turn_completed = False
    if not events_path.exists():
        return {
            "events": 0,
            "malformed_event_lines": 0,
            "tool_calls": 0,
            "final_message": "",
            "usage": {},
            "easydev_mentions": 0,
            "turn_completed": False,
        }
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            malformed_event_lines += 1
            continue
        if not is_valid_event(event):
            malformed_event_lines += 1
            continue
        event_type = event["type"]
        item = event.get("item")
        usage_value = event.get("usage")
        events += 1
        if event_type == "item.completed":
            item = item or {}
            if item.get("type") in {
                "command_execution",
                "file_change",
                "collab_tool_call",
            }:
                tool_calls += 1
            if item.get("type") == "agent_message":
                final_message = item.get("text", "")
            text = json.dumps(item, ensure_ascii=False).lower()
            if "easydev" in text:
                easydev_mentions += 1
        if event_type == "turn.completed":
            turn_completed = True
            usage = {
                key: int(value)
                for key, value in (usage_value or {}).items()
                if key in TOKEN_FIELDS
                and isinstance(value, int)
                and not isinstance(value, bool)
            }
    return {
        "events": events,
        "malformed_event_lines": malformed_event_lines,
        "tool_calls": tool_calls,
        "final_message": final_message,
        "usage": usage,
        "easydev_mentions": easydev_mentions,
        "turn_completed": turn_completed,
    }


def _terminate_process(process: subprocess.Popen, grace_seconds: float = 5.0) -> None:
    """Compatibility wrapper for tests and callers of the old helper."""
    terminate_process(process, grace_seconds=grace_seconds)


def codex_env(workdir: Path, venv: Path, run_dir: Path) -> Dict[str, str]:
    codex_home = run_dir / "codex-home"
    home = run_dir / "home"
    codex_home.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    codex_home.chmod(0o700)
    home.chmod(0o700)
    run_dir.chmod(0o700)
    auth = Path.home() / ".codex" / "auth.json"
    if not auth.exists():
        raise RuntimeError(f"missing Codex auth file: {auth}")
    auth_link = codex_home / "auth.json"
    if not auth_link.exists():
        auth_link.symlink_to(auth)

    env = os.environ.copy()
    for key in ("CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"):
        env.pop(key, None)
    env.update(
        {
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PATH": f"{venv / 'bin'}:{env.get('PATH', '')}",
        }
    )
    return env


def run_agent(
    *,
    workdir: Path,
    venv: Path,
    run_dir: Path,
    prompt: str,
    codex_bin: Path,
    model: str,
    reasoning_effort: str,
    base_url: str,
    timeout: int,
) -> Dict[str, Any]:
    events_path = run_dir / "events.jsonl"
    stdout_path = run_dir / "stdout.log"
    stderr_path = run_dir / "stderr.log"
    last_message_path = run_dir / "last-message.txt"
    env = codex_env(workdir, venv, run_dir)
    command = [
        str(codex_bin),
        "exec",
        "--ephemeral",
        "-s",
        "workspace-write",
        "-C",
        str(workdir),
        "--json",
        "-c",
        f'model="{model}"',
        "-c",
        f'model_reasoning_effort="{reasoning_effort}"',
        "-c",
        f'openai_base_url="{base_url}"',
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-o",
        str(last_message_path),
        prompt,
    ]
    started = time.time()
    timed_out = False
    try:
        with events_path.open("w", encoding="utf-8") as events_file, stdout_path.open(
            "w", encoding="utf-8"
        ) as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
            process = subprocess.Popen(
                command,
                cwd=str(workdir),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=events_file,
                stderr=stderr_file,
                text=True,
                errors="replace",
                start_new_session=os.name == "posix",
            )
            returncode, tracked = wait_for_process(process, timeout)
            if returncode is None:
                timed_out = True
                terminate_process(process, tracked=tracked)
                returncode = process.wait()
    except Exception as error:  # noqa: BLE001 - recorded as experiment data
        returncode = -1
        stderr_path.write_text(
            stderr_path.read_text(encoding="utf-8", errors="replace") + f"\n{error}\n",
            encoding="utf-8",
        )
    elapsed = time.time() - started
    parsed = parse_events(events_path)
    if last_message_path.exists():
        parsed["final_message"] = last_message_path.read_text(
            encoding="utf-8", errors="replace"
        )
    parsed.update(
        {
            "returncode": returncode,
            "timed_out": timed_out,
            "wall_seconds": elapsed,
        }
    )
    return parsed


def test_patch_files(task: Dict[str, Any]) -> List[str]:
    return re.findall(r"^diff --git a/(.+?) b/", task["test_patch"], re.MULTILINE)


def is_test_path(path: str) -> bool:
    parts = Path(path).parts
    if any(part in {"test", "tests", "testing"} for part in parts):
        return True
    name = parts[-1] if parts else path
    return name.startswith("test_") or name.endswith("_test.py")


def capture_patch(
    workdir: Path,
    base_sha: str,
    task: Dict[str, Any],
    trusted_git_config: bytes,
) -> Dict[str, Any]:
    with _trusted_git_config(workdir, trusted_git_config):
        run_command(["git", "add", "-A"], workdir, check=True)
        changed = run_command(
            ["git", "diff", "--cached", "--name-only", base_sha],
            workdir,
            timeout=60,
            check=True,
        ).stdout.splitlines()
        excluded = sorted(
            set(test_patch_files(task)).union(
                path for path in changed if is_test_path(path)
            )
        )
        pathspec = ["."] + [f":(exclude){path}" for path in excluded]
        result = run_command(
            ["git", "diff", "--cached", "--binary", base_sha, "--", *pathspec],
            workdir,
            timeout=60,
            check=True,
        )
    return {
        "patch": result.stdout,
        "excluded_test_paths": excluded,
    }


def parse_test_output(output: str) -> Dict[str, str]:
    statuses: Dict[str, str] = {}
    for match in TEST_SUMMARY_RE.finditer(output):
        statuses[match.group("nodeid")] = match.group("status")
    return statuses


def task_pythonpath(task_id: str, workdir: Path) -> str:
    if task_id.startswith("pallets__") or task_id.startswith("pytest-dev__"):
        return str(workdir / "src")
    return str(workdir)


def p2p_files(task: Dict[str, Any]) -> List[str]:
    files = []
    for nodeid in task["PASS_TO_PASS"]:
        file_path = nodeid.split("::", 1)[0]
        if file_path not in files:
            files.append(file_path)
    return files


def test_scope(task: Dict[str, Any]) -> List[str]:
    files = p2p_files(task)
    scope = list(files)
    for nodeid in task["FAIL_TO_PASS"]:
        file_path = nodeid.split("::", 1)[0]
        if file_path not in files:
            scope.append(nodeid)
    return scope


def baseline_eligible_p2p(
    task: Dict[str, Any],
    statuses: Dict[str, str],
) -> List[str]:
    return sorted(
        nodeid
        for nodeid in task["PASS_TO_PASS"]
        if statuses.get(nodeid) in {"PASSED", "SKIPPED", "XFAIL"}
    )


def pytest_command(venv: Path, nodeids: Sequence[str], junit: Path) -> List[str]:
    return [
        str(venv / "bin" / "python"),
        "-m",
        "pytest",
        "-v",
        "--tb=short",
        "-p",
        "no:cacheprovider",
        f"--junitxml={junit}",
        *nodeids,
    ]


def grade_patch(
    *,
    template: Path,
    task: Dict[str, Any],
    venv: Path,
    patch_text: str,
    out_dir: Path,
    eligible_p2p: Sequence[str],
    timeout: int,
) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    workdir = out_dir / "repo"
    if workdir.exists():
        shutil.rmtree(workdir)
    extract_template(template, workdir)
    init_repo(workdir, task["instance_id"])
    if patch_text.strip():
        try:
            apply_patch(workdir, patch_text, "agent")
        except RuntimeError as error:
            return {
                "patch_applied": False,
                "error": str(error),
                "f2p_pass": False,
                "f2p_status": {
                    nodeid: "MISSING" for nodeid in task["FAIL_TO_PASS"]
                },
                "p2p_regressions": [],
                "test_statuses": {},
                "pytest_returncode": None,
            }

    try:
        apply_patch(workdir, task["test_patch"], "test")
    except RuntimeError as error:
        return {
            "patch_applied": True,
            "error": f"test patch failed after agent patch: {error}",
            "f2p_pass": False,
            "f2p_status": {
                nodeid: "MISSING" for nodeid in task["FAIL_TO_PASS"]
            },
            "p2p_regressions": [],
            "test_statuses": {},
            "pytest_returncode": None,
        }

    selected = test_scope(task)
    junit = out_dir / "junit.xml"
    env = os.environ.copy()
    env.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            "PYTHONPATH": task_pythonpath(task["instance_id"], workdir),
        }
    )
    result = run_command(
        pytest_command(venv, selected, junit),
        workdir,
        env=env,
        timeout=timeout,
    )
    (out_dir / "pytest.stdout.log").write_text(result.stdout, encoding="utf-8")
    (out_dir / "pytest.stderr.log").write_text(result.stderr, encoding="utf-8")
    statuses = parse_test_output(result.stdout)
    f2p_status = {nodeid: statuses.get(nodeid, "MISSING") for nodeid in task["FAIL_TO_PASS"]}
    p2p_status = {nodeid: statuses.get(nodeid, "MISSING") for nodeid in eligible_p2p}
    regressions = [
        nodeid for nodeid in eligible_p2p if p2p_status[nodeid] not in {"PASSED", "SKIPPED", "XFAIL"}
    ]
    return {
        "patch_applied": True,
        "error": None,
        "f2p_pass": all(value == "PASSED" for value in f2p_status.values()),
        "f2p_status": f2p_status,
        "p2p_regressions": regressions,
        "test_statuses": {**f2p_status, **p2p_status},
        "pytest_returncode": result.returncode,
    }


def baseline_status(
    *,
    template: Path,
    task: Dict[str, Any],
    venv: Path,
    out_dir: Path,
    timeout: int,
) -> Dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    workdir = out_dir / "repo"
    if workdir.exists():
        shutil.rmtree(workdir)
    extract_template(template, workdir)
    init_repo(workdir, task["instance_id"])
    apply_patch(workdir, task["test_patch"], "test")
    nodeids = test_scope(task)
    junit = out_dir / "junit.xml"
    result = run_command(
        pytest_command(venv, nodeids, junit),
        workdir,
        env={
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            "PYTHONPATH": task_pythonpath(task["instance_id"], workdir),
        },
        timeout=timeout,
    )
    (out_dir / "pytest.stdout.log").write_text(result.stdout, encoding="utf-8")
    (out_dir / "pytest.stderr.log").write_text(result.stderr, encoding="utf-8")
    statuses = parse_test_output(result.stdout)
    eligible = baseline_eligible_p2p(task, statuses)
    excluded = [
        {"nodeid": nodeid, "status": statuses.get(nodeid, "MISSING")}
        for nodeid in task["PASS_TO_PASS"]
        if nodeid not in eligible
    ]
    return {
        "eligible_p2p": eligible,
        "excluded_p2p": excluded,
        "statuses": statuses,
        "pytest_returncode": result.returncode,
    }


def calibrate(args: argparse.Namespace) -> None:
    experiment = args.out
    experiment.mkdir(parents=True, exist_ok=True)
    install_experiment_assets(
        dataset=args.dataset,
        templates_source=args.templates,
        venvs_source=args.venvs,
        experiment=experiment,
        tasks=args.tasks,
    )
    tasks = load_tasks(args.dataset, args.tasks)
    manifest = {
        "kind": "swebench-lite-local-pilot",
        "dataset": str(args.dataset.resolve()),
        "dataset_sha256": sha256_file(args.dataset),
        "tasks": list(tasks),
        "model": args.model,
        "reasoning_effort": args.reasoning_effort,
        "protocol": {
            "arms": DEFAULT_ARMS,
            "source_only": True,
            "network_policy": "codex_sandbox_requested_not_verified",
            "resolved": "all FAIL_TO_PASS pass and no eligible PASS_TO_PASS regressions",
        },
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    write_json(experiment / "manifest.json", manifest)
    failures = []
    for task_id, task in tasks.items():
        template = args.templates / f"{task_id}.tar"
        venv = args.venvs / task_id
        base = baseline_status(
            template=template,
            task=task,
            venv=venv,
            out_dir=experiment / "task-baselines" / task_id,
            timeout=args.timeout,
        )
        write_json(experiment / "task-baselines" / f"{task_id}.json", base)
        gold = grade_patch(
            template=template,
            task=task,
            venv=venv,
            patch_text=task["patch"],
            out_dir=experiment / "gold" / task_id,
            eligible_p2p=base["eligible_p2p"],
            timeout=args.timeout,
        )
        write_json(experiment / "gold" / f"{task_id}.json", gold)
        ok = gold["f2p_pass"] and not gold["p2p_regressions"]
        log(
            f"{task_id}: eligible_p2p={len(base['eligible_p2p'])} "
            f"excluded_p2p={len(base['excluded_p2p'])} "
            f"f2p={gold['f2p_pass']} regressions={len(gold['p2p_regressions'])} "
            f"gold={'PASS' if ok else 'FAIL'}"
        )
        if not ok:
            failures.append(task_id)
    if failures:
        raise SystemExit(f"gold calibration failed: {', '.join(failures)}")


def run_one(
    *,
    args: argparse.Namespace,
    task_id: str,
    task: Dict[str, Any],
    baseline: Dict[str, Any],
    arm: str,
    repeat: int,
) -> Dict[str, Any]:
    experiment = args.experiment
    run_dir = experiment / "runs" / task_id / arm / f"r{repeat}"
    result_path = run_dir / "result.json"
    if result_path.exists():
        existing = read_json_object(result_path)
        if is_valid_stored_result(
            existing,
            result_path,
            expected_task_id=task_id,
            expected_arm=arm,
            expected_repeat=repeat,
            expected_f2p=task["FAIL_TO_PASS"],
            expected_p2p=baseline["eligible_p2p"],
        ):
            return existing

    run_dir.mkdir(parents=True, exist_ok=True)
    workdir = run_dir / "repo"
    if workdir.exists():
        shutil.rmtree(workdir)
    extract_template(experiment / "templates" / f"{task_id}.tar", workdir)
    base_sha = init_repo(workdir, task_id)
    trusted_git_config = (workdir / ".git" / "config").read_bytes()
    if arm == "easydev":
        copy_easydev(args.skill_root, workdir)

    prompt = build_prompt(arm, task["problem_statement"])
    agent = run_agent(
        workdir=workdir,
        venv=experiment / "venvs" / task_id,
        run_dir=run_dir,
        prompt=prompt,
        codex_bin=args.codex_bin,
        model=args.model,
        reasoning_effort=args.reasoning_effort,
        base_url=args.base_url,
        timeout=args.agent_timeout,
    )
    captured = capture_patch(workdir, base_sha, task, trusted_git_config)
    patch = captured["patch"]
    (run_dir / "agent.patch").write_text(patch, encoding="utf-8")
    invocation = {
        "result_protocol": RESULT_PROTOCOL,
        "agent_returncode": agent["returncode"],
        "turn_completed": agent.get("turn_completed", False),
        "agent_timed_out": agent.get("timed_out", False),
        "events": agent.get("events", 0),
        "malformed_event_lines": agent.get("malformed_event_lines", 0),
    }
    if not is_valid_invocation(invocation):
        reasons = []
        if agent["returncode"] != 0:
            reasons.append(f"returncode={agent['returncode']}")
        if not agent.get("turn_completed"):
            reasons.append("turn.completed is missing")
        if agent.get("timed_out"):
            reasons.append("agent timed out")
        if agent.get("events", 0) <= 0:
            reasons.append("event stream is empty")
        if agent.get("malformed_event_lines", 0) != 0:
            reasons.append(
                f"malformed_event_lines={agent.get('malformed_event_lines')}"
            )
        reason = "; ".join(reasons) or "invalid agent invocation"
        invalid_result = {
            "task_id": task_id,
            "arm": arm,
            "repeat": repeat,
            "result_protocol": RESULT_PROTOCOL,
            "agent_returncode": agent["returncode"],
            "agent_timed_out": agent["timed_out"],
            "turn_completed": agent.get("turn_completed", False),
            "events": agent.get("events", 0),
            "malformed_event_lines": agent.get("malformed_event_lines", 0),
            "reason": reason,
            "stderr_tail": (
                (run_dir / "stderr.log").read_text(encoding="utf-8", errors="replace")[-4000:]
                if (run_dir / "stderr.log").exists()
                else ""
            ),
        }
        write_json(run_dir / "invalid-result.json", invalid_result)
        raise RuntimeError(f"agent invocation failed: {reason}")
    grade = grade_patch(
        template=experiment / "templates" / f"{task_id}.tar",
        task=task,
        venv=experiment / "venvs" / task_id,
        patch_text=patch,
        out_dir=run_dir / "grade",
        eligible_p2p=baseline["eligible_p2p"],
        timeout=args.test_timeout,
    )
    write_json(run_dir / "grade" / "result.json", grade)

    result = {
        "task_id": task_id,
        "repo": task["repo"],
        "arm": arm,
        "repeat": repeat,
        "result_protocol": RESULT_PROTOCOL,
        "resolved": bool(grade["f2p_pass"] and not grade["p2p_regressions"]),
        "f2p_pass": grade["f2p_pass"],
        "f2p_status": grade.get("f2p_status", {}),
        "p2p_regressions": grade["p2p_regressions"],
        "test_statuses": grade.get("test_statuses", {}),
        "patch_applied": grade["patch_applied"],
        "grade_error": grade.get("error"),
        "pytest_returncode": grade.get("pytest_returncode"),
        "agent_returncode": agent["returncode"],
        "agent_timed_out": agent["timed_out"],
        "turn_completed": agent.get("turn_completed", False),
        "events": agent.get("events", 0),
        "malformed_event_lines": agent.get("malformed_event_lines", 0),
        "wall_seconds": agent["wall_seconds"],
        "tool_calls": agent["tool_calls"],
        "usage": agent.get("usage", {}),
        "easydev_mentions": agent.get("easydev_mentions", 0),
        "final_message": agent.get("final_message", ""),
        "patch_chars": len(patch),
        "excluded_test_paths": captured["excluded_test_paths"],
    }
    write_json(result_path, result)
    return result


def restore_protected_modes(record_path: Path) -> None:
    """Reopen paths a previous interrupted run left locked at mode 0."""
    if not record_path.exists():
        return
    try:
        payload = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"cannot read protected mode record {record_path}: {error}. "
            f"Restore those modes with chmod yourself, or delete {record_path}."
        ) from error
    if not isinstance(payload, dict):
        raise RuntimeError(
            f"protected mode record {record_path} must map paths to modes. "
            f"Restore those modes with chmod yourself, or delete {record_path}."
        )
    modes: Dict[Path, int] = {}
    for raw_path, mode in payload.items():
        if isinstance(mode, bool) or not isinstance(mode, int) or not 0 <= mode <= 0o777:
            raise RuntimeError(
                f"invalid recorded mode {mode!r} for {raw_path} in {record_path}. "
                f"Restore those modes with chmod yourself, or delete {record_path}."
            )
        path = Path(raw_path).expanduser()
        # A relative entry would be resolved against whatever directory this
        # process runs in, so recovery would chmod a different file and leave
        # the locked one at mode 0.
        if not path.is_absolute():
            raise RuntimeError(
                f"protected mode record {record_path} contains the relative "
                f"path {raw_path!r}. The record was written by an older version "
                f"or by a run started from another directory; restore those "
                f"modes with chmod yourself from the directory that run used, "
                f"or delete {record_path}."
            )
        # `..` only resolves through the file system, and an old path may hold a
        # symlink where the parent now is, so folding the entry lexically could
        # chmod a different file. Keeping it also breaks ancestor-first order:
        # the lexical entry is longer than the ancestor it really points into.
        if ".." in path.parts:
            raise RuntimeError(
                f"protected mode record {record_path} contains the path "
                f"{raw_path!r} with a '..' component. Restore those modes with "
                f"chmod yourself, or delete {record_path}."
            )
        modes[path] = mode
    # Mode 0 is the marker an interrupted run leaves behind; a path whose mode
    # the user changed afterwards must keep the user's mode. Ancestors come
    # first: a mode-0 ancestor hides its descendants, and a hand-edited or old
    # record may still hold both.
    for path in sorted(modes, key=lambda entry: len(entry.parts)):
        mode = modes[path]
        if path.exists() and (path.stat().st_mode & 0o777) == 0:
            path.chmod(mode)


def reject_symlinked_record(record_path: Path) -> None:
    """Refuse a record path that is a symlink, dangling or not."""
    # `os.path.lexists` also sees a dangling link, which `record_path.exists()`
    # reports as absent; write_json would still replace the link with a file.
    if os.path.lexists(record_path) and record_path.is_symlink():
        raise RuntimeError(
            f"refusing to use the protected mode record {record_path}: it is a "
            f"symlink, and the record path must be a regular file. Writing the "
            f"record replaces the link itself, so an interrupted run would "
            f"leave the record outside the experiment directory and the next "
            f"start could not restore the protected paths automatically. The "
            f"link may be left over from an older run or placed from outside; "
            f"delete it so the tool rebuilds the record, or restore the "
            f"protected modes with chmod yourself and rerun."
        )


def reject_record_inside_protected_paths(
    protected_paths: Iterable[Path], record_path: Path
) -> None:
    """Refuse protection that would hide the record from a later restart."""
    # write_json replaces the record's directory entry, so a symlinked record
    # lands beside the link and not at its target. The containment check has to
    # compare that landing spot, otherwise following the link would let a
    # record inside a protected path pass and then be locked at mode 0.
    record = record_path.parent.resolve() / record_path.name
    for path in protected_paths:
        if record == path or path in record.parents:
            raise RuntimeError(
                f"refusing to protect {path}: the protected mode record {record} "
                f"is inside it, so an interrupted run would lock the record "
                f"itself at mode 0 and the next start could not restore the "
                f"protected paths automatically. Protect a more specific "
                f"subpath, or do not protect the experiment directory."
            )


def normalize_protected_paths(paths: Iterable[Path]) -> List[Path]:
    """Resolve protected paths and drop duplicates and covered descendants."""
    resolved: List[Path] = []
    for path in paths:
        candidate = Path(path).expanduser().resolve()
        if candidate not in resolved:
            resolved.append(candidate)
    # Locking an ancestor already hides everything below it, and keeping both
    # would lock or restore a child through a mode-0 parent.
    return [
        path
        for path in resolved
        if not any(ancestor in resolved for ancestor in path.parents)
    ]


@contextmanager
def lock_protected_paths(paths: Iterable[Path], record_path: Path) -> Iterator[None]:
    """Lock existing paths at mode 0 for the run and restore them afterwards."""
    # Refuse a symlinked record before anything is written or chmod-ed: the
    # check above cannot see through `os.replace`, which overwrites the link.
    reject_symlinked_record(record_path)
    merged = normalize_protected_paths(paths)
    # Refuse before the record is written: the record has to outlive the lock to
    # be useful, and a protected ancestor of it would be chmod-ed to 0 after the
    # write, leaving an interrupted run no way back.
    reject_record_inside_protected_paths(merged, record_path)
    original_modes = {
        path: path.stat().st_mode & 0o777 for path in merged if path.exists()
    }
    # Record the modes before locking the paths: an interrupted run would
    # otherwise leave them at mode 0 with no way to recover them.
    write_json(record_path, {str(path): mode for path, mode in original_modes.items()})
    for path in original_modes:
        path.chmod(0)
    try:
        yield
    finally:
        for path in sorted(original_modes, key=lambda entry: len(entry.parts)):
            path.chmod(original_modes[path])
    # Only a run that reached its end still needs the record; deleting here also
    # keeps a delete error from masking the failure that interrupted the run.
    record_path.unlink(missing_ok=True)


def run_experiment(args: argparse.Namespace) -> None:
    experiment = args.experiment
    protect_record = experiment / "protected-modes.json"
    # Recover before reading anything: an interrupted run left dataset.json and
    # task-baselines at mode 0, so reading them first would fail permanently.
    restore_protected_modes(protect_record)
    tasks = load_tasks(experiment / "dataset.json", args.tasks)
    baselines: Dict[str, Dict[str, Any]] = {}
    for task_id in tasks:
        template = experiment / "templates" / f"{task_id}.tar"
        venv = experiment / "venvs" / task_id
        baseline_path = experiment / "task-baselines" / f"{task_id}.json"
        if not template.exists() or not venv.exists() or not baseline_path.exists():
            raise SystemExit(f"missing calibrated assets for {task_id}")
        baselines[task_id] = json.loads(baseline_path.read_text(encoding="utf-8"))

    jobs: List[Tuple[str, str, int]] = []
    for task_id in tasks:
        for arm in args.arms:
            for repeat in range(1, args.repeats + 1):
                run_dir = experiment / "runs" / task_id / arm / f"r{repeat}"
                result_path = run_dir / "result.json"
                complete = False
                if result_path.exists():
                    existing = read_json_object(result_path)
                    complete = is_valid_stored_result(
                        existing,
                        result_path,
                        expected_task_id=task_id,
                        expected_arm=arm,
                        expected_repeat=repeat,
                        expected_f2p=tasks[task_id]["FAIL_TO_PASS"],
                        expected_p2p=baselines[task_id]["eligible_p2p"],
                    )
                if not complete:
                    jobs.append((task_id, arm, repeat))

    protected_paths = [
        experiment / "dataset.json",
        experiment / "task-baselines",
        experiment / "gold",
        *args.protect_paths,
    ]

    with lock_protected_paths(protected_paths, protect_record):
        log(f"running {len(jobs)} jobs with concurrency={args.concurrency}")
        failures: List[str] = []
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=args.concurrency
        ) as executor:
            future_map = {
                executor.submit(
                    run_one,
                    args=args,
                    task_id=task_id,
                    task=tasks[task_id],
                    baseline=baselines[task_id],
                    arm=arm,
                    repeat=repeat,
                ): (task_id, arm, repeat)
                for task_id, arm, repeat in jobs
            }
            for future in concurrent.futures.as_completed(future_map):
                task_id, arm, repeat = future_map[future]
                try:
                    result = future.result()
                    log(
                        f"{task_id} {arm} r{repeat}: "
                        f"resolved={result['resolved']} "
                        f"f2p={result['f2p_pass']} "
                        f"p2p_regressions={len(result['p2p_regressions'])} "
                        f"wall={result['wall_seconds']:.1f}s"
                    )
                except Exception as error:  # noqa: BLE001 - keep other jobs running
                    failures.append(f"{task_id} {arm} r{repeat}: {error}")
                    log(f"{task_id} {arm} r{repeat}: ERROR {error}")
        if failures:
            raise SystemExit("run failures:\n" + "\n".join(failures))


def read_results(experiment: Path) -> List[Dict[str, Any]]:
    result_paths = sorted((experiment / "runs").glob("*/*/r*/result.json"))
    run_task_ids = sorted(
        {
            path.parent.parent.parent.name
            for path in result_paths
            if re.fullmatch(r"r\d+", path.parent.name)
        }
    )
    manifest_path = experiment / "manifest.json"
    if manifest_path.exists():
        manifest = read_json_object(manifest_path)
        manifest_tasks = manifest.get("tasks")
        if not (
            isinstance(manifest_tasks, list)
            and manifest_tasks
            and all(isinstance(task_id, str) and task_id for task_id in manifest_tasks)
            and len(manifest_tasks) == len(set(manifest_tasks))
        ):
            raise ValueError(f"invalid experiment manifest tasks: {manifest_path}")
        task_ids: Optional[Sequence[str]] = sorted(
            set(manifest_tasks).union(run_task_ids)
        )
    else:
        # Without a manifest, known run tasks define the selected subset. If
        # there are no runs yet, validate every dataset row instead of silently
        # accepting missing or inconsistent baseline contracts.
        task_ids = run_task_ids or None
    task_contracts = load_task_contracts(experiment, task_ids=task_ids)
    if task_contracts is None:
        raise ValueError(f"experiment dataset is required: {experiment / 'dataset.json'}")

    results = []
    for path in result_paths:
        result = read_json_object(path)
        repeat_match = re.fullmatch(r"r(\d+)", path.parent.name)
        if repeat_match is None:
            continue
        expected_repeat = int(repeat_match.group(1))
        task_id = path.parent.parent.parent.name
        expected = task_contracts.get(task_id)
        if expected is None:
            continue
        expected_f2p, expected_p2p = expected or (None, None)
        if is_valid_stored_result(
            result,
            path,
            expected_task_id=task_id,
            expected_arm=path.parent.parent.name,
            expected_repeat=expected_repeat,
            expected_f2p=expected_f2p,
            expected_p2p=expected_p2p,
        ):
            results.append(result)
    return results


def percentile(values: Sequence[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def task_rates(results: Sequence[Dict[str, Any]], arm: str) -> Dict[str, float]:
    rates = {}
    for task_id in sorted({result["task_id"] for result in results}):
        rows = [
            result
            for result in results
            if result["task_id"] == task_id and result["arm"] == arm
        ]
        if rows:
            rates[task_id] = sum(bool(row["resolved"]) for row in rows) / len(rows)
    return rates


def paired_bootstrap(
    left: Dict[str, float],
    right: Dict[str, float],
    iterations: int = 10000,
    seed: int = 20261020,
) -> Dict[str, float]:
    task_ids = sorted(set(left) & set(right))
    if not task_ids:
        return {"risk_difference": 0.0, "ci_low": 0.0, "ci_high": 0.0}
    differences = [right[task_id] - left[task_id] for task_id in task_ids]
    randomizer = random.Random(seed)
    sampled = []
    for _ in range(iterations):
        sample = [differences[randomizer.randrange(len(differences))] for _ in differences]
        sampled.append(sum(sample) / len(sample))
    return {
        "risk_difference": sum(differences) / len(differences),
        "ci_low": percentile(sampled, 0.025),
        "ci_high": percentile(sampled, 0.975),
        "tasks_left_better": sum(difference > 0 for difference in differences),
        "tasks_right_better": sum(difference < 0 for difference in differences),
        "tasks_tied": sum(difference == 0 for difference in differences),
    }


def arm_summary(results: Sequence[Dict[str, Any]], arm: str) -> Dict[str, Any]:
    rows = [result for result in results if result["arm"] == arm]
    usage = [row.get("usage", {}) for row in rows]
    input_tokens = [item.get("input_tokens", 0) for item in usage]
    output_tokens = [item.get("output_tokens", 0) for item in usage]
    wall = [row["wall_seconds"] for row in rows]
    tools = [row["tool_calls"] for row in rows]
    resolved = sum(bool(row["resolved"]) for row in rows)
    return {
        "runs": len(rows),
        "resolved": resolved,
        "resolved_rate": (
            resolved / len(rows) if rows else 0.0
        ),
        "f2p_pass_rate": (
            sum(bool(row["f2p_pass"]) for row in rows) / len(rows) if rows else 0.0
        ),
        "p2p_regression_rate": (
            sum(bool(row["p2p_regressions"]) for row in rows) / len(rows) if rows else 0.0
        ),
        "patch_apply_failures": sum(not row["patch_applied"] for row in rows),
        "timeouts": sum(bool(row["agent_timed_out"]) for row in rows),
        "mean_wall_seconds": statistics.mean(wall) if wall else 0.0,
        "median_wall_seconds": statistics.median(wall) if wall else 0.0,
        "mean_input_tokens": statistics.mean(input_tokens) if input_tokens else 0.0,
        "median_input_tokens": statistics.median(input_tokens) if input_tokens else 0.0,
        "mean_output_tokens": statistics.mean(output_tokens) if output_tokens else 0.0,
        "median_output_tokens": statistics.median(output_tokens) if output_tokens else 0.0,
        "mean_tool_calls": statistics.mean(tools) if tools else 0.0,
        "input_tokens_per_resolved": (
            sum(input_tokens) / resolved if resolved else None
        ),
        "wall_seconds_per_resolved": (
            sum(wall) / resolved if resolved else None
        ),
        "task_resolved_rates": task_rates(results, arm),
    }


def markdown_report(experiment: Path, results: Sequence[Dict[str, Any]]) -> str:
    arms = sorted({result["arm"] for result in results})
    summaries = {arm: arm_summary(results, arm) for arm in arms}
    task_count = len({result["task_id"] for result in results})
    lines = [
        "# SWE-bench Lite 小样本实验报告",
        "",
        "> 这是本机小样本预实验，不是官方 SWE-bench Verified 成绩。",
        "",
        "## 配置",
        "",
    ]
    manifest_path = experiment / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_task_count = len(manifest.get("tasks", []))
        lines.extend(
            [
                f"- 模型：`{manifest.get('model')}`",
                f"- 推理深度：`{manifest.get('reasoning_effort')}`",
                f"- 任务数：{task_count}",
                f"- 重复次数：{max((result['repeat'] for result in results), default=0)}",
            ]
        )
        if manifest_task_count != task_count:
            lines.append(f"- 校准清单：{manifest_task_count} 个任务")
        lines.append("")
    lines.extend(
        [
            "## 判定与统计",
            "",
            "- `resolved` 要求全部 FAIL_TO_PASS 通过，且环境基线可通过的 "
            "PASS_TO_PASS 无回归。",
            "- 同一任务的重复 run 先取解决率，再做任务级配对比较，避免把重复运行"
            "误当作独立任务。",
            "- 配对区间使用 10,000 次任务级 bootstrap；"
            f"{task_count} 个任务下区间很粗，只用于显示不确定性，不作显著性声明。",
            "",
            "## 主结果",
            "",
            "| Arm | runs | resolved | resolved rate | F2P pass | P2P regression | mean wall (s) | mean input tokens | mean tool calls |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for arm in arms:
        summary = summaries[arm]
        lines.append(
            f"| {arm} | {summary['runs']} | {summary['resolved']} | "
            f"{summary['resolved_rate']:.1%} | {summary['f2p_pass_rate']:.1%} | "
            f"{summary['p2p_regression_rate']:.1%} | "
            f"{summary['mean_wall_seconds']:.1f} | "
            f"{summary['mean_input_tokens']:.0f} | "
            f"{summary['mean_tool_calls']:.1f} |"
        )

    lines.extend(
        [
            "",
            "## 成本",
            "",
            "| Arm | median wall (s) | median input tokens | median output tokens | input tokens / resolved | wall seconds / resolved |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for arm in arms:
        summary = summaries[arm]
        input_per = summary["input_tokens_per_resolved"]
        wall_per = summary["wall_seconds_per_resolved"]
        lines.append(
            f"| {arm} | {summary['median_wall_seconds']:.1f} | "
            f"{summary['median_input_tokens']:.0f} | "
            f"{summary['median_output_tokens']:.0f} | "
            f"{input_per:.0f} | {wall_per:.1f} |"
            if input_per is not None and wall_per is not None
            else f"| {arm} | {summary['median_wall_seconds']:.1f} | "
            f"{summary['median_input_tokens']:.0f} | "
            f"{summary['median_output_tokens']:.0f} | n/a | n/a |"
        )

    lines.extend(["", "## 配对比较", ""])
    if "baseline" in summaries:
        for arm in arms:
            if arm == "baseline":
                continue
            comparison = paired_bootstrap(
                summaries["baseline"]["task_resolved_rates"],
                summaries[arm]["task_resolved_rates"],
            )
            baseline = summaries["baseline"]
            current = summaries[arm]
            input_ratio = (
                current["mean_input_tokens"] / baseline["mean_input_tokens"]
                if baseline["mean_input_tokens"]
                else 0.0
            )
            wall_ratio = (
                current["mean_wall_seconds"] / baseline["mean_wall_seconds"]
                if baseline["mean_wall_seconds"]
                else 0.0
            )
            lines.append(
                f"- `{arm} - baseline`: 风险差 "
                f"{comparison['risk_difference']:+.1%}，任务级 bootstrap 95% CI "
                f"[{comparison['ci_low']:+.1%}, {comparison['ci_high']:+.1%}]；"
                f"任务胜/负/平 "
                f"{comparison['tasks_left_better']}/"
                f"{comparison['tasks_right_better']}/"
                f"{comparison['tasks_tied']}；均值输入 token 为 baseline 的 "
                f"{input_ratio:.2f}x，均值为 {wall_ratio:.2f}x 耗时。"
            )

    lines.extend(["", "## 分任务", ""])
    task_ids = sorted({result["task_id"] for result in results})
    header = "| Task | " + " | ".join(arms) + " |"
    separator = "| --- | " + " | ".join("---:" for _ in arms) + " |"
    lines.extend([header, separator])
    for task_id in task_ids:
        cells = []
        for arm in arms:
            rows = [
                result
                for result in results
                if result["task_id"] == task_id and result["arm"] == arm
            ]
            passed = sum(bool(row["resolved"]) for row in rows)
            cells.append(f"{passed}/{len(rows)}")
        lines.append(f"| {task_id} | " + " | ".join(cells) + " |")

    failures = [result for result in results if not result["resolved"]]
    lines.extend(["", "## 失败案例", ""])
    if not failures:
        lines.append("无。")
    else:
        for result in failures[:40]:
            if result.get("grade_error"):
                reason = result["grade_error"]
            elif not result["f2p_pass"]:
                failed_f2p = [
                    nodeid
                    for nodeid, status in result.get("f2p_status", {}).items()
                    if status != "PASSED"
                ]
                detail = ", ".join(f"`{nodeid}`" for nodeid in failed_f2p)
                reason = (
                    f"FAIL_TO_PASS 未通过：{detail}"
                    if detail
                    else "FAIL_TO_PASS 未全部通过"
                )
            else:
                reason = f"P2P regressions={len(result['p2p_regressions'])}"
            lines.append(
                f"- `{result['task_id']}` / `{result['arm']}` / "
                f"r{result['repeat']}：{reason}"
            )

    lines.extend(
        [
            "",
            "## 解释边界",
            "",
            f"- 本实验只覆盖 {task_count} 个 SWE-bench Lite 任务，"
            "不足以支持总体解决率结论。",
            "- `PASS_TO_PASS` 按本机基线筛选；环境不可用测试已排除，不能与官方 Docker 分数直接比较。",
            "- 单一模型、单一宿主，不代表其他模型或 harness。",
            "- token 只报告现有事件中的 usage，不包含供应商侧隐藏计费或未暴露缓存成本。",
            "- 小样本置信区间很宽；任何正负差异都必须结合失败案例和后续完整基准复现。",
            "",
        ]
    )
    return "\n".join(lines)


def summarize(args: argparse.Namespace) -> None:
    results = read_results(args.experiment)
    if not results:
        raise SystemExit("no completed runs")
    with (args.experiment / "results.jsonl").open("w", encoding="utf-8") as output:
        for result in results:
            output.write(json.dumps(result, ensure_ascii=False) + "\n")
    summaries = {
        arm: arm_summary(results, arm)
        for arm in sorted({result["arm"] for result in results})
    }
    write_json(args.experiment / "summary.json", summaries)
    report = markdown_report(args.experiment, results)
    (args.experiment / "report.md").write_text(report, encoding="utf-8")
    log(report)


def install_experiment_assets(
    *,
    dataset: Path,
    templates_source: Path,
    venvs_source: Path,
    experiment: Path,
    tasks: Sequence[str],
) -> None:
    experiment.mkdir(parents=True, exist_ok=True)
    shutil.copy2(dataset, experiment / "dataset.json")
    (experiment / "templates").mkdir(exist_ok=True)
    (experiment / "venvs").mkdir(exist_ok=True)
    for task_id in tasks:
        template = templates_source / f"{task_id}.tar"
        venv = venvs_source / task_id
        if not template.exists():
            raise SystemExit(f"missing template: {template}")
        if not venv.exists():
            raise SystemExit(f"missing venv: {venv}")
        target_template = experiment / "templates" / f"{task_id}.tar"
        if not target_template.exists():
            target_template.symlink_to(template)
        target_venv = experiment / "venvs" / task_id
        if not target_venv.exists():
            target_venv.symlink_to(venv)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    def common(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--dataset", type=Path)
        subparser.add_argument("--templates", type=Path)
        subparser.add_argument("--venvs", type=Path)
        subparser.add_argument("--tasks", nargs="+", default=DEFAULT_TASKS)

    calibrate_parser = subparsers.add_parser("calibrate")
    common(calibrate_parser)
    calibrate_parser.add_argument("--out", type=Path, required=True)
    calibrate_parser.add_argument("--timeout", type=int, default=300)
    calibrate_parser.add_argument("--model", default="opencode-go/deepseek-v4.1-flash")
    calibrate_parser.add_argument("--reasoning-effort", default="low")

    setup_parser = subparsers.add_parser("setup")
    common(setup_parser)
    setup_parser.add_argument("--experiment", type=Path, required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--experiment", type=Path, required=True)
    run_parser.add_argument("--tasks", nargs="+", default=DEFAULT_TASKS)
    run_parser.add_argument("--arms", nargs="+", default=DEFAULT_ARMS)
    run_parser.add_argument("--repeats", type=int, default=3)
    run_parser.add_argument("--concurrency", type=int, default=2)
    run_parser.add_argument("--agent-timeout", type=int, default=900)
    run_parser.add_argument("--test-timeout", type=int, default=300)
    run_parser.add_argument("--protect-paths", type=Path, nargs="*", default=[])
    run_parser.add_argument(
        "--codex-bin",
        type=Path,
        default=Path(
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/"
            "CodexCLI.app/Contents/MacOS/codex"
        ),
    )
    run_parser.add_argument("--skill-root", type=Path, default=Path(__file__).resolve().parents[3])
    run_parser.add_argument("--model", default="opencode-go/deepseek-v4.1-flash")
    run_parser.add_argument("--reasoning-effort", default="low")
    run_parser.add_argument(
        "--base-url", default="http://127.0.0.1:3425/backend-api/codex"
    )

    summarize_parser = subparsers.add_parser("summarize")
    summarize_parser.add_argument("--experiment", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.command == "calibrate":
        calibrate(args)
    elif args.command == "setup":
        if not args.dataset or not args.templates or not args.venvs:
            raise SystemExit("setup requires --dataset, --templates and --venvs")
        install_experiment_assets(
            dataset=args.dataset,
            templates_source=args.templates,
            venvs_source=args.venvs,
            experiment=args.experiment,
            tasks=args.tasks,
        )
    elif args.command == "run":
        run_experiment(args)
    elif args.command == "summarize":
        summarize(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
