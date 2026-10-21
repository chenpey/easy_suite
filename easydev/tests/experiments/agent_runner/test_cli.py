#!/usr/bin/env python3
"""CLI contracts for the EasyDev behavior runner.

These checks drive ``runner.py`` as a user would and replace only the external
Codex CLI process with ``tests/experiments/stubs/codex_stub.py``.  They cover
what the old in-process tests could not: the published CLI contract, result
artifacts and the safety boundaries (runtime Skill tampering, staged indexes,
timeouts with process-tree cleanup, malformed event streams, read-only audit
violations).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


TESTS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = TESTS_ROOT.parent
RUNNER = TESTS_ROOT / "experiments" / "agent_runner" / "runner.py"
CODEX_STUB = TESTS_ROOT / "experiments" / "stubs" / "codex_stub.py"
CASES_ROOT = TESTS_ROOT / "cases"
SCENARIO_IDS = ["b01", "b02", "b16", "public-contract-callers"]

B02_SOLUTION = (
    "NOTES = {\n"
    '    "n1": {"owner_id": "u1", "text": "first"},\n'
    '    "n2": {"owner_id": "u2", "text": "second"},\n'
    "}\n\n\n"
    "def get_note(note_id, user_id):\n"
    "    if user_id in (None, ''):\n"
    "        raise PermissionError('missing user')\n"
    "    note = NOTES.get(note_id)\n"
    "    if note is None:\n"
    "        return None\n"
    "    if note['owner_id'] != user_id:\n"
    "        raise PermissionError('not owner')\n"
    "    return note\n"
)
B02_MISSING_IDENTITY = B02_SOLUTION.replace(
    "    if user_id in (None, ''):\n"
    "        raise PermissionError('missing user')\n",
    "",
)

PUBLIC_ORDERS = """from app.db import find_order


def get_order(order_id, current_user_id):
    order = find_order(order_id)
    if order is None or order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
"""
PUBLIC_API = """from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request["user_id"])
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
"""
PUBLIC_ADMIN = """from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
"""
PUBLIC_FAKE_API = """from app.orders import get_order


def handle_show_order(request, order_id):
    if request.get("user_id") in (None, ""):
        return {"status": 403}
    order = get_order(order_id)
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
"""


def alive(pid: int) -> bool:
    """A zombie is already dead; macOS (no /proc) relies on launchd reaping."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    stat_path = Path(f"/proc/{pid}/stat")
    if stat_path.exists():
        try:
            state = stat_path.read_text(encoding="utf-8").rsplit(") ", 1)[1].split()[0]
        except (OSError, IndexError, UnicodeError):
            return True
        return state != "Z"
    return True


class RunnerCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="easydev-runner-cli-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    # -- fixture helpers -------------------------------------------------
    def stub_environment(
        self,
        name: str,
        plan: dict,
        *,
        skill: bool = True,
    ) -> SimpleNamespace:
        base = self.root / name
        base.mkdir(parents=True, exist_ok=True)
        plan_path = base / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        launcher = base / "codex-stub"
        launcher.write_text(
            "#!/bin/sh\nexec \"{}\" -B \"{}\" \"$@\"\n".format(
                sys.executable, CODEX_STUB
            ),
            encoding="utf-8",
        )
        launcher.chmod(0o755)
        auth = base / "auth.json"
        auth.write_text("{}\n", encoding="utf-8")
        skill_root = base / "skill"
        (skill_root / "references").mkdir(parents=True)
        (skill_root / "SKILL.md").write_text("fixture skill\n", encoding="utf-8")
        (skill_root / "references" / "review.md").write_text(
            "fixture review reference\n", encoding="utf-8"
        )
        env = os.environ.copy()
        env["EASYDEV_STUB_PLAN"] = str(plan_path)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return SimpleNamespace(
            base=base,
            out=base / "out",
            launcher=launcher,
            auth=auth,
            skill=skill_root if skill else base / "missing-skill",
            env=env,
        )

    def cli(self, *args: object, env: dict | None = None, timeout: int = 90):
        return subprocess.run(
            [sys.executable, "-B", str(RUNNER), *[str(value) for value in args]],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=timeout,
            env=env,
        )

    def run_scenario(
        self,
        fixture: SimpleNamespace,
        scenario: str,
        *,
        agent_timeout: int = 30,
        case_root: Path = CASES_ROOT,
    ):
        return self.cli(
            "run",
            "--scenario",
            scenario,
            "--out",
            fixture.out,
            "--codex-bin",
            fixture.launcher,
            "--codex-auth",
            fixture.auth,
            "--skill-root",
            fixture.skill,
            "--case-root",
            case_root,
            "--agent-timeout",
            agent_timeout,
            env=fixture.env,
        )

    def result(self, fixture: SimpleNamespace, scenario: str) -> dict:
        path = fixture.out / "runs" / scenario / "easydev" / "r1" / "result.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def run_dir(self, fixture: SimpleNamespace, scenario: str) -> Path:
        return fixture.out / "runs" / scenario / "easydev" / "r1"

    def failed_checks(self, result: dict) -> set:
        return {
            item["name"]
            for item in result["evaluation"]["checks"]
            if not item["passed"]
        }

    # -- list / prepare --------------------------------------------------
    def test_list_prints_registered_scenario_ids(self) -> None:
        completed = self.cli("list")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        listed = json.loads(completed.stdout)
        self.assertEqual(sorted(item["id"] for item in listed), sorted(SCENARIO_IDS))

    def test_prepare_creates_runnable_workspace(self) -> None:
        fixture = self.stub_environment("prepare", {})
        completed = self.cli(
            "prepare",
            "--scenario",
            "b01",
            "--out",
            fixture.out,
            "--skill-root",
            fixture.skill,
            env=fixture.env,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        workspace = self.run_dir(fixture, "b01") / "workspace"
        self.assertTrue((workspace / ".agents" / "skills" / "easydev" / "SKILL.md").is_file())
        self.assertTrue((workspace / ".git").is_dir())
        self.assertTrue((workspace / "src" / "ui.py").is_file())
        prepared = json.loads(completed.stdout)
        self.assertEqual(prepared["scenario"], "b01")
        self.assertIn("prompt", prepared)

    def test_prepare_refuses_non_empty_target_unless_overwritten(self) -> None:
        fixture = self.stub_environment("prepare-overwrite", {})
        args = (
            "prepare",
            "--scenario",
            "b01",
            "--out",
            fixture.out,
            "--skill-root",
            fixture.skill,
        )
        self.assertEqual(self.cli(*args, env=fixture.env).returncode, 0)
        refused = self.cli(*args, env=fixture.env)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("not empty", refused.stderr)
        overwritten = self.cli(*args, "--overwrite", env=fixture.env)
        self.assertEqual(overwritten.returncode, 0, overwritten.stderr)

    def test_prepare_reports_missing_public_contract_case(self) -> None:
        fixture = self.stub_environment("prepare-missing-case", {})
        empty_cases = fixture.base / "empty-cases"
        empty_cases.mkdir()
        completed = self.cli(
            "prepare",
            "--scenario",
            "public-contract-callers",
            "--out",
            fixture.out,
            "--skill-root",
            fixture.skill,
            "--case-root",
            empty_cases,
            env=fixture.env,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("missing public contract case", completed.stderr)

    # -- b01 run contracts ----------------------------------------------
    def b01_plan(self, **overrides: object) -> dict:
        plan = {
            "events": 3,
            "agent_messages": [
                "采用 quick，这是单文件文案修改。",
                "已完成按钮文案修改并验证导入。\n审查状态：自查",
            ],
            "mutations": [
                {"path": "src/ui.py", "content": 'BUTTON_LABEL = "保存"\n'}
            ],
        }
        plan.update(overrides)
        return plan

    def test_run_b01_accepts_clean_quick_work(self) -> None:
        fixture = self.stub_environment("b01-pass", self.b01_plan())
        completed = self.run_scenario(fixture, "b01")
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = self.result(fixture, "b01")
        self.assertTrue(result["resolved"], result["evaluation"])
        self.assertTrue(result["evaluation"]["passed"])
        self.assertEqual(result["changed_paths"], ["src/ui.py"])
        patch = (self.run_dir(fixture, "b01") / "agent.patch").read_text(encoding="utf-8")
        self.assertTrue(patch.strip())
        self.assertNotIn(".agents/skills", patch)

    def test_run_b01_rejects_unrequested_file_changes(self) -> None:
        plan = self.b01_plan()
        plan["mutations"].append({"path": "README.md", "content": "# changed\n"})
        fixture = self.stub_environment("b01-readme", plan)
        completed = self.run_scenario(fixture, "b01")
        self.assertEqual(completed.returncode, 1, completed.stderr + completed.stdout)
        result = self.result(fixture, "b01")
        self.assertIn("only src/ui.py changed", self.failed_checks(result))
        self.assertIn("README.md", result["changed_paths"])
        patch = (self.run_dir(fixture, "b01") / "agent.patch").read_text(encoding="utf-8")
        self.assertIn("README.md", patch)

    def test_run_b01_detects_runtime_skill_tampering(self) -> None:
        fixture = self.stub_environment(
            "b01-skill-edit", self.b01_plan(runtime_skill_edit=True)
        )
        completed = self.run_scenario(fixture, "b01")
        self.assertEqual(completed.returncode, 1, completed.stderr + completed.stdout)
        result = self.result(fixture, "b01")
        self.assertTrue(result["runtime_skill_changes"], result)
        patch = (self.run_dir(fixture, "b01") / "agent.patch").read_text(encoding="utf-8")
        self.assertNotIn(".agents/skills", patch)

    def test_run_b01_detects_staged_index_changes(self) -> None:
        fixture = self.stub_environment("b01-stage", self.b01_plan(stage=True))
        completed = self.run_scenario(fixture, "b01")
        self.assertEqual(completed.returncode, 1, completed.stderr + completed.stdout)
        result = self.result(fixture, "b01")
        self.assertTrue(result["index_changed"], result)
        self.assertIn("git index stayed unchanged", self.failed_checks(result))

    def test_run_b01_rejects_incomplete_event_streams(self) -> None:
        cases = (
            ("missing turn.completed", {"invalid_events": "missing_turn_completed"}, "turn_completed"),
            ("malformed line", {"invalid_events": "malformed"}, "malformed_event_lines"),
        )
        for label, overrides, field in cases:
            with self.subTest(case=label):
                fixture = self.stub_environment(
                    "b01-events-" + label.replace(" ", "-").replace(".", ""),
                    self.b01_plan(**overrides),
                )
                completed = self.run_scenario(fixture, "b01")
                self.assertEqual(completed.returncode, 1)
                result = self.result(fixture, "b01")
                self.assertFalse(result["valid_invocation"])
                if field == "turn_completed":
                    self.assertFalse(result["agent"]["turn_completed"])
                else:
                    self.assertGreater(result["agent"]["malformed_event_lines"], 0)

    def test_run_b01_records_agent_exit_code(self) -> None:
        fixture = self.stub_environment("b01-exit", self.b01_plan(exit_code=7))
        completed = self.run_scenario(fixture, "b01")
        self.assertEqual(completed.returncode, 1)
        result = self.result(fixture, "b01")
        self.assertFalse(result["valid_invocation"])
        self.assertEqual(result["agent"]["returncode"], 7)

    def test_run_b01_timeout_cleans_up_process_tree(self) -> None:
        child_pid_file = self.root / "timeout-child.pid"
        fixture = self.stub_environment(
            "b01-timeout",
            {
                "spawn_child": True,
                "child_pid_file": str(child_pid_file),
                "sleep_seconds": 30,
            },
        )
        completed = self.run_scenario(fixture, "b01", agent_timeout=2)
        self.assertEqual(completed.returncode, 1, completed.stderr + completed.stdout)
        result = self.result(fixture, "b01")
        self.assertTrue(result["agent"]["timed_out"])
        self.assertFalse(result["valid_invocation"])
        deadline = time.monotonic() + 10
        while not child_pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(child_pid_file.exists(), "stub did not record its child pid")
        child_pid = int(child_pid_file.read_text(encoding="utf-8").strip())
        deadline = time.monotonic() + 15
        while alive(child_pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(alive(child_pid), f"child process {child_pid} survived timeout cleanup")

    # -- b02 run contracts ----------------------------------------------
    def test_run_b02_requires_full_route_and_ownership_check(self) -> None:
        cases = (
            ("complete", B02_SOLUTION, True, []),
            (
                "missing identity guard",
                B02_MISSING_IDENTITY,
                False,
                ["ownership behavior passes"],
            ),
        )
        for label, source, expected_exit, failed in cases:
            with self.subTest(case=label):
                fixture = self.stub_environment(
                    "b02-" + label.replace(" ", "-"),
                    {
                        "agent_messages": ["采用 full。", "完成"],
                        "reviewer": True,
                        "reviewer_report": "未发现确定缺陷。",
                        "mutations": [{"path": "src/access.py", "content": source}],
                    },
                )
                completed = self.run_scenario(fixture, "b02")
                self.assertEqual(completed.returncode, 0 if expected_exit else 1)
                result = self.result(fixture, "b02")
                self.assertEqual(result["evaluation"]["passed"], expected_exit)
                for name in failed:
                    self.assertIn(name, self.failed_checks(result))

    # -- b16 run contracts ----------------------------------------------
    def test_run_b16_detects_read_only_violation(self) -> None:
        fixture = self.stub_environment(
            "b16-mutation",
            {
                "agent_messages": ["审计完成。"],
                "mutations": [
                    {"path": "src/ledger.py", "content": "# tampered\n"}
                ],
            },
        )
        completed = self.run_scenario(fixture, "b16")
        self.assertEqual(completed.returncode, 1, completed.stderr + completed.stdout)
        result = self.result(fixture, "b16")
        self.assertIn("audit changed no files", self.failed_checks(result))

    def test_run_b16_accepts_read_only_audit_with_findings(self) -> None:
        report = (
            "审计完成：资金写入未校验负数金额。未检查：并发写入路径。\n\n"
            "```easydev-findings\n"
            "P1 | 位置=src/ledger.py:4 | 触发=负数金额 | 后果=余额反向增加\n"
            "```"
        )
        fixture = self.stub_environment(
            "b16-pass",
            {
                "agent_messages": [report],
                "commands": ["cat src/ledger.py"],
            },
        )
        completed = self.run_scenario(fixture, "b16")
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        result = self.result(fixture, "b16")
        self.assertTrue(result["evaluation"]["passed"], result["evaluation"])
        self.assertEqual(result["changed_paths"], [])
        checks = {
            item["name"]: item["passed"] for item in result["evaluation"]["checks"]
        }
        self.assertTrue(checks["audit inspected src/ledger.py"])
        self.assertTrue(checks["audit reports a concrete finding"])

    def test_run_b01_rejects_route_evidence_and_hidden_changes(self) -> None:
        cases = (
            (
                "missing status line",
                {
                    "agent_messages": ["采用 quick。", "完成修改。"],
                },
                "quick states self-review status",
            ),
            (
                "independent status on quick",
                {
                    "agent_messages": ["采用 quick。", "完成修改。\n审查状态：独立"],
                },
                "quick states self-review status",
            ),
            (
                "declared full",
                {
                    "agent_messages": ["采用 full。", "完成修改。\n审查状态：自查"],
                },
                "route is quick",
            ),
            (
                "loaded reference",
                {
                    "commands": ["cat references/review.md"],
                },
                "quick did not load references",
            ),
            (
                "ignored cache change",
                {
                    "mutations": [
                        {"path": "src/ui.py", "content": 'BUTTON_LABEL = "保存"\n'},
                        {"path": ".pytest_cache/state", "content": "changed\n"},
                    ],
                },
                "no hidden workspace changes",
            ),
            (
                "git config change",
                {
                    "append_files": [
                        {
                            "path": ".git/config",
                            "content": "\n[behavior]\n\tmarker = true\n",
                        }
                    ],
                },
                "git control metadata stayed unchanged",
            ),
        )
        for label, overrides, failed_check in cases:
            with self.subTest(case=label):
                fixture = self.stub_environment(
                    "b01-negative-" + label.replace(" ", "-").replace(".", ""),
                    self.b01_plan(**overrides),
                )
                completed = self.run_scenario(fixture, "b01")
                self.assertEqual(completed.returncode, 1, completed.stdout)
                result = self.result(fixture, "b01")
                self.assertIn(failed_check, self.failed_checks(result))

    def test_run_b02_rejects_quick_candidate_tiers_and_unfinished_review(self) -> None:
        cases = (
            ("quick", ["采用 quick。", "完成"], {"reviewer": True}, "route is full or upgraded to full"),
            (
                "candidate full-local",
                ["采用 full-local。", "完成"],
                {"reviewer": True},
                "route is full or upgraded to full",
            ),
            (
                "candidate full-staged",
                ["采用 full-staged。", "完成"],
                {"reviewer": True},
                "route is full or upgraded to full",
            ),
            (
                "unfinished reviewer",
                ["采用 full。", "完成"],
                {"reviewer": {"status": "in_progress", "message": ""}},
                "independent reviewer exists",
            ),
        )
        for label, messages, overrides, failed_check in cases:
            with self.subTest(case=label):
                plan = {
                    "agent_messages": messages,
                    "mutations": [{"path": "src/access.py", "content": B02_SOLUTION}],
                }
                plan.update(overrides)
                fixture = self.stub_environment(
                    "b02-negative-" + label.replace(" ", "-"), plan
                )
                completed = self.run_scenario(fixture, "b02")
                self.assertEqual(completed.returncode, 1, completed.stdout)
                result = self.result(fixture, "b02")
                self.assertIn(failed_check, self.failed_checks(result))

    def test_run_b16_rejects_invalid_findings_reports(self) -> None:
        limits = "限制：未检查并发写入路径。"
        valid_row = "P1 | 位置=src/ledger.py:4 | 触发=负数金额 | 后果=余额反向增加"

        def report(rows, *, fenced=False):
            block = "\n".join(rows)
            if fenced:
                block = "```markdown\n```easydev-findings\n" + block + "\n```\n```"
            else:
                block = "```easydev-findings\n" + block + "\n```"
            return f"{limits}\n\n{block}"

        cases = (
            ("fenced example", [report([valid_row], fenced=True)], "audit findings block is well formed"),
            (
                "unresolvable location",
                [report(["P1 | 位置=src/ledger.py:999 | 触发=负数金额 | 后果=余额反向增加"])],
                "audit finding locations resolve",
            ),
            (
                "unordered severities",
                [
                    report(
                        [
                            "P2 | 位置=src/ledger.py:4 | 触发=重复入账 | 后果=重复流水",
                            valid_row,
                        ]
                    )
                ],
                "audit ranks findings by severity",
            ),
            (
                "more than twenty findings",
                [report([valid_row] * 21)],
                "audit reports at most 20 findings",
            ),
            (
                "no read evidence",
                [report([valid_row])],
                "audit inspected src/ledger.py",
            ),
        )
        for label, messages, failed_check in cases:
            with self.subTest(case=label):
                fixture = self.stub_environment(
                    "b16-negative-" + label.replace(" ", "-"),
                    {"agent_messages": messages},
                )
                completed = self.run_scenario(fixture, "b16")
                self.assertEqual(completed.returncode, 1, completed.stdout)
                result = self.result(fixture, "b16")
                self.assertIn(failed_check, self.failed_checks(result))

    def test_run_public_contract_rejects_reserved_files_and_metadata_access(self) -> None:
        solution = [
            {"path": "app/orders.py", "content": PUBLIC_ORDERS},
            {"path": "app/api.py", "content": PUBLIC_API},
            {"path": "app/admin.py", "content": PUBLIC_ADMIN},
        ]
        cases = (
            (
                "modified check_orders",
                solution + [{"path": "check_orders.py", "content": "# weakened\n"}],
                None,
                "no test or case-file changes",
            ),
            (
                "modified probe",
                solution + [{"path": "probe.py", "content": "# weakened\n"}],
                None,
                "no test or case-file changes",
            ),
            (
                "modified docs",
                solution + [{"path": "docs/orders.md", "content": "# weakened\n"}],
                None,
                "no test or case-file changes",
            ),
            (
                "benchmark metadata read",
                solution,
                ["cat dataset.json"],
                "no benchmark metadata access attempt was visible",
            ),
        )
        for label, mutations, commands, failed_check in cases:
            with self.subTest(case=label):
                plan = {
                    "agent_messages": [
                        "采用 full，这是公共契约变更。",
                        "已完成适配并验证。独立审查已完成。",
                    ],
                    "reviewer": True,
                    "reviewer_report": "**未发现确定缺陷。**",
                    "mutations": mutations,
                }
                if commands:
                    plan["commands"] = commands
                fixture = self.stub_environment(
                    "public-negative-" + label.replace(" ", "-"), plan
                )
                completed = self.run_scenario(fixture, "public-contract-callers")
                self.assertEqual(completed.returncode, 1, completed.stdout)
                result = self.result(fixture, "public-contract-callers")
                self.assertIn(failed_check, self.failed_checks(result))

    def test_acceptance_does_not_execute_workspace_sitecustomize(self) -> None:
        marker = self.root / "sitecustomize-ran.txt"
        sitecustomize = (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('ran')\n"
        )
        fixture = self.stub_environment(
            "b02-sitecustomize",
            {
                "agent_messages": ["采用 full。", "完成"],
                "reviewer": True,
                "reviewer_report": "未发现确定缺陷。",
                "mutations": [
                    {"path": "src/access.py", "content": B02_SOLUTION},
                    {"path": "sitecustomize.py", "content": sitecustomize},
                ],
            },
        )
        completed = self.run_scenario(fixture, "b02")
        self.assertEqual(completed.returncode, 1, completed.stdout)
        self.assertFalse(marker.exists(), "evaluation imported workspace sitecustomize.py")
        result = self.result(fixture, "b02")
        self.assertIn("only src/access.py changed", self.failed_checks(result))

    def test_run_b01_captures_reverted_stage_and_assume_unchanged(self) -> None:
        cases = (
            (
                "staged then reverted",
                {
                    "stage": True,
                    "post_stage_mutations": [
                        {"path": "src/ui.py", "content": 'BUTTON_LABEL = "提交"\n'}
                    ],
                },
                [],
            ),
            (
                "assume-unchanged",
                {
                    "git_commands": [
                        [
                            "git",
                            "update-index",
                            "--assume-unchanged",
                            "--",
                            "src/ui.py",
                        ]
                    ]
                },
                ["src/ui.py"],
            ),
        )
        for label, overrides, changed in cases:
            with self.subTest(case=label):
                fixture = self.stub_environment(
                    "b01-index-" + label.replace(" ", "-"),
                    self.b01_plan(**overrides),
                )
                completed = self.run_scenario(fixture, "b01")
                self.assertEqual(completed.returncode, 1, completed.stdout)
                result = self.result(fixture, "b01")
                self.assertTrue(result["index_changed"], result)
                self.assertIn("git index stayed unchanged", self.failed_checks(result))
                self.assertEqual(result["changed_paths"], changed)

    def test_capture_does_not_execute_agent_hook_or_clean_filter(self) -> None:
        marker = self.root / "hook-or-filter-ran.txt"
        filter_script = self.root / "clean-filter.sh"
        filter_script.write_text(
            "#!/bin/sh\n"
            f"printf ran > {str(marker)!r}\n"
            "cat\n",
            encoding="utf-8",
        )
        filter_script.chmod(0o755)
        hook = self.root / "post-index-change.sh"
        hook.write_text(
            "#!/bin/sh\n"
            f"printf ran > {str(marker)!r}\n"
            "printf 'BUTTON_LABEL = \"hacked\"\\n' > src/ui.py\n",
            encoding="utf-8",
        )
        fixture = self.stub_environment(
            "b01-capture-protection",
            self.b01_plan(
                append_files=[
                    {
                        "path": ".git/config",
                        "content": (
                            "\n[filter \"agent-clean\"]\n"
                            f"\tclean = {filter_script}\n"
                        ),
                    },
                    {
                        "path": ".git/info/attributes",
                        "content": "*.py filter=agent-clean\n",
                    },
                ],
                mutations=[
                    {"path": "src/ui.py", "content": 'BUTTON_LABEL = "保存"\n'},
                    {
                        "path": ".git/hooks/post-index-change",
                        "content": hook.read_text(encoding="utf-8"),
                    },
                ],
                chmod_files=[
                    {"path": ".git/hooks/post-index-change", "mode": 0o755}
                ],
            ),
        )
        completed = self.run_scenario(fixture, "b01")
        # The agent's own Git metadata change is still a scenario failure; the
        # invariant under test is that capture never executes it.
        self.assertEqual(completed.returncode, 1, completed.stdout)
        self.assertFalse(marker.exists(), "capture executed an Agent hook or filter")
        patch = (self.run_dir(fixture, "b01") / "agent.patch").read_text(encoding="utf-8")
        self.assertIn('+BUTTON_LABEL = "保存"', patch)
        self.assertNotIn("hacked", patch)
        config = (
            self.run_dir(fixture, "b01") / "workspace" / ".git" / "config"
        ).read_text(encoding="utf-8")
        self.assertIn("agent-clean", config)

    # -- public-contract-callers run contracts --------------------------
    def test_run_public_contract_callers_uses_independent_acceptance(self) -> None:
        cases = (
            (
                "complete",
                [
                    {"path": "app/orders.py", "content": PUBLIC_ORDERS},
                    {"path": "app/api.py", "content": PUBLIC_API},
                    {"path": "app/admin.py", "content": PUBLIC_ADMIN},
                ],
                0,
                [],
            ),
            (
                "status-only fake fix",
                [{"path": "app/api.py", "content": PUBLIC_FAKE_API}],
                1,
                ["independent acceptance passes"],
            ),
        )
        for label, mutations, expected_exit, failed in cases:
            with self.subTest(case=label):
                fixture = self.stub_environment(
                    "public-" + label.replace(" ", "-"),
                    {
                        "agent_messages": [
                            "采用 full，这是公共契约变更。",
                            "已完成适配并验证。独立审查已完成。",
                        ],
                        "reviewer": True,
                        "reviewer_report": "**未发现确定缺陷。**",
                        "mutations": mutations,
                    },
                )
                completed = self.run_scenario(fixture, "public-contract-callers")
                self.assertEqual(
                    completed.returncode,
                    0 if expected_exit == 0 else 1,
                    completed.stderr + completed.stdout,
                )
                result = self.result(fixture, "public-contract-callers")
                self.assertEqual(result["evaluation"]["passed"], expected_exit == 0)
                for name in failed:
                    self.assertIn(name, self.failed_checks(result))
                self.assertNotIn("no test or case-file changes", self.failed_checks(result))


if __name__ == "__main__":
    unittest.main()
