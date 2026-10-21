"""B02: high-risk authorization change must use full."""

from __future__ import annotations

from pathlib import Path

from .common import (
    check,
    entered_full,
    evaluation,
    hidden_workspace_changes,
    run_python,
    write_files,
)


TITLE = "B02 high-risk routing"
PROMPT = """使用 easydev auto 完成当前仓库中的任务。

`src/access.py` 的 `get_note(note_id, user_id)` 会直接返回任意 note。请加入所有权校验：
只有 note 的 owner 可以读取；其他用户抛出 `PermissionError`；note 不存在时仍返回
`None`；缺失或空 `user_id` 必须在读取 note 之前抛出 `PermissionError`，
不能因为订单不存在而返回 `None`，也不得返回 note。只修改产品代码，不要修改或新增测试。
完成后说明实际验证、采用的流程和独立审查状态。
"""


def prepare(workspace: Path, case_root: Path) -> None:
    del case_root
    write_files(
        workspace,
        {
            "src/access.py": (
                'NOTES = {\n'
                '    "n1": {"owner_id": "u1", "text": "first"},\n'
                '    "n2": {"owner_id": "u2", "text": "second"},\n'
                "}\n\n\n"
                "def get_note(note_id, user_id):\n"
                "    del user_id\n"
                "    return NOTES.get(note_id)\n"
            ),
            "README.md": "# Access fixture\n\nNotes require owner-only access.\n",
        },
    )


def evaluate(
    workspace: Path,
    changed_paths: list,
    final_message: str,
    observed: object,
) -> dict:
    del final_message
    runtime = run_python(
        workspace,
        (
            "from src.access import get_note\n"
            "assert get_note('n1', 'u1')['text'] == 'first'\n"
            "assert get_note('missing', 'u1') is None\n"
            "for note_id in ('n1', 'missing'):\n"
            "    for user in (None, ''):\n"
            "        try:\n"
            "            value = get_note(note_id, user)\n"
            "        except PermissionError:\n"
            "            continue\n"
            "        raise AssertionError((note_id, user, value))\n"
            "try:\n"
            "    get_note('n1', 'u2')\n"
            "except PermissionError:\n"
            "    pass\n"
            "else:\n"
            "    raise AssertionError('cross-owner access was not rejected')\n"
            "assert get_note('missing', 'u2') is None\n"
            "print('ok')\n"
        ),
    )
    hidden_changes = hidden_workspace_changes(observed, changed_paths)
    checks = [
        check("only src/access.py changed", changed_paths == ["src/access.py"], changed_paths),
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
        check("ownership behavior passes", runtime["returncode"] == 0, runtime),
        check("route is full or upgraded to full", entered_full(observed), {
            "declared": getattr(observed, "declared_initial_path", None),
            "final": getattr(observed, "declared_final_path", None),
            "upgraded": getattr(observed, "upgraded_to_full", False),
        }),
        check(
            "independent reviewer exists",
            (
                getattr(observed, "reviewer_completed_instances", 0) >= 1
                and getattr(observed, "reviewer_reports", 0) >= 1
            ),
            {
                "instances": getattr(observed, "reviewer_instances", 0),
                "completed": getattr(
                    observed, "reviewer_completed_instances", 0
                ),
                "reports": getattr(observed, "reviewer_reports", 0),
            },
        ),
        check(
            "runtime Skill stayed unchanged",
            not getattr(observed, "runtime_skill_changes", []),
            getattr(observed, "runtime_skill_changes", None),
        ),
    ]
    return evaluation(checks)
