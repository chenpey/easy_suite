from __future__ import annotations

import base64
import json
import re
from io import BytesIO
from uuid import UUID

from pypdf import PdfReader

from easytest.reports.html import write_html
from easytest.reports.pdf import render_pdf
from easytest.reports.results import RunReport


def test_reports_at_the_same_time_have_distinct_stable_ids():
    started_at = "2026-09-26T08:30:15.123+00:00"
    first = RunReport(started_at=started_at)
    second = RunReport(started_at=started_at)
    assert UUID(first.report_id).version == 4
    assert first.report_id != second.report_id
    assert first.as_dict()["report_id"] == first.as_dict()["report_id"] == first.report_id


def test_html_json_and_pdf_share_the_report_id_across_exports(tmp_path):
    report = RunReport(input_hash="sha256:input-fingerprint")
    for name in ("first.html", "second.html"):
        html = write_html(report, tmp_path / name).read_text()
        data = json.loads(re.search(
            r'<script type="application/json" id="report-data">(.*?)</script>', html, re.S,
        )[1])
        assert data["report_id"] == report.report_id
        assert data["input_hash"] == report.input_hash
        assert "input-finger" in html
        encoded = re.search(r'id="report-pdf">([^<]+)</script>', html)[1]
        pdf = PdfReader(BytesIO(base64.b64decode(encoded, validate=True)))
        assert report.report_id in pdf.pages[0].extract_text()
        assert report.input_hash in pdf.pages[0].extract_text()


def test_saved_report_id_is_preserved_and_legacy_data_can_render():
    report = RunReport()
    restored = RunReport(report_id=report.as_dict()["report_id"])
    assert restored.as_dict()["report_id"] == report.report_id
    legacy = report.as_dict()
    legacy.pop("report_id")
    pdf = PdfReader(BytesIO(render_pdf(legacy)))
    assert "暂无用例记录" in pdf.pages[0].extract_text()
