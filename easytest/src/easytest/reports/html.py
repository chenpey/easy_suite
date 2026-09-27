from __future__ import annotations

import json
import os
import tempfile
from base64 import b64encode
from importlib.resources import files
from pathlib import Path

from easytest.reports.results import RunReport
from easytest.reports.pdf import render_pdf


def write_html(report: RunReport, path: str | Path) -> Path:
    """Write a self-contained report atomically; safe for offline file:// viewing."""
    target = Path(path).resolve()
    data = report.as_dict()
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False)
    pdf = b64encode(render_pdf(data)).decode("ascii")
    for character, escaped in (
        ("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"),
        ("\u2028", "\\u2028"), ("\u2029", "\\u2029"),
    ):
        payload = payload.replace(character, escaped)
    template = files("easytest.reports").joinpath("template.html").read_text(encoding="utf-8")
    content = template.replace("__REPORT_PDF__", pdf).replace("__REPORT_DATA__", payload)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=target.parent, prefix=".report-", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(content)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return target
