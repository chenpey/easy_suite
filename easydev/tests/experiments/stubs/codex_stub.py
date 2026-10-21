#!/usr/bin/env python3
"""Stand-in for ``codex exec ...`` used by the offline CLI tests.

The runner exports ``EASYDEV_STUB_PLAN`` pointing at a JSON file.  Supported
keys (all optional):

``events``
    Minimum number of valid JSONL events to emit.  Agent messages, reviewer
    events and the ``turn.completed`` event count toward it; neutral
    ``item.completed`` events pad the rest.
``agent_messages``
    Ordered ``item.completed`` / ``agent_message`` texts.  The analyzer treats
    every message except the last as the initial-route sample.
``reviewer``
    Emit one ``spawn_agent`` call plus a completed ``wait`` state whose report
    is ``reviewer_report``.
``reviewer_report``
    Text of the completed reviewer report.
``commands``
    Shell command strings emitted as completed ``command_execution`` events, so
    attribution can count content reads.
``usage``
    Token usage object attached to ``turn.completed``.
``mutations``
    ``[{"path": ..., "content": ...}]`` written relative to ``-C``.
``append_files``
    ``[{"path": ..., "content": ...}]`` appended to existing files.
``post_stage_mutations``
    Mutations applied after ``stage`` (for a staged change reverted in the
    worktree).
``git_commands``
    ``[["git", "update-index", ...], ...]`` executed in the worktree.
``marker_file``
    Append one line per stub invocation, for idempotency checks.
``stage``
    Run ``git add -A`` after the mutations.
``runtime_skill_edit``
    Append a marker to ``<workdir>/.agents/skills/easydev/SKILL.md``.
``invalid_events``
    ``true``/``"malformed"`` appends one malformed line;
    ``"missing_turn_completed"`` omits the ``turn.completed`` event.
``malformed_lines``
    Number of malformed lines to append (default 1 when enabled).
``exit_code``
    Process exit status (default 0).
``sleep_seconds``
    Sleep after the pid/mode probes and before writing events.
``spawn_child`` / ``child_pid_file``
    Start a grandchild process and write its pid to an absolute path.
``pid_file``
    Write this stub's pid to an absolute path.
``mode_probes``
    ``[{"path": ..., "output": ...}]`` records the POSIX mode of ``path``.
``file_probes``
    ``[{"path": ..., "output": ...}]`` copies a file's text to ``output``.
``chmod_files``
    ``[{"path": ..., "mode": 0o755}]`` applies an octal mode after mutations.
``final_message``
    Content written to the ``-o`` path (defaults to the last agent message).

The stub never imports the modules under test.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple


FLAGS_WITH_VALUE = {"-C", "-o", "-c", "-s", "-m", "--sandbox"}
SKIPPED_FLAGS = {"exec", "--json", "--ephemeral", "--skip-git-repo-check"}


def parse_args(argv: List[str]) -> Tuple[Path, Optional[Path], str]:
    workdir = Path(".")
    last_message: Optional[Path] = None
    prompt: List[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in FLAGS_WITH_VALUE:
            value = argv[index + 1] if index + 1 < len(argv) else ""
            if token == "-C":
                workdir = Path(value)
            elif token == "-o":
                last_message = Path(value)
            index += 2
            continue
        if token in SKIPPED_FLAGS:
            index += 1
            continue
        prompt.append(token)
        index += 1
    return workdir, last_message, " ".join(prompt)


def load_plan() -> Dict[str, object]:
    plan_path = os.environ.get("EASYDEV_STUB_PLAN")
    if not plan_path:
        return {}
    return json.loads(Path(plan_path).read_text(encoding="utf-8"))


def valid_events(plan: Dict[str, object]) -> List[Dict[str, object]]:
    events: List[Dict[str, object]] = []
    for index, text in enumerate(plan.get("agent_messages") or []):
        events.append(
            {
                "type": "item.completed",
                "item": {
                    "id": f"msg-{index}",
                    "type": "agent_message",
                    "text": text,
                },
            }
        )
    reviewer = plan.get("reviewer")
    if reviewer:
        if isinstance(reviewer, dict):
            reviewer_status = reviewer.get("status", "completed")
            reviewer_message = reviewer.get("message", "")
            reviewer_tool = reviewer.get("tool", "wait")
        else:
            reviewer_status = "completed"
            reviewer_message = plan.get("reviewer_report", "")
            reviewer_tool = "wait"
        events.append(
            {
                "type": "item.completed",
                "item": {
                    "id": "spawn-1",
                    "type": "collab_tool_call",
                    "tool": "spawn_agent",
                    "receiver_thread_ids": ["reviewer-1"],
                    "prompt": "独立只读审查 independent read-only reviewer",
                },
            }
        )
        events.append(
            {
                "type": "item.completed",
                "item": {
                    "id": "wait-1",
                    "type": "collab_tool_call",
                    "tool": reviewer_tool,
                    "agents_states": {
                        "reviewer-1": {
                            "status": reviewer_status,
                            "message": reviewer_message,
                        }
                    },
                },
            }
        )
    for index, command in enumerate(plan.get("commands") or []):
        events.append(
            {
                "type": "item.completed",
                "item": {
                    "id": f"cmd-{index}",
                    "type": "command_execution",
                    "command": command,
                    "exit_code": 0,
                },
            }
        )
    target = int(plan.get("events") or 0)
    padding = max(0, target - len(events) - 1)
    for index in range(padding):
        events.append(
            {
                "type": "item.completed",
                "item": {"id": f"pad-{index}", "type": "reasoning"},
            }
        )
    if plan.get("invalid_events") != "missing_turn_completed":
        events.append(
            {
                "type": "turn.completed",
                "usage": plan.get("usage") or {},
            }
        )
    return events


def write_pid(path_value: object) -> None:
    if not path_value:
        return
    path = Path(str(path_value))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{os.getpid()}\n", encoding="utf-8")


def observe_modes(probes: object) -> None:
    for probe in probes or []:
        source = Path(str(probe["path"]))
        output = Path(str(probe["output"]))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(f"{source.stat().st_mode & 0o777:o}\n", encoding="utf-8")


def apply_mutations(workdir: Path, mutations: object) -> None:
    for mutation in mutations or []:
        target = Path(str(mutation["path"]))
        if not target.is_absolute():
            target = workdir / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(mutation["content"]), encoding="utf-8")


def append_files(workdir: Path, entries: object) -> None:
    for entry in entries or []:
        target = Path(str(entry["path"]))
        if not target.is_absolute():
            target = workdir / target
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(str(entry["content"]))


def chmod_files(workdir: Path, entries: object) -> None:
    for entry in entries or []:
        target = Path(str(entry["path"]))
        if not target.is_absolute():
            target = workdir / target
        target.chmod(int(entry["mode"]))


def probe_files(workdir: Path, entries: object) -> None:
    for entry in entries or []:
        source = Path(str(entry["path"]))
        if not source.is_absolute():
            source = workdir / source
        output = Path(str(entry["output"]))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def main(argv: List[str]) -> int:
    workdir, last_message, _prompt = parse_args(argv)
    plan = load_plan()
    if plan.get("marker_file"):
        marker = Path(str(plan["marker_file"]))
        marker.parent.mkdir(parents=True, exist_ok=True)
        with marker.open("a", encoding="utf-8") as handle:
            handle.write(f"run {os.getpid()}\n")
    write_pid(plan.get("pid_file"))
    if plan.get("spawn_child"):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if plan.get("child_pid_file"):
            child_pid_file = Path(str(plan["child_pid_file"]))
            child_pid_file.parent.mkdir(parents=True, exist_ok=True)
            child_pid_file.write_text(f"{child.pid}\n", encoding="utf-8")
    observe_modes(plan.get("mode_probes"))
    probe_files(workdir, plan.get("file_probes"))
    sleep_seconds = float(plan.get("sleep_seconds") or 0)
    if sleep_seconds:
        time.sleep(sleep_seconds)

    for event in valid_events(plan):
        print(json.dumps(event, ensure_ascii=False), flush=True)
    invalid_events = plan.get("invalid_events")
    if invalid_events in {True, "malformed"}:
        for _ in range(int(plan.get("malformed_lines") or 1)):
            print("{not-json", flush=True)

    apply_mutations(workdir, plan.get("mutations"))
    append_files(workdir, plan.get("append_files"))
    if plan.get("stage"):
        subprocess.run(
            ["git", "add", "-A"],
            cwd=str(workdir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=60,
        )
    apply_mutations(workdir, plan.get("post_stage_mutations"))
    chmod_files(workdir, plan.get("chmod_files"))
    for command in plan.get("git_commands") or []:
        subprocess.run(
            [str(part) for part in command],
            cwd=str(workdir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=60,
        )
    if plan.get("runtime_skill_edit"):
        skill = workdir / ".agents" / "skills" / "easydev" / "SKILL.md"
        skill.write_text(
            skill.read_text(encoding="utf-8") + "\n# stub runtime edit\n",
            encoding="utf-8",
        )
    if last_message is not None:
        messages = plan.get("agent_messages") or []
        content = plan.get("final_message")
        if content is None:
            content = messages[-1] if messages else ""
        last_message.parent.mkdir(parents=True, exist_ok=True)
        last_message.write_text(str(content), encoding="utf-8")
    return int(plan.get("exit_code") or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
