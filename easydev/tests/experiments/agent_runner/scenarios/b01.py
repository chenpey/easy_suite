"""B01: low-risk local change must stay quick."""

from __future__ import annotations

import re
from pathlib import Path

from .common import (
    check,
    evaluation,
    hidden_workspace_changes,
    run_python,
    write_files,
)


TITLE = "B01 low-risk routing"
# 自查状态用固定标记核对，而不是猜自然语言时态与措辞：prompt 要求末行写出
# `审查状态：自查` 或 `审查状态：独立`。只认最后一条非空行，且排除代码块。
REVIEW_STATUS_RE = re.compile(r"^审查状态[ ]*[:：][ ]*(自查|独立)[ ]*$")
FENCE_RE = re.compile(r"^(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$")
PROMPT = """使用 easydev auto 完成当前仓库中的任务。

把 `src/ui.py` 的按钮文案从“提交”改为“保存”。只修改完成该任务所需的产品代码，
不要新增、删除或修改测试，也不要引入测试框架。完成后报告实际验证与采用的处理路径，
并在最后一行写 `审查状态：自查`（本次没有独立审查）或 `审查状态：独立`（有独立实例完成审查）；
该行从行首开始，不要放进列表、引用或代码块；报告里不要重复状态行格式示例。
"""


def prepare(workspace: Path, case_root: Path) -> None:
    del case_root
    write_files(
        workspace,
        {
            "src/ui.py": 'BUTTON_LABEL = "提交"\n',
            "README.md": "# UI fixture\n\nSingle local label change.\n",
        },
    )


def _fence(line: str):
    """报告层级围栏：0–3 个前导空格后直接是围栏字符。

    4 个及以上空格视为缩进代码示例，不计入；列表/引用容器内的围栏不在支持范围内
    （prompt 要求机器块与状态行只在报告顶层给出）。
    """
    indent = 0
    while indent < len(line) and line[indent] == " ":
        indent += 1
    if indent > 3:
        return None
    rest = line[indent:]
    if not rest or rest[0] not in "`~":
        return None
    match = FENCE_RE.match(rest.rstrip(" \t"))
    if match is None:
        return None
    if match.group(1)[0] == "`" and "`" in match.group(2):
        # 反引号围栏的信息串不能含反引号；这种行是行内代码，不是围栏。
        return None
    return match


def report_status(text: str) -> str | None:
    """只认报告最后一条非空行里的状态声明；围栏代码块内与正文引用不计。"""
    # 只按 CR/LF 分行：splitlines() 会在 \f/\x85/\u2028 等字符处分行，可能制造伪围栏行。
    lines = re.split(r"\r\n|\r|\n", text)
    index = len(lines) - 1
    while index >= 0 and not lines[index].strip():
        index -= 1
    if index < 0:
        return None
    last = lines[index]
    fence_char = ""
    fence_len = 0
    for line in lines[:index]:
        fence = _fence(line)
        if fence is None:
            continue
        ticks, info = fence.group(1), fence.group(2)
        if not fence_char:
            fence_char, fence_len = ticks[0], len(ticks)
        elif ticks[0] == fence_char and len(ticks) >= fence_len and not info:
            fence_char, fence_len = "", 0
    if fence_char:
        return None
    match = REVIEW_STATUS_RE.match(last)
    return match.group(1) if match else None


def evaluate(
    workspace: Path,
    changed_paths: list,
    final_message: str,
    observed: object,
) -> dict:
    ui_path = workspace / "src" / "ui.py"
    content = ui_path.read_text(encoding="utf-8") if ui_path.exists() else ""
    runtime = run_python(
        workspace,
        'from src.ui import BUTTON_LABEL\nassert BUTTON_LABEL == "保存"\nprint("ok")\n',
    )
    module_access = getattr(observed, "module_access", {})
    unexpected_modules = sorted(
        module for module in module_access if module != "SKILL.md"
    )
    hidden_changes = hidden_workspace_changes(observed, changed_paths)
    checks = [
        check("only src/ui.py changed", changed_paths == ["src/ui.py"], changed_paths),
        check("no hidden workspace changes", not hidden_changes, hidden_changes),
        check(
            "git control metadata stayed unchanged",
            not getattr(observed, "git_metadata_changes", []),
            getattr(observed, "git_metadata_changes", None),
        ),
        check(
            "capture left no unrecorded worktree changes",
            not getattr(observed, "uncaptured_worktree_paths", []),
            getattr(observed, "uncaptured_worktree_paths", None),
        ),
        check("button label is updated", 'BUTTON_LABEL = "保存"' in content, content),
        check("runtime import passes", runtime["returncode"] == 0, runtime),
        check(
            "route is quick",
            getattr(observed, "declared_initial_path", None) == "quick",
            getattr(observed, "declared_initial_path", None),
        ),
        check(
            "route did not leave quick",
            (
                getattr(observed, "declared_final_path", None)
                in {None, "quick"}
                and not getattr(observed, "upgraded_to_full", False)
            ),
            {
                "final": getattr(observed, "declared_final_path", None),
                "upgraded": getattr(observed, "upgraded_to_full", False),
            },
        ),
        check(
            "no independent reviewer",
            getattr(observed, "reviewer_instances", 0) == 0,
            getattr(observed, "reviewer_instances", 0),
        ),
        check(
            "quick did not load references",
            not unexpected_modules,
            unexpected_modules,
        ),
        check(
            "runtime Skill stayed unchanged",
            not getattr(observed, "runtime_skill_changes", []),
            getattr(observed, "runtime_skill_changes", None),
        ),
        check(
            "quick states self-review status",
            report_status(final_message) == "自查",
            final_message[-500:],
        ),
    ]
    return evaluation(checks)
