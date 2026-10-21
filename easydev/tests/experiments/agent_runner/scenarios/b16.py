"""B16: repository audit must remain read-only and report ranked findings."""

from __future__ import annotations

import ast
import re
from pathlib import Path

from .common import check, evaluation, write_files


TITLE = "B16 read-only audit"
# The free-form report cannot prove that a finding is concrete.  The checks
# therefore only read the machine-checkable block at the end of the report:
# each finding names a real `file:line` inside the audited fixture, and at
# least one points into the money-writing function.  Trigger/impact fields only
# have to be non-empty; this checks localisation, not prose quality.
FINDING_ROW = re.compile(
    r"^\s*(P[0-3])\s*\|\s*(?:位置|location)\s*=\s*(.+?)\s*\|"
    r"\s*(?:触发|trigger)\s*=\s*(.+?)\s*\|\s*(?:后果|impact)\s*=\s*(.+?)\s*$",
    re.IGNORECASE,
)
FENCE_LINE = re.compile(r"^(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$")
LOCATION = re.compile(
    r"^(?P<path>[A-Za-z0-9_./-]+\.py)(?::(?P<line>\d+))?(?::(?P<symbol>[A-Za-z_][A-Za-z0-9_]*))?$"
)
MONEY_FUNCTION = "withdraw"
MAX_FINDINGS = 20
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
            "README.md": (
                "# Audit fixture\n\n"
                "Small repository for read-only audit behavior.\n"
                "The money-writing path has no test and ignores negative amounts.\n"
            ),
        },
    )


def _fence(line: str):
    """Return the fence match for a report-level line, or None.

    Only 0-3 leading spaces are report level; four or more is an indented code
    example.  Fences inside list or quote containers are not supported because
    the prompt asks for a top-level block.
    """
    indent = 0
    while indent < len(line) and line[indent] == " ":
        indent += 1
    if indent > 3:
        return None
    rest = line[indent:]
    if not rest or rest[0] not in "`~":
        return None
    match = FENCE_LINE.match(rest.rstrip(" \t"))
    if match is None:
        return None
    if match.group(1)[0] == "`" and "`" in match.group(2):
        # An info string on a backtick fence cannot contain a backtick.
        return None
    return match


class _Scanner:
    """Line scanner for the report-level code and findings fences."""

    def __init__(self) -> None:
        self.entries: list[dict] = []
        self.problems: list[str] = []
        self.state = "text"
        self.fence_char = ""
        self.fence_len = 0
        self.blocks = 0

    def feed(self, line: str) -> None:
        fence = _fence(line)
        if fence:
            self._fence(fence, line)
            return
        if self.state == "findings":
            self._finding(line)

    def _fence(self, fence, line: str) -> None:
        ticks, info = fence.group(1), fence.group(2)
        if self.state == "text":
            if info.lower() in {"easydev-findings", "findings"}:
                self.blocks += 1
                if self.blocks > 1:
                    self.problems.append("multiple findings blocks")
                self.state = "findings"
            else:
                self.state = "code"
            self.fence_char, self.fence_len = ticks[0], len(ticks)
            return
        same_family = ticks[0] == self.fence_char and len(ticks) >= self.fence_len
        if self.state == "findings" and same_family and info:
            self.problems.append("nested findings block")
            return
        if same_family and not info:
            self.state, self.fence_char, self.fence_len = "text", "", 0
            return
        if self.state == "findings":
            self.problems.append(f"misplaced fence in findings block: {line.strip()}")

    def _finding(self, line: str) -> None:
        if not line.strip():
            return
        parsed = FINDING_ROW.match(line)
        if parsed is None:
            self.problems.append(f"malformed finding line: {line.strip()}")
            return
        severity, location, trigger, impact = (
            value.strip() for value in parsed.groups()
        )
        if not (severity and location and trigger and impact):
            self.problems.append(f"finding line with empty field: {line.strip()}")
            return
        self.entries.append(
            {
                "severity": severity.upper(),
                "location": location,
                "trigger": trigger,
                "impact": impact,
            }
        )


def parse_findings(text: str) -> tuple[list[dict], list[str]]:
    """Parse the report-level machine block; return findings and format issues."""
    scanner = _Scanner()
    # Split on CR/LF only: splitlines() would treat \f/\x85/\u2028 as new lines.
    for line in re.split(r"\r\n|\r|\n", text):
        scanner.feed(line)
    if scanner.state == "findings":
        scanner.problems.append("unterminated findings block")
    if not scanner.entries and not scanner.problems:
        scanner.problems.append("missing findings block")
    elif not scanner.entries:
        scanner.problems.append("findings block is empty")
    return scanner.entries, scanner.problems


def money_path_lines(source: str) -> set:
    """Return the line numbers occupied by the money-writing function."""
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
    """The location must point at a real line inside the audited fixture."""
    location = entry["location"].replace("\\", "/")
    match = LOCATION.match(location)
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
        check("audit findings block is well formed", not problems, problems),
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
    return evaluation(
        checks,
        details={
            "findings": entries,
            "format_problems": problems,
            "file_access": dict(sorted(file_access.items())),
        },
    )
