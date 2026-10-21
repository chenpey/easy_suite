#!/usr/bin/env python3
"""Behavior contracts for isolated behavior scenarios and evidence capture.

Coverage gap: scenario acceptance must reject incomplete routing, reviewer,
read-only, and hidden-change evidence even when the final response claims
success. The tests exercise scenario public entry points with table-driven
variants; storage and process protections are split by observable invariant.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

EXPERIMENTS_ROOT = Path(__file__).resolve().parents[1]
if str(EXPERIMENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_ROOT))

import process_control
from adapters.codex_cli import _terminate_process, parse_events as parse_adapter_events
from runner import (
    capture_changes,
    git_metadata_changes,
    init_git,
    runtime_tree_changes,
    snapshot_git_metadata,
    snapshot_runtime_tree,
    snapshot_workspace,
    workspace_changes,
)
from scenarios import load_scenario
from scenarios.common import entered_full, install_skill


ROOT = Path(__file__).resolve().parents[3]
CASES = ROOT / "tests" / "cases"
PUBLIC_CONTRACT_CHANGED_PATHS = ["app/admin.py", "app/api.py", "app/orders.py"]

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

B02_MISSING_IDENTITY_CHECK = (
    "NOTES = {\n"
    '    "n1": {"owner_id": "u1", "text": "first"},\n'
    '    "n2": {"owner_id": "u2", "text": "second"},\n'
    "}\n\n\n"
    "def get_note(note_id, user_id):\n"
    "    note = NOTES.get(note_id)\n"
    "    if note is None:\n"
    "        return None\n"
    "    if note['owner_id'] != user_id:\n"
    "        raise PermissionError('not owner')\n"
    "    return note\n"
)


def observed(
    path: str,
    upgraded: bool = False,
    reviewers: int = 0,
    *,
    completed_reviewers: int | None = None,
    file_access: dict | None = None,
    module_access: dict | None = None,
    index_changed: bool = False,
    metadata_access: dict | None = None,
    final_path: str | None = None,
    runtime_skill_changes: list | None = None,
    workspace_changes: list | None = None,
    git_metadata_changes: list | None = None,
    uncaptured_worktree_paths: list | None = None,
) -> object:
    if completed_reviewers is None:
        completed_reviewers = reviewers
    return SimpleNamespace(
        declared_initial_path=path,
        declared_final_path=path if final_path is None else final_path,
        upgraded_to_full=upgraded,
        reviewer_instances=reviewers,
        reviewer_completed_instances=completed_reviewers,
        reviewer_reports=completed_reviewers,
        file_access=file_access or {},
        module_access=module_access or {},
        index_changed=index_changed,
        benchmark_metadata_access=metadata_access or {},
        runtime_skill_changes=runtime_skill_changes or [],
        workspace_changes=workspace_changes or [],
        git_metadata_changes=git_metadata_changes or [],
        uncaptured_worktree_paths=uncaptured_worktree_paths or [],
    )


def prepare(scenario_id: str, workspace: Path) -> None:
    load_scenario(scenario_id).prepare(workspace, CASES)


class ScenarioEvaluationTest(unittest.TestCase):
    def assert_evaluation(
        self,
        result: dict,
        *,
        passed: bool,
        failed_check: str | None = None,
    ) -> None:
        self.assertEqual(result["passed"], passed, result)
        if passed:
            return
        failed = {
            check["name"]
            for check in result["checks"]
            if not check["passed"]
        }
        self.assertIn(failed_check, failed, result)

    def test_b01_accepts_only_clean_quick_work(self) -> None:
        accepted = "已完成文案修改并验证导入。\n审查状态：自查\n"
        cases = (
            ("accepted", {}, True, None, accepted),
            (
                "missing status marker",
                {},
                False,
                "quick states self-review status",
                "已完成文案修改并验证导入。\n",
            ),
            (
                "independent status on quick",
                {},
                False,
                "quick states self-review status",
                "已完成文案修改。\n审查状态：独立\n",
            ),
            (
                "status marker after body reference",
                {},
                True,
                None,
                "提示要求写 `审查状态：独立`，本次实际为：\n审查状态：自查\n",
            ),
            (
                "carriage-return only report",
                {},
                True,
                None,
                "已完成。\r审查状态：自查\r",
            ),
            (
                "trailing blank lines after marker",
                {},
                True,
                None,
                "已完成文案修改并验证导入。\n审查状态：自查\n\n",
            ),
            (
                "template reference without status line",
                {},
                False,
                "quick states self-review status",
                "报告模板要求写 `审查状态：自查`。\n已完成按钮文案修改并验证导入。\n",
            ),
            (
                "status inside code fence",
                {},
                False,
                "quick states self-review status",
                "已完成按钮文案修改。\n```text\n审查状态：自查\n```\n",
            ),
            (
                "status line with trailing words",
                {},
                False,
                "quick states self-review status",
                "已完成按钮文案修改。\n审查状态：自查尚未进行\n",
            ),
            (
                "four-backtick example then status",
                {},
                True,
                None,
                "已完成修改，下面展示代码块格式：\n````markdown\n```python\n"
                'BUTTON_LABEL = "保存"\n```\n````\n审查状态：自查\n',
            ),
            (
                "indented marker line is not a status line",
                {},
                False,
                "quick states self-review status",
                "已完成修改。\n\n    审查状态：自查\n",
            ),
            (
                "space-tab indented status line",
                {},
                False,
                "quick states self-review status",
                "已完成修改。以下仅展示格式：\n\n \t审查状态：自查\n",
            ),
            (
                "inline code line then status",
                {},
                True,
                None,
                '已完成修改，更新的声明如下：\n\n```BUTTON_LABEL = "保存"```\n\n'
                "审查状态：自查\n",
            ),
            (
                "tab-indented status line",
                {},
                False,
                "quick states self-review status",
                "已完成修改。以下仅展示格式：\n\n\t审查状态：自查\n",
            ),
            (
                "status line not last",
                {},
                False,
                "quick states self-review status",
                "审查状态：自查\n已完成按钮文案修改。\n",
            ),
            (
                "loaded reference",
                {"module_access": {"references/execution.md": 1}},
                False,
                "quick did not load references",
                accepted,
            ),
            (
                "left quick",
                {"final_path": "full"},
                False,
                "route did not leave quick",
                accepted,
            ),
            (
                "hidden workspace change",
                {"workspace_changes": ["sitecustomize.py"]},
                False,
                "no hidden workspace changes",
                accepted,
            ),
            (
                "runtime skill change",
                {"runtime_skill_changes": ["SKILL.md"]},
                False,
                "runtime Skill stayed unchanged",
                accepted,
            ),
            (
                "git metadata change",
                {"git_metadata_changes": ["config"]},
                False,
                "git control metadata stayed unchanged",
                accepted,
            ),
            (
                "uncaptured worktree change",
                {"uncaptured_worktree_paths": ["src/ui.py"]},
                False,
                "capture left no unrecorded worktree changes",
                accepted,
            ),
        )
        for label, evidence, expected, failed_check, message in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    workspace = Path(temporary)
                    prepare("b01", workspace)
                    (workspace / "src" / "ui.py").write_text(
                        'BUTTON_LABEL = "保存"\n',
                        encoding="utf-8",
                    )
                    result = load_scenario("b01").evaluate(
                        workspace,
                        ["src/ui.py"],
                        message,
                        observed("quick", **evidence),
                    )
                self.assert_evaluation(
                    result,
                    passed=expected,
                    failed_check=failed_check,
                )

    def test_b02_rejects_incomplete_authorization_or_review(self) -> None:
        cases = (
            ("accepted", B02_SOLUTION, {"reviewers": 1}, True, None),
            (
                "missing identity check",
                B02_MISSING_IDENTITY_CHECK,
                {"reviewers": 1},
                False,
                "ownership behavior passes",
            ),
            (
                "quick route",
                B02_SOLUTION,
                {"path": "quick", "reviewers": 1},
                False,
                "route is full or upgraded to full",
            ),
            (
                "incomplete reviewer",
                B02_SOLUTION,
                {"reviewers": 1, "completed_reviewers": 0},
                False,
                "independent reviewer exists",
            ),
            (
                "candidate full tier",
                B02_SOLUTION,
                {"path": "quick", "final_path": "full-local", "reviewers": 1},
                False,
                "route is full or upgraded to full",
            ),
            (
                "hidden workspace change",
                B02_SOLUTION,
                {"reviewers": 1, "workspace_changes": ["sitecustomize.py"]},
                False,
                "no hidden workspace changes",
            ),
        )
        for label, source, evidence, expected, failed_check in cases:
            with self.subTest(case=label):
                evidence = dict(evidence)
                path = evidence.pop("path", "full")
                with tempfile.TemporaryDirectory() as temporary:
                    workspace = Path(temporary)
                    prepare("b02", workspace)
                    (workspace / "src" / "access.py").write_text(
                        source,
                        encoding="utf-8",
                    )
                    result = load_scenario("b02").evaluate(
                        workspace,
                        ["src/access.py"],
                        "",
                        observed(path, **evidence),
                    )
                self.assert_evaluation(
                    result,
                    passed=expected,
                    failed_check=failed_check,
                )

    def test_b02_acceptance_does_not_execute_workspace_sitecustomize(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            prepare("b02", workspace)
            (workspace / "src" / "access.py").write_text(
                B02_SOLUTION,
                encoding="utf-8",
            )
            (workspace / "sitecustomize.py").write_text(
                'raise RuntimeError("sitecustomize must not run")\n',
                encoding="utf-8",
            )
            result = load_scenario("b02").evaluate(
                workspace,
                ["src/access.py"],
                "",
                observed("full", reviewers=1),
            )
        self.assertTrue(result["passed"], result)

    def test_route_reaches_formal_full_and_never_downgrades(self) -> None:
        cases = (
            ("initial full", observed("full", final_path="full"), True),
            ("quick upgraded", observed("quick", final_path="full"), True),
            ("quick flag without final", observed("quick", upgraded=True), False),
            ("downgraded to quick", observed("full", final_path="quick"), False),
            ("candidate local", observed("full", final_path="full-local"), False),
            ("candidate staged", observed("full", final_path="full-staged"), False),
        )
        for label, evidence, expected in cases:
            with self.subTest(case=label):
                self.assertEqual(entered_full(evidence), expected)

    def test_b16_audit_requires_read_only_evidence_and_ranked_findings(self) -> None:
        base_evidence = {"file_access": {"src/ledger.py": 1}}

        def report(block: str, *, limits: str = "未检查：并发运行环境。\n") -> str:
            return (
                "## 确定发现\n"
                "资金写入路径缺少参数校验与幂等保护。\n\n"
                "## 待验证风险\n"
                "上游是否自动重试尚未确认。\n\n"
                "```easydev-findings\n" + block + "```\n" + limits
            )

        finding = "P1 | 位置=src/ledger.py:5 | 触发=负数金额 | 后果=余额反向增加\n"
        cases = (
            ("accepted finding", report(finding), {}, True, None),
            (
                "symbol location",
                report("P1 | 位置=src/ledger.py:withdraw | 触发=重复请求 | 后果=重复扣款\n"),
                {},
                True,
                None,
            ),
            (
                "missing findings block",
                "## 确定发现\n资金写入路径缺少校验。\n\n未检查：并发运行环境。\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "empty findings block",
                report(""),
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "malformed finding line",
                report("P1 | 位置=src/ledger.py:5 | 触发=负数金额\n"),
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "empty trigger field",
                report("P1 | 位置=src/ledger.py:5 | 触发=   | 后果=余额反向增加\n"),
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "line outside money path",
                report("P1 | 位置=src/ledger.py:1 | 触发=负数金额 | 后果=余额反向增加\n"),
                {},
                False,
                "audit reports a concrete finding",
            ),
            (
                "line outside file",
                report("P1 | 位置=src/ledger.py:99 | 触发=负数金额 | 后果=余额反向增加\n"),
                {},
                False,
                "audit reports a concrete finding",
            ),
            (
                "symbol not on line",
                report("P1 | 位置=src/ledger.py:5:LEDGER | 触发=负数金额 | 后果=余额反向增加\n"),
                {},
                False,
                "audit reports a concrete finding",
            ),
            (
                "misplaced fence inside findings block",
                "未检查：并发环境。\n```easydev-findings\n" + finding + "~~~\n```\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "mixed valid and invalid locations",
                report(
                    finding
                    + "P2 | 位置=src/ledger.py:99 | 触发=重复请求 | 后果=重复扣款\n"
                ),
                {},
                False,
                "audit finding locations resolve",
            ),
            (
                "helper location plus money path",
                report(
                    finding
                    + "P3 | 位置=src/reporting.py:1 | 触发=重复 helper | 后果=维护成本翻倍\n"
                ),
                {},
                True,
                None,
            ),
            (
                "money entry plus ledger container line",
                report(
                    finding
                    + "P2 | 位置=src/ledger.py:1 | 触发=持续调用 | 后果=全局账本列表持续增长\n"
                ),
                {},
                True,
                None,
            ),
            (
                "inline code line before findings block",
                "未检查：并发环境。\n\n```withdraw(account, amount)```\n\n"
                "```easydev-findings\n" + finding + "```\n",
                {},
                True,
                None,
            ),
            (
                "space-tab indented example",
                "未发现确定缺陷。\n未检查：并发环境。\n以下仅展示格式：\n\n"
                " \t```easydev-findings\n"
                " \tP1 | 位置=src/ledger.py:5 | 触发=负数金额 | 后果=余额反向增加\n"
                " \t```\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "windows separator location",
                report("P1 | 位置=src\\ledger.py:5 | 触发=负数金额 | 后果=余额反向增加\n"),
                {},
                True,
                None,
            ),
            (
                "indented code example",
                "未发现确定缺陷。\n未检查：并发环境。\n以下仅展示格式：\n\n"
                "    ```easydev-findings\n"
                "    P1 | 位置=src/ledger.py:5 | 触发=负数金额 | 后果=余额反向增加\n"
                "    ```\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "other file location",
                report("P1 | 位置=src/reporting.py:1 | 触发=负数金额 | 后果=余额反向增加\n"),
                {},
                False,
                "audit reports a concrete finding",
            ),
            (
                "path outside workspace",
                report("P1 | 位置=../outside.py:1 | 触发=负数金额 | 后果=余额反向增加\n"),
                {},
                False,
                "audit reports a concrete finding",
            ),
            (
                "more than 20 findings",
                report(
                    "".join(
                        f"P3 | 位置=src/ledger.py:5 | 触发=负数金额 | 后果=余额反向增加 {index}\n"
                        for index in range(21)
                    )
                ),
                {},
                False,
                "audit reports at most 20 findings",
            ),
            (
                "unranked severities",
                report(
                    "P1 | 位置=src/ledger.py:5 | 触发=负数金额 | 后果=余额反向增加\n"
                    "P3 | 位置=src/ledger.py:6 | 触发=重复请求 | 后果=重复记账\n"
                    "P1 | 位置=src/ledger.py:5 | 触发=重试 | 后果=重复扣款\n"
                ),
                {},
                False,
                "audit ranks findings by severity",
            ),
            (
                "unterminated second findings block",
                report(finding)
                + "```easydev-findings\n"
                "P0 | 位置=src/ledger.py:5 | 触发=重复请求 | 后果=重复扣款\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "shorter closing fence",
                "未检查：并发环境。\n"
                "````easydev-findings\n" + finding + "```\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "longer closing fence",
                "未检查：并发环境。\n"
                "```easydev-findings\n" + finding + "````\n",
                {},
                True,
                None,
            ),
            (
                "outer fence with multi-word info string",
                "未发现确定缺陷。\n未检查：并发环境。\n以下仅展示报告格式：\n\n"
                "````markdown title=\"example\"\n```easydev-findings\n"
                + finding
                + "```\n````\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "two findings blocks",
                report(finding) + "```easydev-findings\nP2 | 位置=src/ledger.py:5 | 触发=x | 后果=y\n```\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "valid block plus empty block",
                report(finding) + "```easydev-findings\n```\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "carriage-return line endings",
                "未检查：并发环境。\r```easydev-findings\r" + finding + "```\r",
                {},
                True,
                None,
            ),
            (
                "cr-joined line before outer example fence",
                "未检查：并发环境。\r````text\n```easydev-findings\n"
                + finding
                + "```\n````\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "form feed after outer closing fence",
                "未发现确定缺陷。\n未检查：并发环境。\n\n````text\n````\u000c\n"
                "```easydev-findings\n" + finding + "```\n````\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "nbsp after outer closing fence",
                "未发现确定缺陷。\n未检查：并发环境。\n\n````text\n````\u00a0\n"
                "```easydev-findings\n" + finding + "```\n````\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "outer tilde fence",
                "未发现确定缺陷。\n未检查：并发环境。\n以下仅展示格式：\n\n"
                "~~~~\n```easydev-findings\n" + finding + "```\n~~~~\n",
                {},
                False,
                "audit findings block is well formed",
            ),
            (
                "missing limits statement",
                report(finding, limits=""),
                {},
                False,
                "audit states limits or assumptions",
            ),
            (
                "no read evidence",
                report(finding),
                {"file_access": {}},
                False,
                "audit inspected src/ledger.py",
            ),
            (
                "index changed",
                report(finding),
                {"index_changed": True},
                False,
                "audit left the git index unchanged",
            ),
            (
                "ignored workspace changed",
                report(finding),
                {"workspace_changes": [".pytest_cache/v/cache/nodeids"]},
                False,
                "audit left every workspace path unchanged",
            ),
            (
                "git metadata changed",
                report(finding),
                {"git_metadata_changes": ["config"]},
                False,
                "audit left Git control metadata unchanged",
            ),
            (
                "uncaptured worktree change",
                report(finding),
                {"uncaptured_worktree_paths": ["src/ledger.py"]},
                False,
                "audit capture has no unrecorded worktree changes",
            ),
            (
                "runtime skill changed",
                report(finding),
                {"runtime_skill_changes": ["SKILL.md"]},
                False,
                "audit left the runtime Skill unchanged",
            ),
            (
                "reviewer spawned",
                report(finding),
                {"reviewers": 1},
                False,
                "audit did not spawn a reviewer",
            ),
        )
        for label, message, overrides, expected, failed_check in cases:
            with self.subTest(case=label):
                evidence = {**base_evidence, **overrides}
                with tempfile.TemporaryDirectory() as temporary:
                    workspace = Path(temporary) / "workspace"
                    prepare("b16", workspace)
                    result = load_scenario("b16").evaluate(
                        workspace,
                        [],
                        message,
                        observed("unknown", **evidence),
                    )
                self.assert_evaluation(
                    result,
                    passed=expected,
                    failed_check=failed_check,
                )

    def test_public_contract_requires_clean_full_contract_and_verified_callers(
        self,
    ) -> None:
        metadata_markers = (
            "solution.patch",
            "dataset.json",
            "manifest.json",
            "results.jsonl",
            "summary.json",
            "report.md",
            "agent.patch",
        )
        cases = [
            (
                "accepted",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"reviewers": 1},
                True,
                None,
            ),
            (
                "hidden workspace change",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"workspace_changes": ["sitecustomize.py"]},
                False,
                "no hidden workspace changes",
            ),
            (
                "quick route",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "quick",
                {"reviewers": 1},
                False,
                "route is full or upgraded to full",
            ),
            (
                "candidate full tier",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "quick",
                {"final_path": "full-local", "reviewers": 1},
                False,
                "route is full or upgraded to full",
            ),
            (
                "incomplete reviewer",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"reviewers": 1, "completed_reviewers": 0},
                False,
                "independent reviewer exists",
            ),
            (
                "test file changed",
                PUBLIC_CONTRACT_CHANGED_PATHS + ["tests/test_orders.py"],
                "full",
                {"reviewers": 1},
                False,
                "no test or case-file changes",
            ),
            (
                "fixture path changed",
                PUBLIC_CONTRACT_CHANGED_PATHS + ["probe.py"],
                "full",
                {"reviewers": 1},
                False,
                "no test or case-file changes",
            ),
            (
                "outside product changed",
                PUBLIC_CONTRACT_CHANGED_PATHS + ["README.md"],
                "full",
                {"reviewers": 1},
                False,
                "only app product files changed",
            ),
            (
                "runtime skill changed",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"reviewers": 1, "runtime_skill_changes": ["SKILL.md"]},
                False,
                "runtime Skill stayed unchanged",
            ),
            (
                "git metadata changed",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"reviewers": 1, "git_metadata_changes": ["config"]},
                False,
                "git control metadata stayed unchanged",
            ),
            (
                "uncaptured worktree change",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"reviewers": 1, "uncaptured_worktree_paths": ["app/orders.py"]},
                False,
                "capture left no unrecorded worktree changes",
            ),
        ]
        cases.extend(
            (
                f"metadata {marker}",
                PUBLIC_CONTRACT_CHANGED_PATHS,
                "full",
                {"reviewers": 1, "metadata_access": {marker: 1}},
                False,
                "no benchmark metadata access attempt was visible",
            )
            for marker in metadata_markers
        )

        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary) / "workspace"
            prepare("public-contract-callers", workspace)
            applied = subprocess.run(
                [
                    "git",
                    "apply",
                    str(
                        CASES
                        / "public-contract-callers"
                        / "solution.patch"
                    ),
                ],
                cwd=str(workspace),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            (workspace / "sitecustomize.py").write_text(
                'raise RuntimeError("sitecustomize must not run")\n',
                encoding="utf-8",
            )
            for label, paths, path, evidence, expected, failed_check in cases:
                with self.subTest(case=label):
                    result = load_scenario("public-contract-callers").evaluate(
                        workspace,
                        paths,
                        "",
                        observed(path, **evidence),
                    )
                    self.assert_evaluation(
                        result,
                        passed=expected,
                        failed_check=failed_check,
                    )


class SnapshotDetectionTest(unittest.TestCase):
    def test_snapshots_cover_runtime_workspace_and_git_metadata_changes(self) -> None:
        with self.subTest(case="runtime skill"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                prepare("b16", workspace)
                skill = install_skill(ROOT, workspace)
                before = snapshot_runtime_tree(skill)
                (skill / "SKILL.md").write_text("changed\n", encoding="utf-8")
                self.assertEqual(runtime_tree_changes(before, skill), ["SKILL.md"])

        with self.subTest(case="ignored workspace cache"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                prepare("b16", workspace)
                before = snapshot_workspace(workspace)
                cache = workspace / ".pytest_cache" / "v" / "cache"
                cache.mkdir(parents=True)
                (cache / "nodeids").write_text("[]\n", encoding="utf-8")
                self.assertIn(
                    ".pytest_cache/v/cache/nodeids",
                    workspace_changes(before, workspace),
                )

        with self.subTest(case="git hook and config"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                (workspace / "source.py").write_text(
                    "VALUE = 1\n",
                    encoding="utf-8",
                )
                init_git(workspace)
                before = snapshot_git_metadata(workspace)
                hook = workspace / ".git" / "hooks" / "post-index-change"
                hook.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                hook.chmod(0o755)
                subprocess.run(
                    ["git", "config", "core.hooksPath", ".git/hooks"],
                    cwd=workspace,
                    check=True,
                )
                changed = git_metadata_changes(before, workspace)
                self.assertIn("config", changed)
                self.assertIn("hooks/post-index-change", changed)


@unittest.skipUnless(os.name == "posix", "Git shells are POSIX-specific")
class GitCaptureProtectionTest(unittest.TestCase):
    def test_capture_does_not_execute_agent_hook_or_clean_filter(self) -> None:
        with self.subTest(case="post-index hook"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                source = workspace / "source.py"
                source.write_text("VALUE = 1\n", encoding="utf-8")
                base_sha = init_git(workspace)
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
                source.write_text("VALUE = 2\n", encoding="utf-8")

                captured = capture_changes(workspace, base_sha, trusted_config)

                self.assertFalse(marker.exists())
                self.assertEqual(source.read_text(encoding="utf-8"), "VALUE = 2\n")
                self.assertEqual(captured["changed_paths"], ["source.py"])
                self.assertEqual(captured["uncaptured_worktree_paths"], [])

        with self.subTest(case="clean filter"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                source = workspace / "source.py"
                source.write_text("VALUE = 1\n", encoding="utf-8")
                base_sha = init_git(workspace)
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

                captured = capture_changes(workspace, base_sha, trusted_config)

                self.assertFalse(marker.exists())
                self.assertEqual(source.read_text(encoding="utf-8"), "VALUE = 2\n")
                self.assertEqual(
                    captured["changed_paths"],
                    [".gitattributes", "source.py"],
                )
                self.assertEqual(captured["uncaptured_worktree_paths"], [])
                self.assertIn(
                    str(filter_script),
                    (workspace / ".git" / "config").read_text(encoding="utf-8"),
                )

    def test_capture_reports_staged_and_assume_unchanged_changes(self) -> None:
        with self.subTest(case="pre-existing staged change"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                source = workspace / "src" / "example.py"
                source.parent.mkdir()
                source.write_text("VALUE = 1\n", encoding="utf-8")
                base_sha = init_git(workspace)
                trusted_config = (workspace / ".git" / "config").read_bytes()

                source.write_text("VALUE = 2\n", encoding="utf-8")
                subprocess.run(
                    ["git", "add", "src/example.py"],
                    cwd=workspace,
                    check=True,
                )
                source.write_text("VALUE = 1\n", encoding="utf-8")

                captured = capture_changes(workspace, base_sha, trusted_config)
                self.assertTrue(captured["index_changed"])
                self.assertEqual(
                    captured["staged_paths_before_capture"],
                    ["src/example.py"],
                )
                self.assertEqual(captured["changed_paths"], [])

        with self.subTest(case="assume-unchanged change"):
            with tempfile.TemporaryDirectory() as temporary:
                workspace = Path(temporary) / "workspace"
                workspace.mkdir()
                source = workspace / "src" / "example.py"
                source.parent.mkdir()
                source.write_text("VALUE = 1\n", encoding="utf-8")
                base_sha = init_git(workspace)
                trusted_config = (workspace / ".git" / "config").read_bytes()

                source.write_text("VALUE = 2\n", encoding="utf-8")
                subprocess.run(
                    [
                        "git",
                        "update-index",
                        "--assume-unchanged",
                        "src/example.py",
                    ],
                    cwd=workspace,
                    check=True,
                )

                captured = capture_changes(workspace, base_sha, trusted_config)
                self.assertTrue(captured["index_changed"])
                self.assertIn("src/example.py", captured["index_flag_paths"])
                self.assertEqual(captured["changed_paths"], ["src/example.py"])


class AdapterEventValidationTest(unittest.TestCase):
    def test_adapter_rejects_malformed_event_shapes(self) -> None:
        cases = (
            ("invalid json", "{not-json}"),
            ("array", "[]"),
            ("non-object item", '{"type":"item.completed","item":[]}'),
            (
                "non-string receiver",
                '{"type":"item.completed","item":'
                '{"type":"collab_tool_call","receiver_thread_ids":"reviewer-1"}}',
            ),
        )
        for label, line in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    events_path = Path(temporary) / "events.jsonl"
                    events_path.write_text(line + "\n", encoding="utf-8")
                    parsed = parse_adapter_events(events_path)
                self.assertEqual(parsed["event_count"], 0)
                self.assertEqual(parsed["malformed_event_lines"], 1)


class ProcessIdentityTest(unittest.TestCase):
    def test_stale_or_reused_process_identity_is_not_signaled(self) -> None:
        current = os.getpid()
        stale_identity = {
            current: (os.getppid(), (-1,)),
        }
        with self.subTest(case="known descendant"):
            with patch.object(
                process_control,
                "_process_snapshot",
                return_value=stale_identity,
            ), patch.object(process_control, "_signal_pid") as signal_pid:
                process_control._signal_known(
                    {current: (-2,)},
                    signal.SIGTERM,
                )
            signal_pid.assert_not_called()

        with self.subTest(case="reused root"):
            process = SimpleNamespace(pid=current, poll=lambda: 1)
            with patch.object(
                process_control,
                "_process_snapshot",
                return_value=stale_identity,
            ), patch.object(
                process_control,
                "_signal_pid",
            ) as signal_pid, patch.object(
                process_control,
                "_signal_group",
            ) as signal_group:
                process_control.terminate_process(
                    process,
                    tracked={current: (-2,)},
                    grace_seconds=0,
                )
            signal_group.assert_not_called()
            signal_pid.assert_not_called()


@unittest.skipUnless(os.name == "posix", "process groups are POSIX-specific")
class ProcessTerminationTest(unittest.TestCase):
    def test_timeout_termination_kills_descendants_and_reaps_leader(self) -> None:
        cases = (
            ("ordinary descendant", False),
            ("session-detached descendant", True),
        )
        for label, detached in cases:
            with self.subTest(case=label):
                with tempfile.TemporaryDirectory() as temporary:
                    marker = Path(temporary) / "child-finished"
                    detach = "os.setsid();" if detached else ""
                    imports = "import os,pathlib,signal,time" if detached else (
                        "import pathlib,signal,time"
                    )
                    child_code = (
                        f"{imports};"
                        f"{detach}"
                        "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
                        "time.sleep(0.8);"
                        f"pathlib.Path({str(marker)!r}).write_text('alive')"
                    )
                    parent_code = (
                        "import subprocess,sys,time;"
                        f"subprocess.Popen([sys.executable,'-c',{child_code!r}]);"
                        "time.sleep(30)"
                    )
                    process = subprocess.Popen(
                        [sys.executable, "-c", parent_code],
                        start_new_session=True,
                    )
                    time.sleep(0.2)
                    _terminate_process(process, grace_seconds=0.3)
                    self.assertIsNotNone(process.poll())
                    time.sleep(1.0)
                    self.assertFalse(marker.exists())

        with self.subTest(case="leader handles SIGTERM"):
            parent_code = (
                "import signal,sys,time;"
                "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0));"
                "time.sleep(30)"
            )
            process = subprocess.Popen(
                [sys.executable, "-c", parent_code],
                start_new_session=True,
            )
            time.sleep(0.2)
            _terminate_process(process, grace_seconds=0.5)
            self.assertIsNotNone(process.poll())


if __name__ == "__main__":
    unittest.main()
