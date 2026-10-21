#!/usr/bin/env python3
"""Behavior contracts for offline Agent event attribution.

Coverage gap: stored events must distinguish declared routes, completed
reviewers, concrete access, and valid protocol evidence without treating model
claims or malformed snapshots as facts. The cases below exercise those public
attribution behaviors as tables so input variants remain cheap while separate
failure reasons stay identifiable.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from analyze_events import (
    analyze_run,
    discover_runs,
    extract_closing_mentions,
    extract_files,
    extract_findings,
    extract_metadata_access,
    extract_modules,
    first_declared_path,
    has_pending_risks,
    has_positive_upgrade,
    has_zero_finding_statement,
    to_payload,
)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def write_events(run_dir: Path, events: list[dict]) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "events.jsonl").write_text(
        "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n",
        encoding="utf-8",
    )


def agent_message(message_id: str, text: str) -> dict:
    return {
        "type": "item.completed",
        "item": {"id": message_id, "type": "agent_message", "text": text},
    }


def command(item_id: str, value: str, exit_code: int = 0) -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": item_id,
            "type": "command_execution",
            "command": value,
            "exit_code": exit_code,
        },
    }


def spawn(reviewer_id: str = "reviewer-1") -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": "s1",
            "type": "collab_tool_call",
            "tool": "spawn_agent",
            "receiver_thread_ids": [reviewer_id],
            "prompt": "independent read-only reviewer",
        },
    }


def reviewer_state(
    reviewer_id: str = "reviewer-1",
    *,
    status: str = "completed",
    message: str = "在本次审查范围内未发现确定缺陷。",
    item_id: str = "w1",
    tool: str = "wait",
) -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": item_id,
            "type": "collab_tool_call",
            "tool": tool,
            "agents_states": {
                reviewer_id: {
                    "status": status,
                    "message": message,
                }
            },
        },
    }


def run_dir(experiment: Path, task: str = "task", repeat: int = 1) -> Path:
    return experiment / "runs" / task / "easydev" / f"r{repeat}"


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


def write_task_contracts(experiment: Path, *, second_f2p: str = "test_f2p") -> None:
    write_json(
        experiment / "dataset.json",
        [
            {
                "instance_id": "task",
                "FAIL_TO_PASS": json.dumps([second_f2p]),
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


class RouteAttributionTest(unittest.TestCase):
    def test_route_declarations_require_positive_formal_tier_text(self) -> None:
        declared_cases = (
            ("normal", "采用 full。", "full"),
            ("internal tier", "采用 full-local。", "full-local"),
            ("negated earlier tier", "不走 quick，采用 full。", "full"),
            ("negated historical tier", "没有采用 quick，最终采用 full。", "full"),
        )
        for label, text, expected in declared_cases:
            with self.subTest(case=label):
                self.assertEqual(first_declared_path(text), expected)

        upgrade_cases = (
            ("positive", "复核后升级到 full。", True),
            ("not upgraded", "未升级到 full。", False),
            ("no need", "无需升级到 full。", False),
            ("prohibited", "禁止升级到 full。", False),
            ("should not", "不应升级到 full。", False),
            ("candidate local", "升级到 full-local。", False),
            ("candidate staged", "升级到 full-staged。", False),
        )
        for label, text, expected in upgrade_cases:
            with self.subTest(case=f"upgrade {label}"):
                self.assertEqual(has_positive_upgrade(text), expected)

    def test_final_message_is_separate_from_initial_route_evidence(self) -> None:
        cases = (
            (
                "only final message",
                [agent_message("m1", "最终采用 quick。")],
                None,
                "quick",
                False,
            ),
            (
                "quick upgraded to full",
                [
                    agent_message("m1", "采用 quick，先核对影响面。"),
                    agent_message("m2", "最终采用 full。"),
                ],
                "quick",
                "full",
                True,
            ),
            (
                "quick denied upgrade",
                [
                    agent_message("m1", "采用 quick。"),
                    agent_message("m2", "未升级到 full，保持 quick。"),
                ],
                "quick",
                None,
                False,
            ),
            (
                "candidate tier is not upgrade",
                [
                    agent_message("m1", "采用 quick。"),
                    agent_message("m2", "最终采用 full-local。"),
                ],
                "quick",
                "full-local",
                False,
            ),
        )
        for label, events, initial, final, upgraded in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    experiment = Path(temporary)
                    directory = run_dir(experiment, f"route-{label}")
                    write_events(directory, events)
                    run = analyze_run(directory, experiment)
                self.assertEqual(run.declared_initial_path, initial)
                self.assertEqual(run.declared_final_path, final)
                self.assertEqual(run.upgraded_to_full, upgraded)


class ReviewerAttributionTest(unittest.TestCase):
    def test_reviewer_completion_requires_completed_wait_or_close_report(self) -> None:
        cases = (
            (
                "in progress",
                [spawn(), reviewer_state(status="in_progress")],
                1,
                0,
                0,
            ),
            (
                "empty completed report",
                [spawn(), reviewer_state(message="")],
                1,
                0,
                0,
            ),
            (
                "spawn cannot forge completion",
                [
                    {
                        **spawn(),
                        "item": {
                            **spawn()["item"],
                            "agents_states": {
                                "reviewer-1": {
                                    "status": "completed",
                                    "message": "未发现确定缺陷。",
                                }
                            },
                        },
                    }
                ],
                1,
                0,
                0,
            ),
            (
                "wait and close snapshot are deduplicated",
                [
                    spawn(),
                    spawn(),
                    reviewer_state(),
                    reviewer_state(item_id="c1", tool="close_agent"),
                ],
                1,
                1,
                1,
            ),
        )
        for label, events, instances, completed, reports in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    experiment = Path(temporary)
                    directory = run_dir(experiment, label.replace(" ", "-"))
                    write_events(directory, events)
                    run = analyze_run(directory, experiment)
                self.assertEqual(run.reviewer_instances, instances)
                self.assertEqual(run.reviewer_completed_instances, completed)
                self.assertEqual(run.reviewer_reports, reports)

    def test_reviewer_findings_override_zero_and_history_statements(self) -> None:
        report = (
            "**[P1] 所有权校验缺失**\n"
            "**[P2] 错误信息泄露**\n"
            "另有未发现确定缺陷的旧版本说明。\n"
            "无高影响待验证风险。"
        )
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            directory = run_dir(experiment)
            write_events(directory, [spawn(), reviewer_state(message=report)])
            run = analyze_run(directory, experiment)

        self.assertEqual(
            [(item.severity, item.title) for item in run.findings],
            [("P1", "所有权校验缺失"), ("P2", "错误信息泄露")],
        )
        self.assertFalse(run.reviewer_zero_findings)
        self.assertFalse(run.reviewer_pending_risks)


class FullAttributionTest(unittest.TestCase):
    def test_analyze_run_combines_route_review_access_usage_and_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            directory = run_dir(experiment, "task-a")
            write_json(
                directory / "result.json",
                {
                    "resolved": True,
                    "wall_seconds": 12.5,
                    "tool_calls": 3,
                    "usage": {
                        "input_tokens": 1000,
                        "cached_input_tokens": 800,
                        "output_tokens": 50,
                    },
                },
            )
            report = (
                "**[P1] 所有权校验缺失**\n"
                "**[P2] 错误信息泄露**\n"
                "待验证风险：上游身份来源。"
            )
            events = [
                agent_message("m1", "采用 quick，先复现问题。"),
                agent_message("m2", "复审后 P1 已关闭，P2 已关闭。"),
                command(
                    "c1",
                    "sed -n '1,200p' .agents/skills/easydev/SKILL.md",
                ),
                command(
                    "c2",
                    "sed -n '1,200p' .agents/skills/easydev/references/review.md",
                ),
                command("c3", "sed -n '1,120p' src/ledger.py"),
                {
                    **spawn(),
                    "item": {
                        **spawn()["item"],
                        "prompt": "你是独立只读审查者，请读取 references/review.md。",
                    },
                },
                reviewer_state(message=report),
            ]
            write_events(directory, events)

            run = analyze_run(directory, experiment)
            payload = to_payload(experiment, [run])

        self.assertEqual(run.declared_initial_path, "quick")
        self.assertTrue(run.declared_quick_with_reviewer)
        self.assertEqual(run.reviewer_instances, 1)
        self.assertEqual(run.reviewer_completed_instances, 1)
        self.assertEqual(run.reviewer_reports, 1)
        self.assertEqual(len(run.findings), 2)
        self.assertTrue(run.reviewer_pending_risks)
        self.assertEqual(run.closing_mentions, ["P1 已关闭", "P2 已关闭"])
        self.assertEqual(run.module_access["SKILL.md"], 1)
        self.assertEqual(run.module_access["references/review.md"], 1)
        self.assertEqual(run.file_access["src/ledger.py"], 1)
        self.assertAlmostEqual(run.cache_rate or 0, 0.8)
        self.assertFalse(run.result_valid)
        self.assertIsNone(run.resolved)
        self.assertTrue(run.historical_resolved)
        self.assertEqual(payload["summary"]["runs_with_reviewer"], 1)
        self.assertEqual(payload["summary"]["reviewer_finding_count"], 2)
        self.assertEqual(payload["aggregate"][0]["current_protocol_runs"], 0)
        self.assertEqual(payload["aggregate"][0]["historical_resolved"], 1)


class AccessAttributionTest(unittest.TestCase):
    def test_content_and_metadata_read_commands_are_attributed_by_behavior(self) -> None:
        file_cases = (
            ("status query", "git status --short src/ledger.py", set()),
            ("sed file", "sed -n '1,80p' src/ledger.py", {"src/ledger.py"}),
            ("git diff file", "git diff -- src/ledger.py", {"src/ledger.py"}),
            (
                "status does not read chained file",
                "cat README.md && git status --short src/ledger.py",
                {"README.md"},
            ),
            (
                "python code argument is not a read target",
                'python3 -c "print(1)" src/ledger.py',
                set(),
            ),
            ("git show file", "git show HEAD:src/ledger.py", {"src/ledger.py"}),
            ("diff stat", "git diff --stat src/ledger.py", set()),
            ("recursive search", "rg withdraw src", {"src/"}),
            ("search file", "rg -ewithdraw src/ledger.py", {"src/ledger.py"}),
            ("search root", "rg withdraw .", {"./"}),
            (
                "python explicit read",
                'python3 -c "print(open(\'src/ledger.py\').read())"',
                {"src/ledger.py"},
            ),
            ("time wrapper", "time sed -n '1,80p' src/ledger.py", {"src/ledger.py"}),
            (
                "time -p wrapper",
                "time -p sed -n '1,80p' src/ledger.py",
                {"src/ledger.py"},
            ),
            ("nice wrapper", "nice -n 5 cat src/ledger.py", {"src/ledger.py"}),
            ("command wrapper", "command -- cat src/ledger.py", {"src/ledger.py"}),
            ("timeout wrapper", "timeout 5 cat src/ledger.py", {"src/ledger.py"}),
            ("source file", "source src/ledger.py", {"src/ledger.py"}),
            ("git grep", "git grep withdraw src", {"src/"}),
            ("patch diff", "git diff -p -- src", {"src/"}),
            (
                "script argument",
                "python3 reader.py src/ledger.py",
                {"reader.py", "src/ledger.py"},
            ),
            (
                "patch overrides stat",
                "git diff --stat --patch -- src/ledger.py",
                {"src/ledger.py"},
            ),
            (
                "short patch overrides stat",
                "git diff --stat -p -- src/ledger.py",
                {"src/ledger.py"},
            ),
            ("directory context", "cd src && cat ledger.py", {"src/ledger.py"}),
            (
                "nested shell context",
                'cd src && bash -c "cat ledger.py"',
                {"src/ledger.py"},
            ),
        )
        for label, value, expected in file_cases:
            with self.subTest(case=f"file {label}"):
                self.assertEqual(extract_files(value), expected)

        module_cases = (
            (
                "reference glob",
                "cat .agents/skills/easydev/references/*.md",
                {"references/*.md"},
            ),
            (
                "quoted skill path",
                "/bin/zsh -lc \"sed -n '1,260p' "
                '.agents/skills/easydev/SKILL.md"',
                {"SKILL.md"},
            ),
        )
        for label, value, expected in module_cases:
            with self.subTest(case=f"module {label}"):
                self.assertEqual(extract_modules(value), expected)

        metadata_cases = (
            (
                "patch apply",
                "git apply tests/cases/public-contract-callers/solution.patch",
                {"solution.patch", "tests/cases/public-contract-callers"},
            ),
            ("dataset", "cat dataset.json", {"dataset.json"}),
            (
                "nested shell dataset",
                '/bin/zsh -c "cat dataset.json"',
                {"dataset.json"},
            ),
            (
                "metadata status",
                '/bin/zsh -c "git status --short dataset.json"',
                set(),
            ),
            (
                "gold git show",
                "git show HEAD:gold/task/patch.diff",
                {"gold/"},
            ),
            ("diff stat", "git diff --stat dataset.json", set()),
            ("diff names", "git diff --name-only -- dataset.json", set()),
            ("manifest", "cat manifest.json", {"manifest.json"}),
            ("results", "cat results.jsonl", {"results.jsonl"}),
            ("summary", "cat summary.json", {"summary.json"}),
            ("report", "cat report.md", {"report.md"}),
            ("gold search", "rg patch gold", {"gold/"}),
            ("gold context", "cd gold && cat patch.diff", {"gold/"}),
            (
                "gold nested shell",
                'cd gold && bash -c "cat patch.diff"',
                {"gold/"},
            ),
            (
                "command wrapper",
                "command -- cat dataset.json",
                {"dataset.json"},
            ),
            (
                "timeout wrapper",
                "timeout 5 cat dataset.json",
                {"dataset.json"},
            ),
            (
                "leave known directory",
                "cd gold && cd .. && cat app/patch.diff",
                set(),
            ),
            (
                "run result",
                "cat runs/public-contract-callers/easydev/r1/result.json",
                {"runs/", "result.json"},
            ),
            (
                "run patch",
                "cat runs/public-contract-callers/easydev/r1/agent.patch",
                {"runs/", "agent.patch"},
            ),
            ("junit aliases", "cat junit-results.xml", {"junit.xml"}),
        )
        for label, value, expected in metadata_cases:
            with self.subTest(case=f"metadata {label}"):
                self.assertEqual(extract_metadata_access(value), expected)

    def test_failed_read_attempt_is_recorded_as_benchmark_metadata_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            directory = run_dir(experiment, "task-m")
            write_events(
                directory,
                [
                    command("c1", "cat dataset.json", exit_code=1),
                    command("c2", "sed -n '1,80p' src/ledger.py"),
                    command(
                        "c3",
                        "git apply tests/cases/public-contract-callers/solution.patch",
                    ),
                    command(
                        "c4",
                        "git status --short tests/cases/public-contract-callers/solution.patch",
                    ),
                ],
            )
            run = analyze_run(directory, experiment)

        self.assertEqual(run.file_access["src/ledger.py"], 1)
        self.assertEqual(run.benchmark_metadata_access["dataset.json"], 1)
        self.assertEqual(run.benchmark_metadata_access["solution.patch"], 1)
        self.assertEqual(
            run.benchmark_metadata_access["tests/cases/public-contract-callers"],
            1,
        )


class ReportSemanticsTest(unittest.TestCase):
    def test_risk_finding_and_closing_text_ignores_history_and_negation(self) -> None:
        cases = (
            (
                "no pending risk",
                has_pending_risks,
                "未发现待验证风险。",
                False,
            ),
            (
                "historical risk",
                has_pending_risks,
                "历史待验证风险：旧版本身份来源。",
                False,
            ),
            (
                "empty risk",
                has_pending_risks,
                "待验证风险：无",
                False,
            ),
            (
                "empty labeled risk",
                has_pending_risks,
                "**待验证风险**\n\n无",
                False,
            ),
            (
                "active risk",
                has_pending_risks,
                "**待验证风险**\n\n并发写入尚未验证。",
                True,
            ),
            (
                "historical zero finding",
                has_zero_finding_statement,
                "旧版本未发现确定缺陷。",
                False,
            ),
        )
        for label, function, text, expected in cases:
            with self.subTest(case=label):
                self.assertEqual(function(text), expected)

        self.assertEqual(extract_findings("历史版本 [P1] 旧缺陷"), [])
        self.assertEqual(extract_closing_mentions("P1 未关闭。"), [])
        self.assertEqual(
            extract_closing_mentions("P1 已关闭，P2 未关闭。"),
            ["P1 已关闭"],
        )
        self.assertEqual(
            extract_closing_mentions("P1 未关闭，P2 已关闭。"),
            ["P2 已关闭"],
        )
        self.assertEqual(
            extract_closing_mentions("P1 已关闭问题：这是历史记录。"),
            [],
        )


class ResultAttributionTest(unittest.TestCase):
    def test_current_protocol_requires_dataset_and_baseline_contracts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            directory = run_dir(experiment)
            write_events(directory, [{"type": "turn.completed", "usage": {}}])

            write_json(directory / "result.json", valid_result())
            missing_dataset = analyze_run(directory, experiment)
            self.assertFalse(missing_dataset.result_valid)
            self.assertIn("dataset is required", missing_dataset.result_validation_error)

            write_task_contracts(experiment)
            valid = analyze_run(directory, experiment)
            self.assertTrue(valid.result_valid)
            self.assertTrue(valid.resolved)

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
            filtered = analyze_run(directory, experiment)
            discovered = discover_runs(experiment)
            self.assertTrue(filtered.result_valid)
            self.assertEqual(len(discovered), 1)
            self.assertTrue(discovered[0].result_valid)

            write_task_contracts(experiment, second_f2p="other_f2p")
            mismatch = analyze_run(directory, experiment)
            self.assertFalse(mismatch.result_valid)
            self.assertIsNone(mismatch.resolved)

            write_task_contracts(experiment)
            (experiment / "task-baselines" / "task.json").unlink()
            missing_baseline = analyze_run(directory, experiment)
            self.assertFalse(missing_baseline.result_valid)
            self.assertIn("task baseline", missing_baseline.result_validation_error)

            (experiment / "dataset.json").write_text("{broken", encoding="utf-8")
            invalid_dataset = analyze_run(directory, experiment)
            self.assertFalse(invalid_dataset.result_valid)
            self.assertIn("experiment dataset", invalid_dataset.result_validation_error)

    def test_behavior_protocol_is_not_mistaken_for_historical_swe_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            directory = run_dir(experiment, "b01")
            write_json(
                directory / "result.json",
                {
                    "behavior_result_protocol": "behavior-v1",
                    "resolved": True,
                },
            )
            write_events(directory, [{"type": "turn.completed"}])
            run = analyze_run(directory, experiment)

        self.assertFalse(run.result_valid)
        self.assertIsNone(run.resolved)
        self.assertIsNone(run.historical_resolved)

    def test_analyzer_reads_nested_runner_usage_and_wall_time(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            experiment = Path(temporary)
            directory = run_dir(experiment, "task-f")
            write_json(
                directory / "result.json",
                {
                    "resolved": False,
                    "agent": {
                        "wall_seconds": 9.5,
                        "usage": {
                            "input_tokens": 200,
                            "cached_input_tokens": 100,
                            "output_tokens": 20,
                        },
                    },
                },
            )
            write_events(directory, [{"type": "turn.completed"}])
            run = analyze_run(directory, experiment)

        self.assertEqual(run.input_tokens, 200)
        self.assertEqual(run.cached_input_tokens, 100)
        self.assertEqual(run.output_tokens, 20)
        self.assertEqual(run.wall_seconds, 9.5)


class EventValidationTest(unittest.TestCase):
    def test_malformed_event_lines_invalidate_the_whole_stream(self) -> None:
        cases = (
            (
                "invalid json",
                '{"type":"turn.completed"}\n{not-json}\n',
                1,
                1,
            ),
            (
                "non-object shapes",
                '[]\n{}\n{"type":"item.completed","item":[]}\n',
                0,
                3,
            ),
            (
                "invalid collaboration shapes",
                "\n".join(
                    json.dumps(event)
                    for event in (
                        {
                            "type": "item.completed",
                            "item": {
                                "type": "collab_tool_call",
                                "receiver_thread_ids": "reviewer-1",
                            },
                        },
                        {
                            "type": "item.completed",
                            "item": {
                                "type": "collab_tool_call",
                                "agents_states": {"reviewer-1": "completed"},
                            },
                        },
                    )
                )
                + "\n",
                0,
                2,
            ),
        )
        for label, content, event_count, malformed in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    experiment = Path(temporary)
                    directory = run_dir(experiment, label.replace(" ", "-"))
                    directory.mkdir(parents=True)
                    (directory / "events.jsonl").write_text(
                        content,
                        encoding="utf-8",
                    )
                    run = analyze_run(directory, experiment)
                    payload = to_payload(experiment, [run])
                self.assertEqual(run.event_count, event_count)
                self.assertEqual(run.malformed_event_lines, malformed)
                self.assertFalse(run.event_stream_valid)
                self.assertEqual(
                    payload["summary"]["runs_with_invalid_event_stream"],
                    1,
                )


if __name__ == "__main__":
    unittest.main()
