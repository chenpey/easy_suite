from __future__ import annotations

import json
import re
from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


_FONT = "STSong-Light"
_INK = colors.HexColor("#172c3a")
_TEAL = colors.HexColor("#06786d")
_MUTED = colors.HexColor("#60727e")


def _text(value: Any) -> str:
    # Every business string is plain text, never ReportLab's XML markup.
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value))
    return escape(cleaned).replace("\n", "<br/>")


def render_pdf(data: dict[str, Any]) -> bytes:
    """Render the complete, already-redacted report as a searchable Chinese PDF."""
    if _FONT not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))
    base = ParagraphStyle(
        "body", fontName=_FONT, fontSize=9, leading=14, textColor=_INK,
        wordWrap="CJK", splitLongWords=True, spaceAfter=6,
    )
    styles = {
        "body": base,
        "title": ParagraphStyle("title", parent=base, fontSize=23, leading=30, spaceAfter=14),
        "heading": ParagraphStyle(
            "heading", parent=base, fontSize=14, leading=21,
            textColor=_TEAL, spaceBefore=16, spaceAfter=8, keepWithNext=True,
        ),
        "step": ParagraphStyle(
            "step", parent=base, fontSize=11, leading=17,
            spaceBefore=10, keepWithNext=True,
        ),
        "muted": ParagraphStyle("muted", parent=base, fontSize=8, leading=12, textColor=_MUTED),
        "code": ParagraphStyle(
            "code", parent=base, fontSize=8, leading=12,
            backColor=colors.HexColor("#f3f6f7"), borderPadding=5,
            leftIndent=6, rightIndent=6, spaceBefore=4, spaceAfter=9,
        ),
        "error": ParagraphStyle(
            "error", parent=base, textColor=colors.HexColor("#b43e3a"),
        ),
    }
    story = []

    def add(value: Any, style: str = "body") -> None:
        story.append(Paragraph(_text(value), styles[style]))

    def payload(title: str, value: Any) -> None:
        add(title, "muted")
        # Separate paragraphs can split over pages; no oversized, unsplittable table cells.
        add(json.dumps(value, ensure_ascii=False, indent=2), "code")

    def errors(items: list[dict[str, str]]) -> None:
        for error in items:
            add(f"{error['type']} · {error['phase']}：{error['message']}", "error")

    category = data["category_labels"]
    status = data["status_labels"]
    summary = data["summary"]
    add(data["title"], "title")
    add(f"运行时间：{data['started_at']} · 累计用例耗时：{summary['duration_ms']} ms", "muted")
    add(f"报告 ID：{data['report_id']}", "muted")
    if data.get("input_hash"):
        add(f"输入哈希：{data['input_hash']}", "muted")
    add("完整报告：包含全部用例与步骤，不受网页筛选或折叠状态影响。", "muted")
    rate = "—" if summary["pass_rate"] is None else f"{summary['pass_rate']}%"
    metrics = Table([[
        Paragraph(_text(f"{label}\n{value}"), base)
        for label, value in [
            ("总用例", summary["total"]), ("通过率", rate),
            ("失败用例", summary["failed"]), ("差异总数", summary["diff_count"]),
        ]
    ]], colWidths=[(A4[0] - 96) / 4] * 4)
    metrics.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#eaf4f1")),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.extend([Spacer(1, 10), metrics, Spacer(1, 10)])
    add(" · ".join(f"{label} {summary[key]}" for key, label in status.items()))
    add("差异自动分类", "heading")
    if not data["categories"]:
        add("本次运行没有快照差异。")
    for key, count in sorted(data["categories"].items(), key=lambda item: -item[1]):
        add(f"{category.get(key, key)}：{count}")
    if data["groups"]:
        add("相同字段的问题", "heading")
        for group in data["groups"]:
            add(
                f"{group['path']} · {category.get(group['category'], group['category'])}"
                f" · {group['count']} 处差异 · {len(group['case_indexes'])} 个用例"
            )
    add("用例与步骤", "heading")
    if not data["cases"]:
        add("暂无用例记录。")
    for index, case in enumerate(data["cases"], 1):
        add(f"{index}. [{status[case['status']]}] {case['name'] or case['id']}", "heading")
        execution_id = case.get("execution_id") or case["id"]
        add(f"Case：{execution_id} · 耗时：{case['duration_ms']} ms", "muted")
        add(
            f"来源：{case['source'] or '—'} · Profile：{case['profile'] or '—'}"
            f" · 模式：{case['run_mode'] or '—'}", "muted",
        )
        if case.get("data_id") is not None:
            row = (
                f" · data 第 {case['data_source_row']} 行"
                if case.get("data_source_row") is not None
                else ""
            )
            add(
                f"数据集：{case['data_set']} · 数据行：{case['data_id']}{row}",
                "muted",
            )
            payload("本次数据", case.get("data"))
        errors(case["errors"])
        for step in case["steps"]:
            add(f"[{status[step['status']]}] {step['id']} · {step['operation']}", "step")
            row = f" · steps 第 {step['source_row']} 行" if step["source_row"] is not None else ""
            add(
                f"{step['executor']} · {'Mock' if step['mocked'] else '执行器'}"
                f" · 阶段 {step['phase'] or '未开始'} · {step['duration_ms']} ms{row}", "muted",
            )
            errors(step["errors"])
            payload("请求", step["request"])
            payload("响应", step["response"])
            for difference in step["differences"]:
                add(
                    f"{category.get(difference['category'], difference['category'])}"
                    f" · {difference['path']}", "step",
                )
                add(f"快照：{difference['target']}", "muted")
                payload(f"期望 · {difference['expected_type']}", difference["expected"])
                payload(f"实际 · {difference['actual_type']}", difference["actual"])
    add("敏感字段已脱敏；长值沿用网页中的截断标记。自动归类不修改基线。", "muted")

    def footer(canvas, document) -> None:
        canvas.saveState()
        canvas.setFont(_FONT, 8)
        canvas.setFillColor(_MUTED)
        canvas.drawString(42, 23, "EasyTest · 完整测试报告")
        canvas.drawRightString(A4[0] - 42, 23, f"第 {document.page} 页")
        canvas.restoreState()

    output = BytesIO()
    document = SimpleDocTemplate(
        output, pagesize=A4, leftMargin=42, rightMargin=42, topMargin=40,
        bottomMargin=42, title=data["title"], author="EasyTest", pageCompression=1,
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
