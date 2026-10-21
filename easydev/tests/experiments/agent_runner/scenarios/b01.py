"""B01: low-risk local change must stay quick."""

from __future__ import annotations

from pathlib import Path

from .common import (
    check,
    evaluation,
    hidden_workspace_changes,
    run_python,
    write_files,
)


TITLE = "B01 low-risk routing"
PROMPT = """使用 easydev auto 完成当前仓库中的任务。

把 `src/ui.py` 的按钮文案从“提交”改为“保存”。只修改完成该任务所需的产品代码，
不要新增、删除或修改测试，也不要引入测试框架。完成后说明实际验证、采用的处理路径
以及是否进行了独立审查。
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


def evaluate(
    workspace: Path,
    changed_paths: list,
    final_message: str,
    observed: object,
) -> dict:
    del final_message
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
    ]
    return evaluation(checks)
