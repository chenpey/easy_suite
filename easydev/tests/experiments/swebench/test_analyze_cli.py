#!/usr/bin/env python3
"""CLI contracts for offline event attribution.

Coverage gap: earlier tests called attribution helpers directly, so they could
not catch a broken CLI summary, an ``--output`` file that diverges from stdout,
missing usage silently reported as zero, or a malformed event line aborting the
whole analysis.  Each case writes ``runs/<task>/<arm>/r<n>/`` fixtures and runs
``analyze_events.py``; the assertions only read the JSON/markdown it prints or
writes.  No module under test is imported by the test.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SWEBENCH = Path(__file__).resolve().parent
ANALYZE = SWEBENCH / "analyze_events.py"


def agent_message(index: int, text: str) -> dict:
    return {
        "type": "item.completed",
        "item": {"id": f"m{index}", "type": "agent_message", "text": text},
    }


def command(index: int, value: str, exit_code: int = 0) -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": f"c{index}",
            "type": "command_execution",
            "command": value,
            "exit_code": exit_code,
        },
    }


def spawn(reviewer_id: str = "reviewer-1") -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": "spawn-1",
            "type": "collab_tool_call",
            "tool": "spawn_agent",
            "receiver_thread_ids": [reviewer_id],
            "prompt": "独立只读审查 independent read-only reviewer",
        },
    }


def reviewer_state(
    message: str,
    reviewer_id: str = "reviewer-1",
    status: str = "completed",
) -> dict:
    return {
        "type": "item.completed",
        "item": {
            "id": "wait-1",
            "type": "collab_tool_call",
            "tool": "wait",
            "agents_states": {
                reviewer_id: {"status": status, "message": message}
            },
        },
    }


def turn(usage=None) -> dict:
    return {"type": "turn.completed", "usage": usage or {}}


class AnalyzeEventsCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="easydev-analyze-cli-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def write_run(
        self,
        experiment: Path,
        task: str,
        events,
        *,
        result: dict | None = None,
        arm: str = "easydev",
        repeat: int = 1,
    ) -> Path:
        run_dir = experiment / "runs" / task / arm / f"r{repeat}"
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "events.jsonl").write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in events)
            + "\n",
            encoding="utf-8",
        )
        if result is not None:
            (run_dir / "result.json").write_text(
                json.dumps(result), encoding="utf-8"
            )
        return run_dir

    def analyze(
        self,
        experiment: Path,
        *extra: str,
        output: Path | None = None,
    ) -> subprocess.CompletedProcess:
        args = [sys.executable, "-B", str(ANALYZE), "--experiment", str(experiment)]
        args.extend(extra)
        if output is not None:
            args.extend(["--output", str(output)])
        return subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=60,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def payload(self, experiment: Path) -> dict:
        completed = self.analyze(experiment, "--format", "json")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def run_by_task(self, payload: dict, task: str) -> dict:
        return next(run for run in payload["runs"] if run["task_id"] == task)

    # -- attribution -----------------------------------------------------
    def test_routing_reviewer_and_findings_attribution(self) -> None:
        experiment = self.root / "routing"
        self.write_run(
            experiment,
            "route",
            [
                agent_message(0, "采用 quick，先核对影响面。"),
                agent_message(1, "最终采用 full。"),
                spawn(),
                reviewer_state("**[P1]** 权限绕过 app/orders.py:7"),
                turn(),
            ],
        )
        payload = self.payload(experiment)
        run = self.run_by_task(payload, "route")
        self.assertEqual(run["declared_initial_path"], "quick")
        self.assertEqual(run["declared_final_path"], "full")
        self.assertTrue(run["upgraded_to_full"])
        self.assertEqual(run["reviewer_instances"], 1)
        self.assertEqual(run["reviewer_completed_instances"], 1)
        self.assertEqual(run["reviewer_reports"], 1)
        self.assertEqual(
            run["findings"],
            [{"severity": "P1", "title": "权限绕过 app/orders.py:7"}],
        )
        self.assertEqual(payload["summary"]["reviewer_finding_count"], 1)

    def test_access_attribution_counts_observed_paths_only(self) -> None:
        experiment = self.root / "access"
        self.write_run(
            experiment,
            "access",
            [
                command(0, "cat app/orders.py"),
                command(1, "rg -n owner app"),
                command(2, "sed -n '1,5p' references/review.md"),
                command(3, "git diff --stat"),
                turn(),
            ],
        )
        run = self.run_by_task(self.payload(experiment), "access")
        self.assertIn("app/orders.py", run["file_access"])
        self.assertIn("references/review.md", run["module_access"])
        self.assertNotIn("app/admin.py", run["file_access"])

    def test_usage_cache_rate_and_wall_time_keep_unknown_values(self) -> None:
        experiment = self.root / "usage"
        self.write_run(
            experiment,
            "measured",
            [turn({"input_tokens": 1000, "cached_input_tokens": 250, "output_tokens": 50})],
            result={
                "wall_seconds": 12.5,
                "usage": {
                    "input_tokens": 1000,
                    "cached_input_tokens": 250,
                    "output_tokens": 50,
                },
            },
        )
        self.write_run(
            experiment,
            "unmeasured",
            [turn()],
            result={"wall_seconds": 3.0},
        )
        payload = self.payload(experiment)
        measured = self.run_by_task(payload, "measured")
        unmeasured = self.run_by_task(payload, "unmeasured")
        self.assertEqual(measured["input_tokens"], 1000)
        self.assertEqual(measured["cached_input_tokens"], 250)
        self.assertEqual(measured["cache_rate"], 0.25)
        self.assertEqual(measured["wall_seconds"], 12.5)
        self.assertEqual(unmeasured["input_tokens"], 0)
        self.assertIsNone(unmeasured["cache_rate"])
        self.assertEqual(payload["aggregate"][0]["mean_cache_rate"], 0.25)

    def test_zero_findings_requires_an_explicit_statement(self) -> None:
        experiment = self.root / "zero-findings"
        self.write_run(
            experiment,
            "clean",
            [spawn(), reviewer_state("在本次审查范围内未发现确定缺陷。"), turn()],
        )
        self.write_run(
            experiment,
            "limited",
            [spawn(), reviewer_state("限制：未检查并发写入路径。"), turn()],
        )
        payload = self.payload(experiment)
        self.assertTrue(self.run_by_task(payload, "clean")["reviewer_zero_findings"])
        self.assertFalse(
            self.run_by_task(payload, "limited")["reviewer_zero_findings"]
        )

    def test_malformed_event_lines_are_counted_without_crashing(self) -> None:
        experiment = self.root / "malformed"
        run_dir = self.write_run(
            experiment,
            "malformed",
            [agent_message(0, "完成。"), turn()],
        )
        with (run_dir / "events.jsonl").open("a", encoding="utf-8") as events:
            events.write("{not-json\n")
        payload = self.payload(experiment)
        run = self.run_by_task(payload, "malformed")
        self.assertEqual(run["malformed_event_lines"], 1)
        self.assertGreaterEqual(run["event_count"], 2)
        self.assertFalse(run["event_stream_valid"])
        self.assertEqual(payload["summary"]["malformed_event_lines"], 1)

    def test_output_file_matches_stdout(self) -> None:
        experiment = self.root / "output"
        self.write_run(experiment, "output", [agent_message(0, "完成。"), turn()])
        printed = self.analyze(experiment, "--format", "json")
        self.assertEqual(printed.returncode, 0, printed.stderr)
        output = experiment / "analysis.json"
        completed = self.analyze(
            experiment, "--format", "json", output=output
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "")
        written = output.read_text(encoding="utf-8")
        self.assertEqual(written, printed.stdout)
        self.assertEqual(json.loads(written), json.loads(printed.stdout))
        self.assertEqual(
            json.loads(written)["experiment"], str(experiment.resolve())
        )



    # -- routing and reviewer negatives ---------------------------------
    def test_route_negations_candidate_tiers_and_final_only_messages(self) -> None:
        cases = (
            (
                "negated full keeps quick",
                ["不走 full，采用 quick。", "完成"],
                "quick",
                None,
                False,
            ),
            (
                "candidate full-local",
                ["采用 full-local。", "完成"],
                "full-local",
                None,
                False,
            ),
            (
                "quick to full-local is not formal upgrade",
                ["采用 quick。", "最终采用 full-local。"],
                "quick",
                "full-local",
                False,
            ),
            (
                "negated upgrade stays quick",
                ["采用 quick。", "未升级到 full，保持 quick。"],
                "quick",
                None,
                False,
            ),
            (
                "final message only leaves initial unknown",
                ["最终采用 full。"],
                None,
                "full",
                False,
            ),
            (
                "positive upgrade",
                ["采用 quick。", "最终采用 full。"],
                "quick",
                "full",
                True,
            ),
        )
        experiment = self.root / "routes"
        for index, (label, messages, _initial, _final, _upgraded) in enumerate(cases):
            self.write_run(
                experiment,
                f"route-{index}",
                [agent_message(i, text) for i, text in enumerate(messages)] + [turn()],
            )
        payload = self.payload(experiment)
        for index, (label, _messages, initial, final, upgraded) in enumerate(cases):
            with self.subTest(case=label):
                run = self.run_by_task(payload, f"route-{index}")
                self.assertEqual(run["declared_initial_path"], initial)
                self.assertEqual(run["declared_final_path"], final)
                self.assertEqual(run["upgraded_to_full"], upgraded)

    def test_reviewer_completion_requires_completed_nonempty_report(self) -> None:
        forged_spawn = spawn()
        forged_spawn["item"]["agents_states"] = {
            "reviewer-1": {"status": "completed", "message": "未发现确定缺陷。"}
        }
        cases = (
            ("in progress", [spawn(), reviewer_state("x", status="in_progress")], 0, 0),
            ("empty completed report", [spawn(), reviewer_state("")], 0, 0),
            ("spawn only", [spawn()], 0, 0),
            ("spawn cannot forge completion", [forged_spawn], 0, 0),
            (
                "duplicate wait and close report",
                [
                    spawn(),
                    reviewer_state("未发现确定缺陷。"),
                    reviewer_state("未发现确定缺陷。", status="completed"),
                ],
                1,
                1,
            ),
            (
                "distinct close report",
                [
                    spawn(),
                    reviewer_state("未发现确定缺陷。"),
                    {**reviewer_state("补充：限制未检查。"), "item": {**reviewer_state("x")["item"], "id": "close-1", "tool": "close_agent"}},
                ],
                1,
                2,
            ),
        )
        experiment = self.root / "reviewers"
        for index, (label, events, _completed, _reports) in enumerate(cases):
            self.write_run(experiment, f"reviewer-{index}", events + [turn()])
        payload = self.payload(experiment)
        for index, (label, _events, completed, reports) in enumerate(cases):
            with self.subTest(case=label):
                run = self.run_by_task(payload, f"reviewer-{index}")
                self.assertEqual(run["reviewer_completed_instances"], completed)
                self.assertEqual(run["reviewer_reports"], reports)

    # -- access attribution --------------------------------------------
    def test_access_attribution_separates_reads_from_status_queries(self) -> None:
        experiment = self.root / "access-matrix"
        self.write_run(
            experiment,
            "access",
            [
                command(0, "git status"),
                command(1, "git show HEAD:app/orders.py"),
                command(2, "env FOO=1 cat app/admin.py"),
                command(3, "cd app && cat orders.py"),
                command(4, "cat dataset.json", exit_code=1),
                command(5, "cat solution.patch", exit_code=1),
                command(6, "rg -n owner app"),
                turn(),
            ],
        )
        run = self.run_by_task(self.payload(experiment), "access")
        self.assertIn("app/orders.py", run["file_access"])
        self.assertIn("app/admin.py", run["file_access"])
        self.assertIn("app/", run["file_access"])
        self.assertNotIn("HEAD:app/orders.py", run["file_access"])
        self.assertIn("dataset.json", run["benchmark_metadata_access"])
        self.assertIn("solution.patch", run["benchmark_metadata_access"])

    # -- current-protocol contracts ------------------------------------
    def write_contracts(
        self,
        experiment: Path,
        *,
        f2p="tests/test_f2p.py::test_f2p",
        p2p="tests/test_p2p.py::test_p2p",
    ) -> None:
        experiment.mkdir(parents=True, exist_ok=True)
        (experiment / "dataset.json").write_text(
            json.dumps(
                [
                    {
                        "instance_id": "task",
                        "FAIL_TO_PASS": json.dumps([f2p]),
                        "PASS_TO_PASS": json.dumps([p2p]),
                    }
                ]
            ),
            encoding="utf-8",
        )
        (experiment / "task-baselines").mkdir(parents=True, exist_ok=True)
        (experiment / "task-baselines" / "task.json").write_text(
            json.dumps(
                {
                    "eligible_p2p": [p2p],
                    "excluded_p2p": [],
                    "statuses": {p2p: "PASSED"},
                    "pytest_returncode": 0,
                }
            ),
            encoding="utf-8",
        )

    def valid_result(self) -> dict:
        return {
            "result_protocol": 2,
            "agent_returncode": 0,
            "turn_completed": True,
            "agent_timed_out": False,
            "events": 2,
            "malformed_event_lines": 0,
            "task_id": "task",
            "arm": "easydev",
            "repeat": 1,
            "resolved": True,
            "f2p_pass": True,
            "f2p_status": {"tests/test_f2p.py::test_f2p": "PASSED"},
            "p2p_regressions": [],
            "test_statuses": {
                "tests/test_f2p.py::test_f2p": "PASSED",
                "tests/test_p2p.py::test_p2p": "PASSED",
            },
            "patch_applied": True,
            "wall_seconds": 1.0,
            "tool_calls": 1,
            "usage": {},
        }

    def test_result_requires_matching_dataset_and_baseline_contracts(self) -> None:
        experiment = self.root / "contract"
        self.write_contracts(experiment)
        self.write_run(
            experiment,
            "task",
            [turn(), agent_message(0, "完成。")],
            result=self.valid_result(),
        )
        payload = self.payload(experiment)
        self.assertTrue(payload["runs"][0]["result_valid"])

        missing_dataset = self.root / "contract-missing-dataset"
        shutil.copytree(experiment, missing_dataset)
        (missing_dataset / "dataset.json").unlink()
        run = self.payload(missing_dataset)["runs"][0]
        self.assertFalse(run["result_valid"])
        self.assertIn("dataset", run["result_validation_error"])

        bad_baseline = self.root / "contract-bad-baseline"
        shutil.copytree(experiment, bad_baseline)
        path = bad_baseline / "task-baselines" / "task.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["eligible_p2p"] = []
        path.write_text(json.dumps(value), encoding="utf-8")
        run = self.payload(bad_baseline)["runs"][0]
        self.assertFalse(run["result_valid"])
        self.assertIn("baseline", run["result_validation_error"])

        wrong_contract = self.root / "contract-wrong-f2p"
        shutil.copytree(experiment, wrong_contract)
        self.write_contracts(wrong_contract, f2p="tests/test_f2p.py::test_other")
        run = self.payload(wrong_contract)["runs"][0]
        self.assertFalse(run["result_valid"])

    def test_behavior_protocol_is_not_counted_as_historical_swe_result(self) -> None:
        experiment = self.root / "behavior"
        self.write_contracts(experiment)
        result = self.valid_result()
        result.pop("result_protocol")
        result["behavior_result_protocol"] = "behavior-v1"
        self.write_run(
            experiment,
            "task",
            [turn()],
            result=result,
        )
        run = self.payload(experiment)["runs"][0]
        self.assertFalse(run["result_valid"])
        self.assertIsNone(run["historical_resolved"])

    def test_nested_agent_usage_and_wall_seconds_are_read(self) -> None:
        experiment = self.root / "nested"
        self.write_run(
            experiment,
            "task",
            [turn()],
            result={
                "agent": {
                    "usage": {
                        "input_tokens": 800,
                        "cached_input_tokens": 200,
                        "output_tokens": 20,
                    },
                    "wall_seconds": 7.5,
                }
            },
        )
        run = self.run_by_task(self.payload(experiment), "task")
        self.assertEqual(run["input_tokens"], 800)
        self.assertEqual(run["cache_rate"], 0.25)
        self.assertEqual(run["wall_seconds"], 7.5)

    # -- usage semantics (characterization) ----------------------------
    def test_usage_source_matrix_documents_known_limit(self) -> None:
        """analyze_events only reads result.json usage; event usage is ignored."""
        experiment = self.root / "usage-matrix"
        self.write_run(
            experiment,
            "result-only",
            [turn({"input_tokens": 999, "cached_input_tokens": 999, "output_tokens": 9})],
            result={
                "usage": {
                    "input_tokens": 1000,
                    "cached_input_tokens": 250,
                    "output_tokens": 50,
                }
            },
        )
        self.write_run(
            experiment,
            "event-only",
            [turn({"input_tokens": 600, "cached_input_tokens": 150, "output_tokens": 30})],
            result={},
        )
        self.write_run(experiment, "missing", [turn()], result={})
        self.write_run(
            experiment,
            "real-zero",
            [turn()],
            result={
                "usage": {
                    "input_tokens": 0,
                    "cached_input_tokens": 0,
                    "output_tokens": 0,
                }
            },
        )
        payload = self.payload(experiment)
        result_only = self.run_by_task(payload, "result-only")
        event_only = self.run_by_task(payload, "event-only")
        missing = self.run_by_task(payload, "missing")
        real_zero = self.run_by_task(payload, "real-zero")
        # Known limitation: the event stream usage is not aggregated.
        self.assertEqual(result_only["input_tokens"], 1000)
        self.assertEqual(result_only["cache_rate"], 0.25)
        self.assertEqual(event_only["input_tokens"], 0)
        self.assertIsNone(event_only["cache_rate"])
        self.assertEqual(missing["input_tokens"], 0)
        self.assertIsNone(missing["cache_rate"])
        # Token 0 cannot distinguish "unknown" from a measured zero.
        self.assertEqual(real_zero["input_tokens"], 0)
        self.assertIsNone(real_zero["cache_rate"])

    def test_structurally_invalid_events_are_counted_not_crashing(self) -> None:
        experiment = self.root / "invalid-structures"
        run_dir = self.write_run(
            experiment,
            "invalid",
            [
                [],
                {"type": "item.completed", "item": "not-an-object"},
                {
                    "type": "item.completed",
                    "item": {
                        "type": "collab_tool_call",
                        "receiver_thread_ids": "reviewer-1",
                    },
                },
                turn(),
            ],
        )
        with (run_dir / "events.jsonl").open("a", encoding="utf-8") as events:
            events.write("{not-json\n")
        run = self.run_by_task(self.payload(experiment), "invalid")
        self.assertEqual(run["malformed_event_lines"], 4)
        self.assertEqual(run["event_count"], 1)
        self.assertFalse(run["event_stream_valid"])


if __name__ == "__main__":
    unittest.main()
