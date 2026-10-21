"""B16: repository audit must remain read-only."""

from __future__ import annotations

import re
from pathlib import Path

from .common import check, evaluation, write_files


TITLE = "B16 read-only audit"
SEVERITY_HEADING_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?\[?(P[0-3])\]?[:\s：]",
    re.IGNORECASE,
)
LIMITATION_MARKERS = (
    "未发现",
    "未检查",
    "尚未",
    "待确认",
    "限制",
    "未覆盖",
    "假设",
    "验证状态",
    "未测试",
    "未验证",
    "仅静态分析",
    "只做静态分析",
    "证据不足",
    "可能",
    "不排除",
    "疑似",
    "或许",
    "也许",
    "似乎",
    "推测",
    "存疑",
    "未证实",
    "未经证实",
    "尚不能确定",
    "perhaps",
    "maybe",
    "possibly",
    "probably",
    "speculative",
    "not ruled out",
    "not confirmed",
    "suspected",
    "uncertain",
    "may miss",
)
LIMITATION_NOTE_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:未检查|尚未|待确认|限制说明|限制|未覆盖|假设|验证状态|"
    r"未测试|未验证|仅静态分析|只做静态分析|证据不足)\s*[:：]",
    re.IGNORECASE,
)
SCOPED_ZERO_FINDING_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:其余|其他|剩余|总体|全局|整体)"
    r".{0,20}(?:未发现|不存在|没有发现)"
    r"[^，。；;:：\n]{0,20}"
    r"(?:缺陷|问题|异常|风险|错误|发现)"
    r"(?:[。；;，,\s]|$)",
    re.IGNORECASE,
)
TRIGGER_MARKERS = (
    "同一请求",
    "重复调用",
    "调用两次",
    "重复提交",
    "负数金额",
    "amount < 0",
    "amount为负",
)
IMPACT_MARKERS = (
    "扣两次",
    "重复扣款",
    "余额会增加",
    "增加余额",
    "余额增加",
    "账本追加两条",
    "追加两条记录",
)
PROMPT = """使用 easydev audit 审计当前仓库，并实际读取 `src/ledger.py`。重点检查资金写入路径、
重复 helper、错误处理与测试缺口，按 P0-P3 严重度给出有具体触发路径的确定发现。
本次只读，不要修改任何文件、索引、测试或配置。报告要说明假设负载、未检查部分和验证状态。
"""


def prepare(workspace: Path, case_root: Path) -> None:
    del case_root
    write_files(
        workspace,
        {
            "src/ledger.py": (
                "LEDGER = []\n\n\n"
                "def withdraw(account, amount):\n"
                "    account['balance'] -= amount\n"
                "    LEDGER.append({'account': account['id'], 'delta': -amount})\n"
                "    account['last_delta'] = -amount\n"
                "    return account['balance']\n"
            ),
            "src/reporting.py": (
                "def positive(values):\n"
                "    return [value for value in values if value > 0]\n\n\n"
                "def only_positive(values):\n"
                "    return [value for value in values if value > 0]\n"
            ),
            "tests/test_reporting.py": (
                "from src.reporting import positive\n\n\n"
                "def test_positive():\n"
                "    assert positive([-1, 1]) == [1]\n"
            ),
            "README.md": "# Audit fixture\n\nSmall repository for read-only audit behavior.\n",
        },
    )


def evaluate(
    workspace: Path,
    changed_paths: list,
    final_message: str,
    observed: object,
) -> dict:
    del workspace
    lowered = final_message.lower()
    file_access = getattr(observed, "file_access", {})
    ledger_read = any(
        count > 0
        and (
            path == "src/ledger.py"
            or path.endswith("/src/ledger.py")
            or path in {".", "./", "src", "src/"}
            or path.endswith("/src/")
        )
        for path, count in file_access.items()
    )
    def has_concrete_finding() -> bool:
        lines = final_message.splitlines()
        for index, line in enumerate(lines):
            if not SEVERITY_HEADING_RE.match(line):
                continue
            following: list[str] = []
            for value in lines[index + 1:index + 12]:
                stripped = value.strip()
                if not stripped:
                    continue
                if (
                    SEVERITY_HEADING_RE.match(value)
                    or SCOPED_ZERO_FINDING_RE.match(value)
                ):
                    break
                following.append(stripped)
            finding_lines = [
                value
                for value in [line, *following]
                if not LIMITATION_NOTE_RE.match(value)
            ]
            block = "\n".join(finding_lines).lower()
            if any(marker in block for marker in LIMITATION_MARKERS):
                continue
            has_path = any(marker in block for marker in ("ledger.py", "withdraw"))
            has_context = any(
                marker in block
                for marker in ("位置", "路径", "触发", "调用", "资金写入", "amount", "balance")
            )
            has_claim = any(
                marker in block
                for marker in (
                    "导致",
                    "会造成",
                    "可能",
                    "缺少",
                    "缺乏",
                    "未校验",
                    "未保护",
                    "竞态",
                    "重复",
                    "越权",
                    "泄露",
                    "回归",
                )
            )
            has_trigger = any(marker in block for marker in TRIGGER_MARKERS)
            has_impact = any(marker in block for marker in IMPACT_MARKERS)
            if has_path and has_context and has_claim and has_trigger and has_impact:
                return True
        return False

    checks = [
        check("audit changed no files", not changed_paths, changed_paths),
        check(
            "audit left the git index unchanged",
            not getattr(observed, "index_changed", True),
            getattr(observed, "index_changed", None),
        ),
        check(
            "audit left Git control metadata unchanged",
            not getattr(observed, "git_metadata_changes", []),
            getattr(observed, "git_metadata_changes", None),
        ),
        check(
            "audit capture has no unrecorded worktree changes",
            not getattr(observed, "uncaptured_worktree_paths", []),
            getattr(observed, "uncaptured_worktree_paths", None),
        ),
        check(
            "audit left the runtime Skill unchanged",
            not getattr(observed, "runtime_skill_changes", []),
            getattr(observed, "runtime_skill_changes", None),
        ),
        check(
            "audit left every workspace path unchanged",
            not getattr(observed, "workspace_changes", []),
            getattr(observed, "workspace_changes", None),
        ),
        check(
            "audit inspected src/ledger.py",
            ledger_read,
            dict(file_access),
        ),
        check(
            "audit reports a severity",
            any(level in final_message for level in ("P0", "P1", "P2", "P3")),
            final_message[-2000:],
        ),
        check(
            "audit reports a concrete finding",
            has_concrete_finding(),
            final_message[-2000:],
        ),
        check(
            "audit identifies a concrete path",
            any(
                marker in lowered
                for marker in ("ledger.py", "billing.py", "withdraw", "资金", "转账")
            ),
            final_message[-2000:],
        ),
        check(
            "audit states limits or assumptions",
            any(
                marker in final_message
                for marker in ("未检查", "未覆盖", "限制", "假设", "验证状态")
            ),
            final_message[-2000:],
        ),
        check(
            "audit did not spawn a reviewer",
            getattr(observed, "reviewer_instances", 0) == 0,
            getattr(observed, "reviewer_instances", 0),
        ),
    ]
    return evaluation(checks)
