from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from easytest.models import Case, TableTestError
from easytest.runtime.assertions import ExpectationError
from easytest.runtime.observability import redact
from easytest.snapshots.comparison import Difference, SnapshotMismatchError


CATEGORY_LABELS = {
    "added": "字段 / 元素新增",
    "removed": "字段 / 元素缺失",
    "type_changed": "类型变化",
    "number_changed": "数值变化",
    "text_changed": "文本变化",
    "order_changed": "列表顺序变化",
    "value_changed": "其他值变化",
    "baseline_missing": "缺少基线",
    "binary_changed": "图片 / 二进制变化",
    "format_changed": "文件格式变化",
}
STATUS_LABELS = {
    "passed": "通过",
    "failed": "失败",
    "skipped": "跳过",
    "interrupted": "中断",
    "not_run": "未执行",
}


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def safe_value(value: Any, *, path: str = "") -> Any:
    """Redact before truncating, including every ancestor of a diff field."""
    try:
        for key in re.split(r"[.\[\]'\"/]+", path):
            if key and redact("probe", _key=key) != "probe":
                result = redact(value, _key=key)
                break
        else:
            result = redact(value)
        # Fail closed for recursive objects, bad __str__, NaN or other invalid JSON.
        json.dumps(result, ensure_ascii=False, allow_nan=False)
        return result
    except Exception:
        return "[REDACTED_DUE_TO_ERROR]"


def safe_difference(difference: Difference, target: str) -> dict[str, Any]:
    result = difference.as_dict()
    result["expected"] = safe_value(difference.expected, path=difference.path)
    result["actual"] = safe_value(difference.actual, path=difference.path)
    result["path"] = str(safe_value(difference.path))
    result["target"] = str(safe_value(target))
    return result


def error_info(error: BaseException, phase: str) -> dict[str, Any]:
    if isinstance(error, SnapshotMismatchError):
        kind, message = "snapshot", "快照比较未通过；请查看结构化差异。"
        code = "SNAPSHOT_MISMATCH"
    elif isinstance(error, AssertionError):
        kind, message = "assertion", "断言未通过；请结合步骤结果检查预期。"
        code = "ASSERTION_FAILED"
    elif isinstance(error, TableTestError):
        kind, message = "framework", "框架处理失败；请按 code、field 和来源定位。"
        code = error.code
    elif not isinstance(error, Exception):
        kind, message = "interrupted", "执行被中断。"
        code = "INTERRUPTED"
    else:
        kind, message = "execution", "执行失败；原始错误见本地终端。"
        code = "EXECUTION_FAILED"
    # Arbitrary exception text/notes/tracebacks can contain credentials.
    result = {
        "type": type(error).__name__, "kind": kind, "phase": phase, "message": message,
        "code": str(safe_value(code)),
    }
    if isinstance(error, TableTestError):
        result["field"] = str(safe_value(error.field))
    if isinstance(error, ExpectationError):
        result.update(
            code="ASSERTION_PATH_MISSING" if error.reason == "missing_path" else "ASSERTION_FAILED",
            field="expect", path=str(safe_value(error.path)), operator=error.operator,
            reason=error.reason,
            expected=safe_value(error.expected, path=error.path),
            actual=safe_value(error.actual, path=error.path),
        )
    for name in ("case_id", "step_id", "source", "source_row", "operation",
                 "sheet", "column", "actual_type", "expected_type"):
        value = getattr(error, "easytest_location", {}).get(
            name, getattr(error, f"preflight_{name}", None),
        )
        if value is not None:
            result[name] = str(safe_value(value))
    return result


@dataclass
class StepReport:
    id: str
    operation: str
    executor: str
    source_row: int | None = None
    case_id: str = ""
    status: str = "not_run"
    phase: str = ""
    duration_ms: float = 0
    mocked: bool = False
    request: Any = None
    response: Any = None
    errors: list[dict[str, Any]] = field(default_factory=list)
    differences: list[dict[str, Any]] = field(default_factory=list)

    def fail(self, error: BaseException) -> None:
        self.status = "failed" if isinstance(error, Exception) else "interrupted"
        self.errors.append(error_info(error, self.phase))
        if isinstance(error, SnapshotMismatchError):
            self.differences = [
                safe_difference(difference, error.target)
                for difference in error.differences
            ]


@dataclass
class CaseReport:
    id: str
    name: str = ""
    source: str = ""
    profile: str = ""
    run_mode: str = ""
    run_id: str = ""
    input_hash: str = ""
    tags: list[str] = field(default_factory=list)
    status: str = "not_run"
    started_at: str = field(default_factory=timestamp)
    duration_ms: float = 0
    steps: list[StepReport] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def for_case(
        cls,
        case: Case,
        *,
        profile: str = "",
        run_mode: str = "",
        run_id: str = "",
        input_hash: str = "",
    ) -> CaseReport:
        return cls(
            id=str(safe_value(case.id)), name=str(safe_value(case.name)),
            source=str(safe_value(case.source)), profile=profile,
            run_mode=run_mode, run_id=run_id, input_hash=input_hash,
            tags=list(case.tags),
            steps=[
                StepReport(
                    id=str(safe_value(step.id)), operation=str(safe_value(step.operation)),
                    executor=step.executor, source_row=step.source_row, case_id=case.id,
                )
                for step in case.steps
            ],
        )

    def fail(self, error: BaseException, phase: str) -> None:
        self.status = "failed" if isinstance(error, Exception) else "interrupted"
        self.errors.append(error_info(error, phase))


@dataclass
class RunReport:
    title: str = "EasyTest 测试报告"
    started_at: str = field(default_factory=timestamp)
    cases: list[CaseReport] = field(default_factory=list)
    finished_at: str | None = None
    report_id: str = field(default_factory=lambda: uuid4().hex)
    input_hash: str = ""

    def add_error(self, error: BaseException, phase: str, source: str = "") -> None:
        record = CaseReport(id=f"run:{phase}", name="运行阶段错误", source=source)
        record.fail(error, phase)
        self.cases.append(record)

    def as_dict(self) -> dict[str, Any]:
        statuses = Counter(case.status for case in self.cases)
        categories: Counter[str] = Counter()
        groups: dict[tuple[str, str], dict[str, Any]] = {}
        for index, case in enumerate(self.cases):
            for step in case.steps:
                for difference in step.differences:
                    category = difference["category"]
                    categories[category] += 1
                    path = re.sub(r"\[\d+]", "[*]", difference["path"])
                    group = groups.setdefault(
                        (category, path),
                        {"category": category, "path": path, "count": 0, "case_indexes": []},
                    )
                    group["count"] += 1
                    if index not in group["case_indexes"]:
                        group["case_indexes"].append(index)
        total = len(self.cases)
        return {
            "schema_version": 1,
            "report_id": self.report_id,
            "input_hash": self.input_hash,
            "title": self.title,
            "started_at": self.started_at,
            "finished_at": self.finished_at or timestamp(),
            "summary": {
                "total": total,
                **{status: statuses[status] for status in STATUS_LABELS},
                "pass_rate": round(statuses["passed"] * 100 / total, 1) if total else None,
                "diff_count": sum(categories.values()),
                "duration_ms": round(sum(case.duration_ms for case in self.cases), 3),
            },
            "categories": dict(categories),
            "category_labels": CATEGORY_LABELS,
            "status_labels": STATUS_LABELS,
            "groups": sorted(groups.values(), key=lambda group: (-group["count"], group["path"])),
            "cases": [asdict(case) for case in self.cases],
        }
