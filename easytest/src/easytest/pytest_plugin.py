from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from easytest.cases.loader import load_project_cases
from easytest.config import ProjectConfig
from easytest.models import Case
from easytest.reports.html import write_html
from easytest.reports.results import CaseReport, RunReport, error_info
from easytest.runtime.policy import load_execution_policy
from easytest.runtime.preflight import preflight
from easytest.runtime.runner import CaseRunner


@dataclass
class _ReportState:
    enabled: bool = False
    report: RunReport = field(default_factory=RunReport)
    records: dict[str, CaseReport] = field(default_factory=dict)
    written: Path | None = None
    write_error: str = ""


_STATE = pytest.StashKey[_ReportState]()
_RUNNERS = pytest.StashKey[list[tuple[CaseRunner, int]]]()


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("easytest")
    group.addoption(
        "--case-json",
        "--case-source",
        action="append",
        default=[],
        help="XLSX, JSON or case directory; repeatable. Defaults to root/cases.",
    )
    group.addoption(
        "--run-mode",
        choices=("read", "write", "baseline"),
        default=None,
        help="Snapshot mode (legacy database permission follows mode if unspecified).",
    )
    group.addoption("--profile", default=None, help="Run profile from config/profiles.json.")
    group.addoption("--easytest-root", default=None, help="Test project root.")
    group.addoption("--allow-db-write", dest="allow_db_write", action="store_const", const=True, default=None)
    group.addoption("--no-allow-db-write", dest="allow_db_write", action="store_const", const=False)
    group.addoption(
        "--execution-policy",
        default=None,
        help=(
            "Trusted policy JSON path. EASYTEST_EXECUTION_POLICY, when set, "
            "cannot be overridden."
        ),
    )
    group.addoption(
        "--easytest-report", default=None,
        help="HTML path relative to --easytest-root; explicitly enables all pytest tests.",
    )
    group.addoption("--no-easytest-report", action="store_true", help="Disable EasyTest HTML output.")


def pytest_configure(config: pytest.Config) -> None:
    config.stash[_STATE] = _ReportState(enabled=bool(config.getoption("--easytest-report")))


def _root(config: pytest.Config) -> Path:
    return Path(config.getoption("--easytest-root") or str(config.rootpath)).resolve()


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "table_case" not in metafunc.fixturenames:
        return
    metafunc.config.stash[_STATE].enabled = True
    case_files = metafunc.config.getoption("--case-json")
    cases = load_project_cases(case_files or "cases", root=_root(metafunc.config))
    metafunc.parametrize("table_case", cases, ids=[case.id for case in cases])


@pytest.fixture
def case_runner(request: pytest.FixtureRequest):
    request.config.stash[_STATE].enabled = True
    with CaseRunner(
        _root(request.config),
        run_mode=request.config.getoption("--run-mode"),
        profile=request.config.getoption("--profile"),
        allow_db_write=request.config.getoption("allow_db_write"),
        execution_policy=request.config.getoption("--execution-policy"),
    ) as runner:
        runners = request.node.stash.setdefault(_RUNNERS, [])
        runners.append((runner, len(runner.case_reports)))
        yield runner


def _tracked(item: pytest.Item) -> bool:
    return bool(
        item.config.getoption("--easytest-report")
        or {"case_runner", "table_case"}.intersection(getattr(item, "fixturenames", []))
        or item.stash.get(_RUNNERS, [])
    )


def _record(item: pytest.Item) -> CaseReport:
    state = item.config.stash[_STATE]
    if item.nodeid not in state.records:
        case = getattr(item, "callspec", None)
        case = case.params.get("table_case") if case is not None else None
        record = CaseReport.for_case(case) if isinstance(case, Case) else CaseReport(
            id=item.nodeid, name=item.name, source=str(item.path),
        )
        record.id = item.nodeid
        state.records[item.nodeid] = record
        state.report.cases.append(record)
    return state.records[item.nodeid]


def pytest_collection_finish(session: pytest.Session) -> None:
    selected: dict[str, Case] = {}
    conflicting: list[Case] = []
    for item in session.items:
        if _tracked(item):
            item.config.stash[_STATE].enabled = True
            _record(item)
        callspec = getattr(item, "callspec", None)
        case = callspec.params.get("table_case") if callspec is not None else None
        if isinstance(case, Case):
            if case.id in selected and selected[case.id] != case:
                conflicting.append(case)
            selected.setdefault(case.id, case)
    if selected:
        config = session.config
        try:
            project = ProjectConfig(_root(config))
            settings = project.resolve_run(
                run_mode=config.getoption("--run-mode"),
                profile=config.getoption("--profile"),
                allow_db_write=config.getoption("allow_db_write"),
            )
            policy = load_execution_policy(
                _root(config),
                config.getoption("--execution-policy"),
            )
            checked = preflight(
                [*selected.values(), *conflicting],
                project,
                settings,
                execution_policy=policy,
            )
            config.stash[_STATE].report.input_hash = checked.input_hash
        except Exception as error:
            state = config.stash[_STATE]
            recorded = False
            for record in state.report.cases:
                if any(
                    step.case_id == getattr(error, "preflight_case_id", None)
                    for step in record.steps
                ):
                    record.fail(error, "preflight")
                    recorded = True
                    for step in record.steps:
                        if step.id == getattr(error, "preflight_step_id", None):
                            step.phase = "preflight"
                            step.fail(error)
            if not recorded:
                state.report.add_error(error, "preflight")
            details = "\n".join([str(error), *getattr(error, "__notes__", [])])
            raise pytest.UsageError(f"EasyTest preflight failed:\n{details}") from error


@pytest.hookimpl(hookwrapper=True)
def pytest_make_collect_report(collector: pytest.Collector):
    outcome = yield
    result = outcome.get_result()
    if result.failed:
        state = collector.config.stash[_STATE]
        state.report.cases.append(CaseReport(
            id=result.nodeid or "collection",
            name="收集用例失败", source=str(collector.path), status="failed",
            errors=[{
                "type": "CollectionError", "kind": "execution", "phase": "collection",
                "message": "用例收集失败；原始错误见本地终端。",
            }],
        ))


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo):
    outcome = yield
    result = outcome.get_result()
    if not _tracked(item):
        return
    state = item.config.stash[_STATE]
    state.enabled = True
    record = _record(item)
    record.duration_ms += result.duration * 1000
    if result.failed:
        record.status = "failed"
        if call.excinfo is not None:
            record.errors.append(error_info(call.excinfo.value, result.when))
        else:
            record.errors.append({
                "type": "PytestFailure", "kind": "assertion", "phase": result.when,
                "message": "pytest 判定失败；详情见本地终端。",
            })
    elif result.skipped and record.status != "failed":
        record.status = "skipped"
    elif result.when == "call" and record.status not in {"failed", "skipped"}:
        record.status = "passed"
    runs = [
        report
        for runner, start in item.stash.get(_RUNNERS, [])
        for report in runner.case_reports[start:]
    ]
    if runs:
        record.steps = [step for report in runs for step in report.steps]
        record.profile, record.run_mode = runs[0].profile, runs[0].run_mode
        # pytest status is authoritative, including tests using pytest.raises.
        # Keep runtime lifecycle errors visible even when no step failed.
        for report in runs:
            for error in report.errors:
                if error not in record.errors:
                    record.errors.append(error)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    config = session.config
    state = config.stash[_STATE]
    if not state.enabled or config.getoption("--no-easytest-report"):
        return
    # xdist workers require a merge protocol; never write competing partial reports.
    if hasattr(config, "workerinput") or getattr(config.option, "numprocesses", 0):
        state.write_error = "HTML report supports sequential pytest; rerun without -n."
        return
    if exitstatus == pytest.ExitCode.INTERRUPTED:
        if not any(
            error["phase"] == "collection"
            for case in state.report.cases for error in case.errors
        ):
            state.report.add_error(KeyboardInterrupt(), "pytest_session")
    elif exitstatus not in (pytest.ExitCode.OK, pytest.ExitCode.TESTS_FAILED):
        if not any(case.status == "failed" for case in state.report.cases):
            state.report.add_error(RuntimeError(), "pytest_session")
    try:
        state.written = write_html(
            state.report,
            _root(config) / (config.getoption("--easytest-report") or "artifacts/report.html"),
        )
    except Exception as error:
        state.write_error = f"HTML report could not be written: {type(error).__name__}"
        if exitstatus == pytest.ExitCode.OK:
            session.exitstatus = pytest.ExitCode.TESTS_FAILED


def pytest_terminal_summary(terminalreporter, config: pytest.Config) -> None:
    state = config.stash[_STATE]
    if state.written:
        terminalreporter.write_line(f"EasyTest report: {state.written}")
    if state.write_error:
        terminalreporter.write_line(state.write_error, red=True)
