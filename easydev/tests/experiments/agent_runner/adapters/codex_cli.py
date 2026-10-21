"""Codex CLI adapter used by the behavior runner."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


EXPERIMENTS_ROOT = Path(__file__).resolve().parents[2]
if str(EXPERIMENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_ROOT))
SWEBENCH_ROOT = EXPERIMENTS_ROOT / "swebench"
if str(SWEBENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(SWEBENCH_ROOT))

from process_control import terminate_process, wait_for_process  # noqa: E402
from protocol import TOKEN_FIELDS, is_valid_event  # noqa: E402


def prepare_codex_environment(run_dir: Path, auth_path: Path) -> Dict[str, str]:
    if not auth_path.exists():
        raise RuntimeError(f"missing Codex auth file: {auth_path}")
    codex_home = run_dir / "codex-home"
    home = run_dir / "home"
    codex_home.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    codex_home.chmod(0o700)
    home.chmod(0o700)
    run_dir.chmod(0o700)
    auth_link = codex_home / "auth.json"
    if not auth_link.exists():
        auth_link.symlink_to(auth_path)
    env = os.environ.copy()
    for key in ("CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"):
        env.pop(key, None)
    env.update(
        {
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    return env


def parse_events(events_path: Path) -> Dict[str, Any]:
    turn_completed = False
    final_message = ""
    agent_messages: List[str] = []
    usage: Dict[str, int] = {}
    event_count = 0
    malformed = 0
    if not events_path.exists():
        return {
            "turn_completed": False,
            "final_message": "",
            "agent_messages": [],
            "usage": {},
            "event_count": 0,
            "malformed_event_lines": 0,
        }
    for line in events_path.read_text(
        encoding="utf-8", errors="replace"
    ).splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            malformed += 1
            continue
        if not is_valid_event(event):
            malformed += 1
            continue
        event_type = event["type"]
        item = event.get("item")
        usage_value = event.get("usage")
        event_count += 1
        if event_type == "turn.completed":
            turn_completed = True
            usage = {
                key: int(value)
                for key, value in (usage_value or {}).items()
                if (
                    key in TOKEN_FIELDS
                    and isinstance(value, int)
                    and not isinstance(value, bool)
                    and value >= 0
                )
            }
        if event_type == "item.completed" and item and item.get("type") == "agent_message":
            text = item.get("text")
            if isinstance(text, str):
                agent_messages.append(text)
                final_message = text
    return {
        "turn_completed": turn_completed,
        "final_message": final_message,
        "agent_messages": agent_messages,
        "usage": usage,
        "event_count": event_count,
        "malformed_event_lines": malformed,
    }


def _terminate_process(process: subprocess.Popen, grace_seconds: float = 5.0) -> None:
    terminate_process(process, grace_seconds=grace_seconds)


def run_codex(
    *,
    workspace: Path,
    run_dir: Path,
    prompt: str,
    codex_bin: Path,
    auth_path: Path,
    model: Optional[str],
    reasoning_effort: Optional[str],
    base_url: Optional[str],
    timeout: int,
) -> Dict[str, Any]:
    events_path = run_dir / "events.jsonl"
    stderr_path = run_dir / "stderr.log"
    last_message_path = run_dir / "last-message.txt"
    env = prepare_codex_environment(run_dir, auth_path)
    command = [
        str(codex_bin),
        "exec",
        "--ephemeral",
        "-s",
        "workspace-write",
        "-C",
        str(workspace),
        "--json",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-o",
        str(last_message_path),
    ]
    if model:
        command.extend(["-c", f'model="{model}"'])
    if reasoning_effort and reasoning_effort != "inherit":
        command.extend(
            ["-c", f'model_reasoning_effort="{reasoning_effort}"']
        )
    if base_url:
        command.extend(["-c", f'openai_base_url="{base_url}"'])
    command.append(prompt)

    started = time.time()
    timed_out = False
    try:
        with events_path.open("w", encoding="utf-8") as events_file, stderr_path.open(
            "w", encoding="utf-8"
        ) as stderr_file:
            process_options = (
                {"start_new_session": True} if os.name == "posix" else {}
            )
            process = subprocess.Popen(
                command,
                cwd=str(workspace),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=events_file,
                stderr=stderr_file,
                text=True,
                errors="replace",
                **process_options,
            )
            returncode, tracked = wait_for_process(process, timeout)
            if returncode is None:
                timed_out = True
                terminate_process(process, tracked=tracked)
                returncode = process.wait()
    except OSError as error:
        returncode = -1
        stderr_path.write_text(f"{error}\n", encoding="utf-8")

    parsed = parse_events(events_path)
    if last_message_path.exists():
        parsed["final_message"] = last_message_path.read_text(
            encoding="utf-8", errors="replace"
        )
    parsed.update(
        {
            "returncode": returncode,
            "timed_out": timed_out,
            "wall_seconds": time.time() - started,
        }
    )
    return parsed
