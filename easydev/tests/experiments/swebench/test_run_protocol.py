#!/usr/bin/env python3
"""Behavior contracts for stored SWE-bench run evidence.

Coverage gap: these checks protect the boundary between a completed Agent
invocation and an aggregatable result. They exercise the protocol and reader
together so a valid-looking result cannot pass without matching invocation,
test, dataset, and event evidence.
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from protocol import is_valid_invocation, is_valid_result
from run import (
    baseline_eligible_p2p,
    capture_patch,
    init_repo,
    markdown_report,
    parse_events,
    read_json_object,
    read_results,
    write_json,
)


def valid_result() -> dict:
    return {
        "result_protocol": 2,
        "agent_returncode": 0,
        "turn_completed": True,
        "agent_timed_out": False,
        "events": 1,
        "malformed_event_lines": 0,
        "task_id": "task",
        "arm": "easydev",
        "repeat": 1,
        "resolved": True,
        "f2p_pass": True,
        "f2p_status": {"test_f2p": "PASSED"},
        "p2p_regressions": [],
        "test_statuses": {
            "test_f2p": "PASSED",
            "test_p2p": "PASSED",
        },
        "patch_applied": True,
        "wall_seconds": 1.0,
        "tool_calls": 1,
        "usage": {},
    }


def write_task_contracts(experiment: Path) -> None:
    write_json(
        experiment / "dataset.json",
        [
            {
                "instance_id": "task",
                "FAIL_TO_PASS": json.dumps(["test_f2p"]),
                "PASS_TO_PASS": json.dumps(["test_p2p"]),
            }
        ],
    )
    write_json(
        experiment / "task-baselines" / "task.json",
        {
            "eligible_p2p": ["test_p2p"],
            "excluded_p2p": [],
            "statuses": {"test_p2p": "PASSED"},
            "pytest_returncode": 0,
        },
    )


def run_result_path(experiment: Path, repeat: str = "r1") -> Path:
    return experiment / "runs" / "task" / "easydev" / repeat / "result.json"


def write_event_stream(result_path: Path, *, turn_completed: bool = True) -> None:
    event = {"type": "turn.completed", "usage": {}}
    if not turn_completed:
        event = {
            "type": "item.completed",
            "item": {"type": "agent_message", "text": "x"},
        }
    (result_path.parent / "events.jsonl").write_text(
        json.dumps(event) + "\n",
        encoding="utf-8",
    )


class InvocationContractTest(unittest.TestCase):
    def test_invocation_requires_one_complete_successful_event_stream(self) -> None:
        cases = (
            (
                "missing protocol",
                lambda value: value.pop("result_protocol"),
            ),
            (
                "legacy protocol",
                lambda value: value.update(result_protocol=1),
            ),
            (
                "nonzero exit",
                lambda value: value.update(agent_returncode=1),
            ),
            (
                "unfinished turn",
                lambda value: value.update(turn_completed=False),
            ),
            (
                "timed out",
                lambda value: value.update(agent_timed_out=True),
            ),
            (
                "no events",
                lambda value: value.update(events=0),
            ),
            (
                "malformed event",
                lambda value: value.update(malformed_event_lines=1),
            ),
            (
                "missing malformed count",
                lambda value: value.pop("malformed_event_lines"),
            ),
            (
                "boolean event count",
                lambda value: value.update(events=True),
            ),
        )

        with self.subTest(case="complete invocation"):
            self.assertTrue(is_valid_invocation(valid_result()))
        for label, mutate in cases:
            with self.subTest(case=label):
                result = valid_result()
                mutate(result)
                self.assertFalse(is_valid_invocation(result))


class StoredResultContractTest(unittest.TestCase):
    def test_result_requires_coherent_test_and_usage_evidence(self) -> None:
        def taint_status(value: dict) -> None:
            value["test_statuses"]["test_p2p"] = ["bad"]

        def add_unexpected_test(value: dict) -> None:
            value["test_statuses"]["untracked_test"] = "FAILED"

        def missing_p2p_evidence(value: dict) -> None:
            value.update(
                resolved=False,
                f2p_pass=False,
                f2p_status={"test_f2p": "FAILED"},
                test_statuses={"test_f2p": "FAILED"},
            )

        def failed_p2p_marked_resolved(value: dict) -> None:
            value["test_statuses"]["test_p2p"] = "FAILED"

        def contradictory_f2p(value: dict) -> None:
            value["f2p_status"]["test_f2p"] = "FAILED"

        def recorded_regression(value: dict) -> None:
            value.update(
                resolved=False,
                test_statuses={
                    "test_f2p": "PASSED",
                    "test_p2p": "FAILED",
                },
                p2p_regressions=["test_p2p"],
            )

        def resolved_without_patch(value: dict) -> None:
            value["patch_applied"] = False

        invalid_cases = (
            ("missing arm", lambda value: value.pop("arm")),
            (
                "nonnumeric usage",
                lambda value: value.update(usage={"input_tokens": "bad"}),
            ),
            (
                "cached tokens exceed input",
                lambda value: value.update(
                    usage={"input_tokens": 10, "cached_input_tokens": 11}
                ),
            ),
            ("regression marked resolved", failed_p2p_marked_resolved),
            ("missing p2p evidence", missing_p2p_evidence),
            ("contradictory f2p status", contradictory_f2p),
            ("invalid status value", taint_status),
            ("unexpected test", add_unexpected_test),
            ("resolved without patch", resolved_without_patch),
        )

        with self.subTest(case="coherent successful result"):
            self.assertTrue(is_valid_result(valid_result()))
        with self.subTest(case="recorded regression"):
            regression = valid_result()
            recorded_regression(regression)
            self.assertTrue(
                is_valid_result(
                    regression,
                    expected_f2p=["test_f2p"],
                    expected_p2p=["test_p2p"],
                )
            )
        for label, mutate in invalid_cases:
            with self.subTest(case=label):
                result = valid_result()
                mutate(result)
                self.assertFalse(
                    is_valid_result(
                        result,
                        expected_f2p=["test_f2p"],
                        expected_p2p=["test_p2p"],
                    )
                )

    def test_result_identity_filters_reject_wrong_task_arm_repeat_or_tests(self) -> None:
        cases = (
            ("task", {"expected_task_id": "other"}),
            ("arm", {"expected_arm": "baseline"}),
            ("repeat", {"expected_repeat": 2}),
            ("f2p contract", {"expected_f2p": ["other"]}),
        )
        with self.subTest(case="matching filters"):
            self.assertTrue(
                is_valid_result(
                    valid_result(),
                    expected_task_id="task",
                    expected_arm="easydev",
                    expected_repeat=1,
                    expected_f2p=["test_f2p"],
                    expected_p2p=["test_p2p"],
                )
            )
        for label, filters in cases:
            with self.subTest(case=label):
                self.assertFalse(is_valid_result(valid_result(), **filters))


class EventStreamContractTest(unittest.TestCase):
    def test_parser_rejects_malformed_event_shapes(self) -> None:
        lines = {
            "invalid json": "{not-json}",
            "array": "[]",
            "null": "null",
            "number": "1",
            "string": '"text"',
            "missing type": "{}",
            "non-object item": '{"type":"item.completed","item":[]}',
            "non-string receiver": (
                '{"type":"item.completed","item":'
                '{"type":"collab_tool_call","receiver_thread_ids":"reviewer-1"}}'
            ),
            "non-object review state": (
                '{"type":"item.completed","item":'
                '{"type":"collab_tool_call","agents_states":'
                '{"reviewer-1":"completed"}}}'
            ),
            "non-string message": (
                '{"type":"item.completed","item":'
                '{"type":"agent_message","text":["not","text"]}}'
            ),
            "boolean usage": '{"type":"turn.completed","usage":{"input_tokens":true}}',
            "negative usage": '{"type":"turn.completed","usage":{"input_tokens":-1}}',
            "cache exceeds input": (
                '{"type":"turn.completed","usage":'
                '{"input_tokens":10,"cached_input_tokens":11}}'
            ),
        }
        for label, line in lines.items():
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    events_path = Path(temporary) / "events.jsonl"
                    events_path.write_text(line + "\n", encoding="utf-8")
                    parsed = parse_events(events_path)
                self.assertEqual(parsed["events"], 0)
                self.assertEqual(parsed["malformed_event_lines"], 1)

    def test_parser_retains_valid_completion_and_message_evidence(self) -> None:
        events = (
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "finished"},
            },
            {
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 4,
                    "output_tokens": 2,
                },
            },
        )
        with tempfile.TemporaryDirectory() as temporary:
            events_path = Path(temporary) / "events.jsonl"
            events_path.write_text(
                "\n".join(json.dumps(event) for event in events) + "\n",
                encoding="utf-8",
            )
            parsed = parse_events(events_path)

        self.assertTrue(parsed["turn_completed"])
        self.assertEqual(parsed["final_message"], "finished")
        self.assertEqual(parsed["events"], 2)
        self.assertEqual(parsed["malformed_event_lines"], 0)
        self.assertEqual(
            parsed["usage"],
            {
                "input_tokens": 10,
                "cached_input_tokens": 4,
                "output_tokens": 2,
            },
        )


class StoredResultReaderTest(unittest.TestCase):
    def test_reader_uses_manifest_tasks_and_rejects_invalid_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            write_json(experiment / "manifest.json", {"tasks": ["task"]})

            self.assertEqual(read_results(experiment), [])

            write_json(experiment / "manifest.json", {"tasks": ["task", "task"]})
            with self.assertRaisesRegex(ValueError, "manifest tasks"):
                read_results(experiment)

    def test_reader_validates_runs_missing_from_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            dataset = json.loads(
                (experiment / "dataset.json").read_text(encoding="utf-8")
            )
            dataset.append(
                {
                    "instance_id": "unlisted",
                    "FAIL_TO_PASS": json.dumps(["other_f2p"]),
                    "PASS_TO_PASS": json.dumps(["other_p2p"]),
                }
            )
            write_json(experiment / "dataset.json", dataset)
            write_json(experiment / "manifest.json", {"tasks": ["task"]})
            result_path = (
                experiment
                / "runs"
                / "unlisted"
                / "easydev"
                / "r1"
                / "result.json"
            )
            result_path.parent.mkdir(parents=True)
            write_json(result_path, valid_result())

            with self.assertRaisesRegex(ValueError, "task baseline"):
                read_results(experiment)

    def test_reader_accepts_unlisted_tests_in_baseline_statuses(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            baseline_path = experiment / "task-baselines" / "task.json"
            baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
            baseline["statuses"]["test_unlisted"] = "PASSED"
            write_json(baseline_path, baseline)
            result_path = run_result_path(experiment)
            result_path.parent.mkdir(parents=True)
            write_json(result_path, valid_result())
            write_event_stream(result_path)

            self.assertEqual(read_results(experiment), [valid_result()])

    def test_reader_ignores_unselected_dataset_rows_without_baselines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            dataset = json.loads(
                (experiment / "dataset.json").read_text(encoding="utf-8")
            )
            dataset.append(
                {
                    "instance_id": "unselected",
                    "FAIL_TO_PASS": json.dumps(["other_f2p"]),
                    "PASS_TO_PASS": json.dumps(["other_p2p"]),
                }
            )
            write_json(experiment / "dataset.json", dataset)

            result_path = run_result_path(experiment)
            result_path.parent.mkdir(parents=True)
            write_json(result_path, valid_result())
            write_event_stream(result_path)

            self.assertEqual(read_results(experiment), [valid_result()])

    def test_reader_requires_complete_events_and_matching_directory_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            result_path = run_result_path(experiment)
            result_path.parent.mkdir(parents=True)
            write_json(result_path, valid_result())

            with self.subTest(case="events missing"):
                self.assertEqual(read_results(experiment), [])

            write_event_stream(result_path)
            with self.subTest(case="complete artifact"):
                self.assertEqual(read_results(experiment), [valid_result()])

            bad_repeat = result_path.parent.with_name("rfoo")
            bad_repeat.mkdir()
            write_json(bad_repeat / "result.json", valid_result())
            write_event_stream(bad_repeat / "result.json")
            with self.subTest(case="invalid repeat directory"):
                self.assertEqual(read_results(experiment), [valid_result()])

    def test_reader_ignores_corrupt_result_and_writes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            result_path = run_result_path(experiment)
            result_path.parent.mkdir(parents=True)
            result_path.write_text('{"task_id":', encoding="utf-8")

            self.assertEqual(read_json_object(result_path), {})
            self.assertEqual(read_results(experiment), [])

            write_json(result_path, valid_result())
            write_event_stream(result_path)
            self.assertEqual(read_json_object(result_path), valid_result())
            self.assertEqual(read_results(experiment), [valid_result()])
            self.assertEqual(list(result_path.parent.glob(".*.tmp")), [])

    def test_reader_fails_closed_on_invalid_dataset_or_baseline(self) -> None:
        def missing_dataset(experiment: Path) -> None:
            return

        def empty_dataset(experiment: Path) -> None:
            (experiment / "dataset.json").write_text("[]", encoding="utf-8")

        def corrupt_dataset(experiment: Path) -> None:
            (experiment / "dataset.json").write_text("{broken", encoding="utf-8")

        def missing_baseline(experiment: Path) -> None:
            write_task_contracts(experiment)
            (experiment / "task-baselines" / "task.json").unlink()

        def inconsistent_baseline(experiment: Path) -> None:
            write_task_contracts(experiment)
            write_json(
                experiment / "task-baselines" / "task.json",
                {
                    "eligible_p2p": [],
                    "excluded_p2p": [],
                    "statuses": {"test_p2p": "PASSED"},
                    "pytest_returncode": 0,
                },
            )

        cases = (
            ("missing dataset", missing_dataset, "dataset is required"),
            ("empty dataset", empty_dataset, "non-empty JSON array"),
            ("corrupt dataset", corrupt_dataset, "experiment dataset"),
            ("missing baseline", missing_baseline, "task baseline"),
            (
                "inconsistent baseline",
                inconsistent_baseline,
                "does not match baseline statuses",
            ),
        )
        for label, prepare, message in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    experiment = Path(temporary)
                    prepare(experiment)
                    with self.assertRaisesRegex(ValueError, message):
                        read_results(experiment)

    def test_reader_rejects_result_counts_that_disagree_with_events(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            write_task_contracts(experiment)
            result_path = run_result_path(experiment)
            result_path.parent.mkdir(parents=True)

            for label, event_count in (("too few", 0), ("too many", 2)):
                with self.subTest(case=label):
                    result = valid_result()
                    result["events"] = event_count
                    write_json(result_path, copy.deepcopy(result))
                    write_event_stream(result_path)
                    self.assertEqual(read_results(experiment), [])

            result = valid_result()
            write_json(result_path, result)
            write_event_stream(result_path, turn_completed=False)
            with self.subTest(case="no completed turn"):
                self.assertEqual(read_results(experiment), [])


class ReportRenderingTest(unittest.TestCase):
    def test_report_uses_actual_task_count(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            manifest_tasks = [f"task-{index}" for index in range(5)]
            write_json(
                experiment / "manifest.json",
                {
                    "model": "test-model",
                    "reasoning_effort": "high",
                    "tasks": manifest_tasks,
                },
            )
            results = []
            for task_id in manifest_tasks[:2]:
                result = valid_result()
                result["task_id"] = task_id
                results.append(result)

            report = markdown_report(experiment, results)

            self.assertIn("- 任务数：2", report)
            self.assertIn("- 校准清单：5 个任务", report)
            self.assertIn("2 个任务下区间很粗", report)
            self.assertIn("只覆盖 2 个 SWE-bench Lite 任务", report)
            self.assertNotIn("- 任务数：5", report)


class BaselineSelectionTest(unittest.TestCase):
    def test_eligible_p2p_only_contains_official_contract_tests(self) -> None:
        task = {
            "FAIL_TO_PASS": ["tests/test_x.py::test_f2p"],
            "PASS_TO_PASS": [
                "tests/test_x.py::test_official",
                "tests/test_x.py::test_skipped",
                "tests/test_x.py::test_failed",
            ],
        }
        statuses = {
            "tests/test_x.py::test_f2p": "FAILED",
            "tests/test_x.py::test_official": "PASSED",
            "tests/test_x.py::test_skipped": "SKIPPED",
            "tests/test_x.py::test_failed": "FAILED",
            "tests/test_x.py::test_unlisted": "FAILED",
        }

        self.assertEqual(
            baseline_eligible_p2p(task, statuses),
            [
                "tests/test_x.py::test_official",
                "tests/test_x.py::test_skipped",
            ],
        )


@unittest.skipUnless(os.name == "posix", "Git shells are POSIX-specific")
class PatchCaptureProtectionTest(unittest.TestCase):
    def test_capture_does_not_execute_agent_hook_or_clean_filter(self) -> None:
        with self.subTest(case="post-index hook"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                source = workspace / "source.py"
                source.write_text("VALUE = 1\n", encoding="utf-8")
                base_sha = init_repo(workspace, "task")
                trusted_config = (workspace / ".git" / "config").read_bytes()
                marker = workspace / "hook-ran"
                hook = workspace / ".git" / "hooks" / "post-index-change"
                hook.write_text(
                    "#!/bin/sh\n"
                    f"printf ran > {str(marker)!r}\n"
                    f"printf 'VALUE = 99\\n' > {str(source)!r}\n",
                    encoding="utf-8",
                )
                hook.chmod(0o755)
                subprocess.run(
                    ["git", "config", "core.hooksPath", ".git/hooks"],
                    cwd=workspace,
                    check=True,
                )
                source.write_text("VALUE = 2\n", encoding="utf-8")

                captured = capture_patch(
                    workspace,
                    base_sha,
                    {"test_patch": ""},
                    trusted_config,
                )

                self.assertFalse(marker.exists())
                self.assertEqual(source.read_text(encoding="utf-8"), "VALUE = 2\n")
                self.assertIn("+VALUE = 2", captured["patch"])
                self.assertNotIn("+VALUE = 99", captured["patch"])
                self.assertIn(
                    "hooksPath = .git/hooks",
                    (workspace / ".git" / "config").read_text(encoding="utf-8"),
                )

        with self.subTest(case="clean filter"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                source = workspace / "source.py"
                source.write_text("VALUE = 1\n", encoding="utf-8")
                base_sha = init_repo(workspace, "task")
                trusted_config = (workspace / ".git" / "config").read_bytes()
                marker = Path(temporary) / "filter-ran"
                filter_script = Path(temporary) / "clean-filter.sh"
                filter_script.write_text(
                    "#!/bin/sh\n"
                    f"printf ran > {str(marker)!r}\n"
                    "cat\n",
                    encoding="utf-8",
                )
                filter_script.chmod(0o755)
                (workspace / ".gitattributes").write_text(
                    "*.py filter=agent-clean\n",
                    encoding="utf-8",
                )
                subprocess.run(
                    [
                        "git",
                        "config",
                        "filter.agent-clean.clean",
                        str(filter_script),
                    ],
                    cwd=workspace,
                    check=True,
                )
                source.write_text("VALUE = 2\n", encoding="utf-8")

                captured = capture_patch(
                    workspace,
                    base_sha,
                    {"test_patch": ""},
                    trusted_config,
                )

                self.assertFalse(marker.exists())
                self.assertEqual(source.read_text(encoding="utf-8"), "VALUE = 2\n")
                self.assertIn("+VALUE = 2", captured["patch"])
                self.assertIn(
                    str(filter_script),
                    (workspace / ".git" / "config").read_text(encoding="utf-8"),
                )


if __name__ == "__main__":
    unittest.main()
