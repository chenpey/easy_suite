"""B16: repository audit must remain read-only and report ranked findings."""

from __future__ import annotations

import ast
import re
from pathlib import Path

from .common import check, evaluation, write_files


TITLE = "B16 read-only audit"
# 报告的自然语言部分无法稳定判定“这条算不算具体发现”。因此判定只看报告末尾的
# 机器可核对块，并要求每条发现用“文件:行号”指向被审代码：位置必须解析到审计夹具里
# 真正存在的行，且至少一条落在资金写入函数体内。这样检查的是“有没有定位到代码”，
# 而不是猜措辞，触发/后果字段只要求非空。
FINDING_LINE_RE = re.compile(
    r"^\s*(P[0-3])\s*\|\s*(?:位置|location)\s*=\s*(.+?)\s*\|"
    r"\s*(?:触发|trigger)\s*=\s*(.+?)\s*\|\s*(?:后果|impact)\s*=\s*(.+?)\s*$",
    re.IGNORECASE,
)
FENCE_RE = re.compile(r"^(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$")
LOCATION_RE = re.compile(
    r"^(?P<path>[A-Za-z0-9_./-]+\.py)(?::(?P<line>\d+))?(?::(?P<symbol>[A-Za-z_][A-Za-z0-9_]*))?$"
)
MAX_FINDINGS = 20
MONEY_FUNCTION = "withdraw"
LIMITATION_MARKERS = (
    "未检查",
    "未覆盖",
    "限制",
    "假设",
    "验证状态",
    "not checked",
    "not verified",
    "limitation",
    "assumption",
)
PROMPT = """使用 easydev audit 审计当前仓库，并实际读取 `src/ledger.py`。重点检查资金写入路径、
重复 helper、错误处理与测试缺口，按 P0-P3 严重度给出有具体触发路径的确定发现。
本次只读，不要修改任何文件、索引、测试或配置。报告要说明假设负载、未检查部分和验证状态。

报告结尾必须追加机器可核对的确定发现块（只在报告顶层给出一个块，从行首开始，
不要放进列表/引用/代码示例，也不要在报告里重复块格式示例）；块外写待验证风险、
限制与假设；块内每行一条，按 P0→P3 排序，最多 20 条。
`位置` 写成 `文件:行号`，行号必须落在被审计代码的真实行上：

```easydev-findings
P1 | 位置=src/ledger.py:5 | 触发=负数金额 | 后果=余额反向增加
```
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


def parse_findings(text: str) -> tuple[list[dict], list[str]]:
    """按围栏状态解析报告层级的机器块；返回条目与格式问题。

    外层代码示例（从行首开始的普通围栏包住的机器块）内的内容不计为提交记录；
    未闭合的机器块必须报格式问题，关闭围栏需同字符且不短于开围栏。
    """
    entries: list[dict] = []
    problems: list[str] = []
    state = "text"
    fence_char = ""
    fence_len = 0
    blocks = 0
    # 只按 CR/LF 分行：splitlines() 会在 \f/\x85/\u2028 等字符处分行，可能制造伪围栏行。
    for line in re.split(r"\r\n|\r|\n", text):
        fence = _fence(line)
        if fence:
            ticks, info = fence.group(1), fence.group(2)
            if state == "text":
                if info.lower() in {"easydev-findings", "findings"}:
                    blocks += 1
                    if blocks > 1:
                        problems.append("multiple findings blocks")
                    state, fence_char, fence_len = "findings", ticks[0], len(ticks)
                else:
                    state, fence_char, fence_len = "code", ticks[0], len(ticks)
                continue
            same_family = ticks[0] == fence_char and len(ticks) >= fence_len
            if state == "findings" and same_family and info:
                problems.append("nested findings block")
                continue
            if same_family and not info:
                state, fence_char, fence_len = "text", "", 0
                continue
            if state == "findings":
                problems.append(f"misplaced fence in findings block: {line.strip()}")
            continue
        if state in {"text", "code"}:
            continue
        # state == "findings"
        if not line.strip():
            continue
        parsed = FINDING_LINE_RE.match(line)
        if parsed is None:
            problems.append(f"malformed finding line: {line.strip()}")
            continue
        severity, location, trigger, impact = (value.strip() for value in parsed.groups())
        if not (severity and location and trigger and impact):
            problems.append(f"finding line with empty field: {line.strip()}")
            continue
        entries.append(
            {
                "severity": severity.upper(),
                "location": location,
                "trigger": trigger,
                "impact": impact,
            }
        )
    if state == "findings":
        problems.append("unterminated findings block")
    if not entries and not problems:
        problems.append("missing findings block")
    elif not entries:
        problems.append("findings block is empty")
    return entries, problems


def money_path_lines(source: str) -> set:
    """用 AST 返回资金写入函数（含 def 行）占用的行号。"""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == MONEY_FUNCTION:
            end = getattr(node, "end_lineno", node.lineno)
            return set(range(node.lineno, end + 1))
    return set()


def resolve_location(
    entry: dict,
    workspace: Path,
    *,
    require_money_path: bool = False,
) -> bool:
    """位置必须指向审计夹具内真实存在的行；资金路径约束可选。"""
    location = entry["location"].replace("\\", "/")
    match = LOCATION_RE.match(location)
    if match is None:
        return False
    relative = match.group("path")
    candidate = (workspace / relative).resolve()
    try:
        candidate.relative_to(workspace.resolve())
    except ValueError:
        return False
    if not candidate.is_file():
        return False
    try:
        source = candidate.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    is_money_path = relative.endswith("ledger.py")
    if require_money_path and not is_money_path:
        return False
    evidence_lines = (
        money_path_lines(source) if require_money_path and is_money_path else None
    )
    lines = source.splitlines()
    line = match.group("line")
    symbol = match.group("symbol")
    if line is not None:
        number = int(line)
        if not 1 <= number <= len(lines):
            return False
        if evidence_lines is not None and number not in evidence_lines:
            return False
        return symbol is None or symbol in lines[number - 1]
    if symbol is None:
        return False
    scope = (
        [lines[number - 1] for number in sorted(evidence_lines)]
        if evidence_lines is not None
        else lines
    )
    return any(symbol in text for text in scope)


def evaluate(
    workspace: Path,
    changed_paths: list,
    final_message: str,
    observed: object,
) -> dict:
    lowered = final_message.lower()
    entries, problems = parse_findings(final_message)
    severities = [entry["severity"] for entry in entries]
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
            "audit findings block is well formed",
            not problems,
            problems,
        ),
        check(
            "audit reports at most 20 findings",
            1 <= len(entries) <= MAX_FINDINGS,
            len(entries),
        ),
        check(
            "audit ranks findings by severity",
            bool(entries) and severities == sorted(severities),
            severities,
        ),
        check(
            "audit finding locations resolve",
            bool(entries) and all(resolve_location(entry, workspace) for entry in entries),
            [
                {"location": entry["location"], "ok": resolve_location(entry, workspace)}
                for entry in entries
            ],
        ),
        check(
            "audit reports a concrete finding",
            any(
                resolve_location(entry, workspace, require_money_path=True)
                for entry in entries
            ),
            entries,
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
            any(marker in lowered for marker in LIMITATION_MARKERS),
            final_message[-2000:],
        ),
        check(
            "audit did not spawn a reviewer",
            getattr(observed, "reviewer_instances", 0) == 0,
            getattr(observed, "reviewer_instances", 0),
        ),
    ]
    return evaluation(checks)
