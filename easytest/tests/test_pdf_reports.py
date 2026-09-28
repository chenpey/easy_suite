from __future__ import annotations

from io import BytesIO

from pypdf import PdfReader

from easytest.reports.html import write_html
from easytest.reports.pdf import render_pdf, write_pdf
from easytest.reports.results import CaseReport, RunReport, StepReport, safe_difference
from easytest.snapshots.comparison import Difference


def test_explicit_pdf_contains_all_cases_details_and_redacted_diff(tmp_path):
    step = StepReport(
        id="价格检查", operation="http.price", executor="http", status="failed",
        source_row=8, request={"sku": "A100"}, response={"price": 120},
        differences=[
            safe_difference(Difference("$.price", "changed", 100, 120), "baseline.json"),
            safe_difference(
                Difference("$.Authorization.inner", "changed", "secret-old", "secret-new"),
                "baseline.json",
            ),
        ],
    )
    report = RunReport(cases=[
        CaseReport(id="failed", name="商品价格", status="failed", steps=[step]),
        CaseReport(id="passed", name="正常接口", status="passed"),
    ])
    path = write_pdf(report, tmp_path / "report.pdf")
    reader = PdfReader(path)
    text = "\n".join(page.extract_text() for page in reader.pages)
    for expected in ("商品价格", "正常接口", "数值变化", "$.price", "期望", "实际", "REDACTED"):
        assert expected in text
    assert "secret-old" not in text
    assert "secret-new" not in text
    assert not list(path.parent.glob(".report-*"))


def test_pdf_paginates_long_values_and_escapes_business_markup():
    hostile = '<a href="https://example.invalid">业务文本</a>'
    report = RunReport(cases=[CaseReport(
        id="long", name=hostile, status="passed",
        steps=[StepReport(
            id="长内容", operation="http.response", executor="http", status="passed",
            response={"rows": [f"第{i}行：中文报告" for i in range(350)], "end": "内容末尾验证"},
        )],
    )])
    reader = PdfReader(BytesIO(render_pdf(report.as_dict())))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages) > 3
    assert "内容末尾验证" in text
    assert "第349行" in text
    assert "业务文本" in text
    assert all(not page.get("/Annots") for page in reader.pages)


def test_empty_report_pdf_and_html_template_markers_in_data(tmp_path):
    reader = PdfReader(BytesIO(render_pdf(RunReport().as_dict())))
    assert "暂无用例记录" in reader.pages[0].extract_text()
    report = RunReport(cases=[CaseReport(id="__REPORT_PDF__")])
    path = write_html(report, tmp_path / "report.html")
    html = path.read_text()
    assert "__REPORT_PDF__" in html
    assert 'id="report-pdf"' not in html
    assert 'id="export-pdf"' not in html
