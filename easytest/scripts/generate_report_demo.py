"""Generate an offline report from real runs with deliberately changed responses."""
from __future__ import annotations

import copy
import json
import tempfile
from dataclasses import replace
from pathlib import Path

from easytest.cases.loader import load_cases
from easytest.reports.html import write_html
from easytest.reports.results import RunReport
from easytest.runtime.runner import CaseRunner
from easytest.starter import init_project


def main() -> None:
    destination = Path(__file__).resolve().parents[1] / "artifacts/report-demo.html"
    with tempfile.TemporaryDirectory(prefix="easytest-report-demo-") as directory:
        root = init_project(Path(directory) / "project")
        (root / "config/snapshots.json").write_text(json.dumps({
            "profiles": {"default": {"response_default": {}}},
        }))
        template = load_cases(root / "cases/demo.json")[0]
        body = {
            "ok": True, "price": 128, "name": "基础套餐",
            "items": ["A", "B", "B"], "removed_code": "v1",
        }

        def make_case(case_id, name, response, *, snapshot=True, expect=200):
            step = replace(
                template.steps[0], id="query_product", source_row=None,
                request={"params": {"sku": "SKU-1001"}},
                mock={"response": {"status_code": 200, "body": response}},
                snapshot={"select": "$.body"} if snapshot else None,
                expect={"$.status_code": expect},
            )
            return replace(
                template, id=case_id, name=name, source=str(Path(__file__).resolve()),
                steps=(step, replace(step, id="followup", order=2, snapshot=None, expect=None)),
            )

        seeds = [
            make_case("demo.healthy", "正常响应 · 已通过", body),
            make_case("demo.product", "商品详情 · 多类变化", body),
            make_case("demo.price", "价格查询 · 相同字段变化", body),
        ]
        with CaseRunner(root, run_mode="write") as runner:
            for case in seeds:
                runner.run(case)
        changed = copy.deepcopy(body)
        changed.update(ok="true", price=149, name="升级套餐", items=["B", "A", "B"], currency="CNY")
        changed.pop("removed_code")
        cases = [
            seeds[0],
            make_case("demo.product", seeds[1].name, changed),
            make_case("demo.price", seeds[2].name, {**body, "price": 159}),
            make_case("demo.assertion", "状态断言 · 预期不符", body, snapshot=False, expect=201),
        ]
        with CaseRunner(root, run_mode="read") as runner:
            for case in cases:
                try:
                    runner.run(case)
                except AssertionError:
                    # This example deliberately includes failures for report exploration.
                    pass
        report = RunReport(title="EasyTest 差异分类示例", cases=runner.case_reports)
        write_html(report, destination)
        print(json.dumps(report.as_dict()["summary"], ensure_ascii=False))
        print(destination)


if __name__ == "__main__":
    main()
