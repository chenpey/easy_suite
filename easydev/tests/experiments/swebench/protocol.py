"""Result schemas shared by the SWE-bench runner and event analyzer."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Optional, Sequence


RESULT_PROTOCOL = 2
TOKEN_FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens")
TEST_STATUSES = {
    "PASSED",
    "FAILED",
    "ERROR",
    "SKIPPED",
    "XFAIL",
    "XPASS",
    "MISSING",
}
NON_REGRESSION_STATUSES = {"PASSED", "SKIPPED", "XFAIL"}


def _is_int(value: Any, *, positive: bool = False) -> bool:
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    return value > 0 if positive else value >= 0


def is_valid_event(event: Any) -> bool:
    """Validate the nested shapes used for tool and reviewer attribution."""
    if not isinstance(event, dict):
        return False
    event_type = event.get("type")
    if not isinstance(event_type, str) or not event_type:
        return False
    item = event.get("item")
    if item is not None and not isinstance(item, dict):
        return False
    if "usage" in event:
        usage = event["usage"]
        if not isinstance(usage, dict):
            return False
        if not all(
            key not in usage or _is_int(usage[key])
            for key in TOKEN_FIELDS
        ):
            return False
        input_tokens = usage.get("input_tokens")
        cached_tokens = usage.get("cached_input_tokens")
        if (
            input_tokens is not None
            and cached_tokens is not None
            and cached_tokens > input_tokens
        ):
            return False
    if not isinstance(item, dict):
        return True

    item_type = item.get("type")
    if item_type is not None and not isinstance(item_type, str):
        return False
    if item_type == "agent_message":
        text = item.get("text")
        if text is not None and not isinstance(text, str):
            return False
    if item_type == "command_execution":
        command = item.get("command")
        exit_code = item.get("exit_code")
        if command is not None and not isinstance(command, str):
            return False
        if (
            exit_code is not None
            and (isinstance(exit_code, bool) or not isinstance(exit_code, int))
        ):
            return False
    if item_type == "collab_tool_call":
        receiver_ids = item.get("receiver_thread_ids")
        if receiver_ids is not None and not (
            isinstance(receiver_ids, list)
            and all(isinstance(value, str) and value for value in receiver_ids)
        ):
            return False
        states = item.get("agents_states")
        if states is not None:
            if not isinstance(states, dict):
                return False
            for agent_id, state in states.items():
                if not isinstance(agent_id, str) or not isinstance(state, dict):
                    return False
                status = state.get("status")
                message = state.get("message")
                if status is not None and not isinstance(status, str):
                    return False
                if message is not None and not isinstance(message, str):
                    return False
    return True


def is_valid_invocation(result: Any) -> bool:
    """Return whether an agent invocation is complete under the current protocol."""
    return bool(
        isinstance(result, dict)
        and result.get("result_protocol") == RESULT_PROTOCOL
        and _is_int(result.get("agent_returncode"))
        and result.get("agent_returncode") == 0
        and result.get("turn_completed") is True
        and result.get("agent_timed_out") is False
        and _is_int(result.get("events"), positive=True)
        and _is_int(result.get("malformed_event_lines"))
        and result.get("malformed_event_lines") == 0
    )


def _valid_status_map(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return all(
        isinstance(key, str)
        and key
        and isinstance(status, str)
        and status in TEST_STATUSES
        for key, status in value.items()
    )


def is_valid_result(
    result: Any,
    *,
    expected_task_id: Any = None,
    expected_arm: Any = None,
    expected_repeat: Any = None,
    expected_f2p: Optional[Sequence[str]] = None,
    expected_p2p: Optional[Sequence[str]] = None,
) -> bool:
    """Return whether a stored run result is complete and safe to aggregate."""
    if not is_valid_invocation(result):
        return False
    wall_seconds = result.get("wall_seconds")
    usage = result.get("usage")
    p2p_regressions = result.get("p2p_regressions")
    f2p_status = result.get("f2p_status")
    test_statuses = result.get("test_statuses")
    valid_usage = bool(
        isinstance(usage, dict)
        and all(
            key not in usage or _is_int(usage[key])
            for key in TOKEN_FIELDS
        )
    )
    if valid_usage:
        input_tokens = usage.get("input_tokens")
        cached_tokens = usage.get("cached_input_tokens")
        valid_usage = bool(
            input_tokens is None
            or cached_tokens is None
            or cached_tokens <= input_tokens
        )
    valid_f2p_status = _valid_status_map(f2p_status) and bool(f2p_status)
    valid_test_statuses = _valid_status_map(test_statuses)
    expected_f2p_set = set(expected_f2p or ())
    expected_p2p_set = set(expected_p2p or ())
    f2p_consistent = bool(
        valid_f2p_status
        and isinstance(result.get("f2p_pass"), bool)
        and result["f2p_pass"]
        == all(status == "PASSED" for status in f2p_status.values())
    )
    status_values_consistent = bool(
        valid_f2p_status
        and valid_test_statuses
        and all(
            key not in test_statuses or test_statuses[key] == status
            for key, status in f2p_status.items()
        )
    )
    test_contract_consistent = bool(
        expected_f2p is None
        or expected_p2p is None
        or (
            valid_test_statuses
            and set(test_statuses) == (expected_f2p_set | expected_p2p_set)
        )
    )
    resolved_evidence = bool(
        not result.get("resolved")
        or (
            result.get("patch_applied") is True
            and result.get("f2p_pass") is True
            and valid_test_statuses
            and all(key in test_statuses for key in f2p_status)
        )
    )
    f2p_evidence = bool(
        not result.get("f2p_pass")
        or (
            result.get("patch_applied") is True
            and valid_test_statuses
            and all(
                test_statuses.get(key) == "PASSED"
                for key in f2p_status
            )
        )
    )
    valid_p2p_regressions = bool(
        isinstance(p2p_regressions, list)
        and all(isinstance(path, str) and path for path in p2p_regressions)
    )
    p2p_keys = (
        expected_p2p_set
        if expected_p2p is not None
        else set(test_statuses) - set(f2p_status)
        if valid_test_statuses and valid_f2p_status
        else set()
    )
    expected_p2p_regressions = {
        key
        for key in p2p_keys
        if valid_test_statuses
        and key in test_statuses
        and test_statuses[key] not in NON_REGRESSION_STATUSES
    }
    p2p_evidence = bool(
        valid_p2p_regressions
        and valid_test_statuses
        and p2p_keys.issubset(test_statuses)
        and len(p2p_regressions) == len(set(p2p_regressions))
        and set(p2p_regressions) == expected_p2p_regressions
    )
    valid = bool(
        isinstance(result.get("task_id"), str)
        and result["task_id"]
        and isinstance(result.get("arm"), str)
        and result["arm"]
        and _is_int(result.get("repeat"), positive=True)
        and isinstance(result.get("resolved"), bool)
        and f2p_consistent
        and valid_p2p_regressions
        and status_values_consistent
        and test_contract_consistent
        and p2p_evidence
        and isinstance(result.get("patch_applied"), bool)
        and isinstance(wall_seconds, (int, float))
        and not isinstance(wall_seconds, bool)
        and math.isfinite(wall_seconds)
        and wall_seconds >= 0
        and _is_int(result.get("tool_calls"))
        and valid_usage
        and result["resolved"] == (result["f2p_pass"] and not p2p_regressions)
        and resolved_evidence
        and f2p_evidence
    )
    if not valid:
        return False
    if expected_task_id is not None and result["task_id"] != expected_task_id:
        return False
    if expected_arm is not None and result["arm"] != expected_arm:
        return False
    if expected_repeat is not None and result["repeat"] != expected_repeat:
        return False
    if expected_f2p is not None and set(f2p_status) != expected_f2p_set:
        return False
    return True


def load_task_contracts(
    experiment: Path,
    task_ids: Optional[Sequence[str]] = None,
) -> Optional[dict[str, tuple[list[str], list[str]]]]:
    """Load contracts for selected tasks, or every dataset row by default."""
    dataset_path = experiment / "dataset.json"
    if not dataset_path.exists():
        return None
    try:
        dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot load experiment dataset {dataset_path}: {error}") from error
    if not isinstance(dataset, list) or not dataset:
        raise ValueError(
            f"experiment dataset must be a non-empty JSON array: {dataset_path}"
        )

    rows: dict[str, dict[str, Any]] = {}
    for row in dataset:
        if not isinstance(row, dict):
            raise ValueError("experiment dataset contains a non-object task row")
        task_id = row.get("instance_id")
        if (
            not isinstance(task_id, str)
            or not task_id
            or task_id in {".", ".."}
            or not all(char.isalnum() or char in "_.-" for char in task_id)
        ):
            raise ValueError(f"invalid task id in experiment dataset: {task_id!r}")
        if task_id in rows:
            raise ValueError(f"duplicate task id in experiment dataset: {task_id}")
        rows[task_id] = row

    selected = list(rows) if task_ids is None else list(dict.fromkeys(task_ids))
    missing = [task_id for task_id in selected if task_id not in rows]
    if missing:
        raise ValueError(
            "selected task ids are missing from experiment dataset: "
            + ", ".join(missing)
        )

    contracts: dict[str, tuple[list[str], list[str]]] = {}
    for task_id in selected:
        row = rows[task_id]
        f2p = row.get("FAIL_TO_PASS")
        if isinstance(f2p, str):
            try:
                f2p = json.loads(f2p)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid FAIL_TO_PASS for {task_id}") from error
        if not (
            isinstance(f2p, list)
            and f2p
            and all(isinstance(item, str) and item for item in f2p)
            and len(f2p) == len(set(f2p))
        ):
            raise ValueError(f"invalid FAIL_TO_PASS for {task_id}")
        p2p = row.get("PASS_TO_PASS")
        if isinstance(p2p, str):
            try:
                p2p = json.loads(p2p)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid PASS_TO_PASS for {task_id}") from error
        if not (
            isinstance(p2p, list)
            and all(isinstance(item, str) and item for item in p2p)
            and len(p2p) == len(set(p2p))
        ):
            raise ValueError(f"invalid PASS_TO_PASS for {task_id}")
        if set(f2p) & set(p2p):
            raise ValueError(f"overlapping F2P/P2P test contracts for {task_id}")

        baseline_path = experiment / "task-baselines" / f"{task_id}.json"
        try:
            baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError(
                f"cannot load task baseline for {task_id}: {error}"
            ) from error
        eligible_p2p = (
            baseline.get("eligible_p2p") if isinstance(baseline, dict) else None
        )
        if not (
            isinstance(eligible_p2p, list)
            and all(isinstance(item, str) and item for item in eligible_p2p)
            and len(eligible_p2p) == len(set(eligible_p2p))
        ):
            raise ValueError(f"invalid eligible_p2p baseline for {task_id}")
        statuses = baseline.get("statuses") if isinstance(baseline, dict) else None
        if not (
            isinstance(statuses, dict)
            and all(
                isinstance(nodeid, str)
                and nodeid
                and isinstance(status, str)
                and status in TEST_STATUSES
                for nodeid, status in statuses.items()
            )
        ):
            raise ValueError(f"invalid baseline test statuses for {task_id}")
        eligible_set = set(eligible_p2p)
        expected_eligible = sorted(
            nodeid
            for nodeid in p2p
            if statuses.get(nodeid) in NON_REGRESSION_STATUSES
        )
        if eligible_p2p != expected_eligible:
            raise ValueError(f"eligible_p2p does not match baseline statuses for {task_id}")
        excluded = baseline.get("excluded_p2p")
        expected_excluded = [
            {
                "nodeid": nodeid,
                "status": statuses.get(nodeid, "MISSING"),
            }
            for nodeid in p2p
            if nodeid not in eligible_set
        ]
        if excluded != expected_excluded:
            raise ValueError(f"excluded_p2p does not match task baseline for {task_id}")
        returncode = baseline.get("pytest_returncode")
        if isinstance(returncode, bool) or not isinstance(returncode, int):
            raise ValueError(f"invalid baseline pytest_returncode for {task_id}")
        contracts[task_id] = (list(f2p), list(eligible_p2p))
    return contracts


def events_match_result(result: Any, events_path: Path) -> bool:
    """Require the stored event stream to match the counters in a result."""
    if not is_valid_invocation(result) or not events_path.is_file():
        return False
    events = 0
    malformed = 0
    turn_completed = False
    try:
        lines = events_path.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()
    except OSError:
        return False
    for line in lines:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            malformed += 1
            continue
        if not is_valid_event(event):
            malformed += 1
            continue
        events += 1
        if event.get("type") == "turn.completed":
            turn_completed = True
    return bool(
        events == result.get("events")
        and malformed == result.get("malformed_event_lines")
        and turn_completed
    )


def is_valid_stored_result(
    result: Any,
    result_path: Path,
    *,
    expected_task_id: Any = None,
    expected_arm: Any = None,
    expected_repeat: Any = None,
    expected_f2p: Optional[Sequence[str]] = None,
    expected_p2p: Optional[Sequence[str]] = None,
) -> bool:
    """Validate result semantics and its matching events.jsonl artifact."""
    return bool(
        is_valid_result(
            result,
            expected_task_id=expected_task_id,
            expected_arm=expected_arm,
            expected_repeat=expected_repeat,
            expected_f2p=expected_f2p,
            expected_p2p=expected_p2p,
        )
        and events_match_result(result, result_path.parent / "events.jsonl")
    )
