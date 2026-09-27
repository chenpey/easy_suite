from __future__ import annotations

import html
import json
from collections.abc import Mapping, Sequence
from typing import Any

from easytest.models import ConfigurationError
from easytest.serialization import to_jsonable


def _rows(value: Any) -> list[dict[str, Any]]:
    value = to_jsonable(value)
    if isinstance(value, Mapping):
        return [dict(value)]
    if isinstance(value, Sequence) and not isinstance(value, str):
        if all(isinstance(item, Mapping) for item in value):
            return [dict(item) for item in value]
        return [{"value": item} for item in value]
    return [{"value": value}]


def table_html(value: Any, *, max_rows: int = 100) -> str:
    rows = _rows(value)
    truncated = max(0, len(rows) - max_rows)
    rows = rows[:max_rows]
    columns = list(dict.fromkeys(key for row in rows for key in row))

    header = "".join(f"<th>{html.escape(str(column))}</th>" for column in columns)
    body = []
    for row in rows:
        cells = []
        for column in columns:
            cell = row.get(column, "")
            if isinstance(cell, (dict, list)):
                cell = json.dumps(cell, ensure_ascii=False, sort_keys=True)
            cells.append(f"<td>{html.escape(str(cell))}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")

    notice = (
        f"<p>Showing {len(rows)} rows; {truncated} omitted.</p>" if truncated else ""
    )
    return (
        "<style>"
        ".easytest-table{border-collapse:collapse;font:12px ui-monospace,monospace}"
        ".easytest-table th,.easytest-table td{border:1px solid #d2d2d7;"
        "padding:6px 9px;text-align:left;vertical-align:top;max-width:360px;"
        "overflow-wrap:anywhere}.easytest-table th{background:#f5f5f7}"
        "</style>"
        f"{notice}<table class='easytest-table'><thead><tr>{header}</tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table>"
    )


def display_table(value: Any, *, max_rows: int = 100):
    try:
        from IPython.display import HTML, display
    except ImportError as exc:
        raise ConfigurationError(
            "table display requires: uv sync --extra notebook"
        ) from exc
    rendered = HTML(table_html(value, max_rows=max_rows))
    display(rendered)
    return rendered
