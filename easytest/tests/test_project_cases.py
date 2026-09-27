import json
import shutil

import pytest

from easytest.cases.compiler import compile_workbook
from easytest.cases.loader import load_project_cases
from easytest.models import ContractError
from easytest.starter import init_project


def test_directory_compiles_sources_once_and_ignores_excel_lock_files(tmp_path):
    root = init_project(tmp_path / "project")
    (root / "cases" / "~$demo.xlsx").write_bytes(b"not a workbook")
    cases = load_project_cases(root / "cases")
    assert [case.id for case in cases] == ["http.demo"]
    assert cases[0].steps[0].source_row == 2
    assert cases[0].source.endswith("demo.xlsx")
    assert load_project_cases("cases/demo.xlsx", root=root) == cases
    assert load_project_cases("cases/demo.json", root=root) == cases


def test_duplicate_case_ids_across_files_fail(tmp_path):
    root = init_project(tmp_path / "project")
    duplicate = root / "cases/duplicate.xlsx"
    shutil.copy2(root / "cases/demo.xlsx", duplicate)
    compile_workbook(duplicate)
    with pytest.raises(ContractError, match="duplicate case id"):
        load_project_cases(root / "cases")


def test_empty_missing_and_all_disabled_sources_fail(tmp_path):
    with pytest.raises(ContractError, match="no XLSX or JSON"):
        load_project_cases(tmp_path)
    with pytest.raises(ContractError, match="does not exist"):
        load_project_cases(tmp_path / "missing")
    root = init_project(tmp_path / "project")
    source = root / "cases/demo.json"
    document = json.loads(source.read_text())
    document["cases"][0]["enabled"] = False
    source.write_text(json.dumps(document))
    with pytest.raises(ContractError, match="no enabled cases"):
        load_project_cases(source)
