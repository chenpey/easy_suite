from __future__ import annotations

import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from easytest.config import ProjectConfig
from easytest.executors import (
    DatabaseExecutor,
    HttpExecutor,
    RpcExecutor,
    ScenarioExecutor,
    UiExecutor,
)
from easytest.executors.base import Executor
from easytest.executors.http import request_settings
from easytest.models import (
    Case, CleanupError, ConfigurationError, ContractError, ExecutionResult, MockMissError, RunContext,
)
from easytest.reports.results import CaseReport, error_info, safe_value
from easytest.runtime.assertions import assert_expectations
from easytest.runtime.mocks import MockEngine
from easytest.runtime.observability import EventRecorder, redact
from easytest.runtime.policy import ExecutionPolicy, load_execution_policy
from easytest.runtime.preflight import PreflightResult, preflight
from easytest.runtime.values import render_templates
from easytest.snapshots.manager import SnapshotManager


def _close_resources(resources: Iterable[Executor], closed: set[int]) -> None:
    errors: list[BaseException] = []
    for resource in resources:
        if id(resource) in closed:
            continue
        closed.add(id(resource))
        try:
            resource.close()
        except BaseException as exc:
            errors.append(exc)
    if errors:
        for error in errors:
            if not isinstance(error, Exception):
                raise error
        raise CleanupError(errors)


def _add_failure_note(error: BaseException, phase: str, failure: BaseException) -> None:
    # Exception messages may contain credentials; secondary failures report types only.
    kinds = (
        ", ".join(type(item).__name__ for item in failure.errors)
        if isinstance(failure, CleanupError)
        else type(failure).__name__
    )
    try:
        error.add_note(f"{phase} also failed: {kinds}")
    except Exception:
        pass


class CaseRunner:
    def __init__(
        self,
        root: str | Path,
        *,
        run_mode: str | None = None,
        profile: str | None = None,
        allow_db_write: bool | None = None,
        executors: dict[str, Executor] | None = None,
        rpc_handlers: dict[str, Any] | None = None,
        ui_handlers: dict[str, Any] | None = None,
        scenario_handlers: dict[str, Any] | None = None,
        execution_policy: str | Path | ExecutionPolicy | None = None,
    ) -> None:
        self.root = Path(root).resolve()
        self.config = ProjectConfig(self.root)
        self.settings = self.config.resolve_run(
            run_mode=run_mode, profile=profile, allow_db_write=allow_db_write
        )
        self.run_mode = self.settings["run_mode"]
        self.execution_policy = load_execution_policy(self.root, execution_policy)
        self._custom_executors = {
            name for name, executor in (executors or {}).items()
            if type(executor) not in {HttpExecutor, DatabaseExecutor, RpcExecutor, ScenarioExecutor, UiExecutor}
            or (type(executor) is DatabaseExecutor and executor.factories)
        }
        self._handlers = {
            "rpc": rpc_handlers or {}, "ui": ui_handlers or {}, "scenario": scenario_handlers or {},
        }
        for name, executor in (executors or {}).items():
            if name not in self._custom_executors and hasattr(executor, "handlers"):
                self._handlers[name] = executor.handlers
        self.mocks = MockEngine(self.config)
        self.snapshots = SnapshotManager(self.config)

        self.executors = dict(executors or {})
        factories = {
            "scenario": lambda: ScenarioExecutor(scenario_handlers),
            "rpc": lambda: RpcExecutor(rpc_handlers),
            "database": lambda: DatabaseExecutor(self.config),
            "ui": lambda: UiExecutor(ui_handlers),
        }
        self._closed = False
        self._closed_resources: set[int] = set()
        self._preflight_permits: dict[int, tuple[Case, str]] = {}
        try:
            for name, factory in factories.items():
                if name not in self.executors:
                    self.executors[name] = factory()
        except BaseException as error:
            try:
                self.close()
            except BaseException as failure:
                _add_failure_note(error, "initialization cleanup", failure)
            raise
        self.last_events: list[dict[str, Any]] = []
        self.last_report: CaseReport | None = None
        self.case_reports: list[CaseReport] = []

    def close(self) -> None:
        self._closed = True
        self._preflight_permits.clear()
        _close_resources(self.executors.values(), self._closed_resources)

    def __enter__(self) -> CaseRunner:
        return self

    def __exit__(self, _kind: Any, error: BaseException | None, _tb: Any) -> None:
        try:
            self.close()
        except BaseException as failure:
            if error is None:
                raise
            _add_failure_note(error, "runner cleanup", failure)

    def run(self, case: Case) -> dict[str, ExecutionResult]:
        if self._closed:
            raise ConfigurationError("runner is closed; create a new CaseRunner")
        permit = self._preflight_permits.pop(id(case), None)
        if permit is not None and permit[0] is case:
            input_hash = permit[1]
        else:
            checked = self.preflight([case])
            input_hash = checked.input_hash
        return self._execute(case, input_hash=input_hash)

    def _execute(
        self,
        case: Case,
        *,
        input_hash: str,
    ) -> dict[str, ExecutionResult]:
        case_started = time.perf_counter()
        observability = self.settings["runtime"]["observability"]
        recorder = EventRecorder(
            emit_stdout=bool(observability.get("emit_stdout", False)),
            max_event_length=max(
                1000,
                int(observability.get("max_event_length", 12000)),
            ),
        )
        context = RunContext(
            case=case,
            root=self.root,
            run_mode=self.run_mode,
            variables=dict(case.variables),
            events=recorder.events,
            allow_db_write=self.settings["allow_db_write"],
            environment=self.config.environment,
        )
        results: dict[str, ExecutionResult] = {}
        owned: dict[str, Executor] = {}
        error: BaseException | None = None
        traceback = None
        report = CaseReport.for_case(
            case, profile=self.settings["profile"],
            run_mode=self.run_mode, run_id=context.run_id,
            input_hash=input_hash,
        )
        self.last_report = report
        self.case_reports.append(report)
        phase = "begin_case"
        try:
            self.snapshots.begin_case(context)
            recorder.emit(
                "case.start",
                run_id=context.run_id,
                case_id=case.id,
                run_mode=context.run_mode,
                profile=self.settings["profile"],
            )
            mock_profile = case.mock_profile or self.settings["mock_profile"]
            self.config.mock_profile(mock_profile)
            for step, step_report in zip(case.steps, report.steps, strict=True):
                step_started = time.perf_counter()
                phase = step_report.phase = "prepare"
                try:
                    operation = self.config.operation(step.operation, step.executor)
                    scope = context.template_scope()
                    request = render_templates(step.request, scope)
                    step_report.request = safe_value(request)
                    mock_spec = render_templates(
                        self.mocks.resolve(
                            step_mock=step.mock,
                            profile_name=mock_profile,
                            operation_name=step.operation,
                        ),
                        scope,
                    )
                    recorder.emit(
                        "step.start",
                        run_id=context.run_id,
                        case_id=case.id,
                        step_id=step.id,
                        executor=step.executor,
                        operation=step.operation,
                        request=request,
                        mocked=mock_spec is not None,
                    )
                    started = time.perf_counter()
                    phase = step_report.phase = "execute"
                    decision = self.mocks.apply(
                        spec=mock_spec,
                        request=request,
                        context=context,
                        executor=step.executor,
                        operation=step.operation,
                        invocation_key=f"{case.id}.{step.operation}",
                    )
                    step_report.request = safe_value(decision.request)
                    result = decision.result
                    if result is None:
                        if self.settings["fail_on_mock_miss"]:
                            raise MockMissError(
                                f"strict profile blocked real execution: {step.operation}; "
                                "provide a response/state mock or select a live profile"
                            )
                        executor = self.executors.get(step.executor) or owned.get(
                            step.executor
                        )
                        if executor is None and step.executor == "http":
                            executor = owned["http"] = HttpExecutor()
                        if executor is None:
                            raise ConfigurationError(
                                f"executor is not registered: {step.executor}"
                            )
                        if (
                            self.execution_policy is not None
                            and step.executor == "http"
                            and step.executor not in self._custom_executors
                        ):
                            self.execution_policy.check_http(
                                request_settings(
                                    operation,
                                    decision.request,
                                    context.environment,
                                )
                            )
                        result = executor.execute(
                            step.operation,
                            operation,
                            decision.request,
                            context,
                        )

                    step_report.response = safe_value(result.output)
                    step_report.mocked = result.mocked
                    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
                    result.metadata.setdefault("elapsed_ms", elapsed_ms)
                    phase = step_report.phase = "assertion"
                    expectation = render_templates(step.expect, context.template_scope())
                    assert_expectations(result.output, expectation)
                    phase = step_report.phase = "snapshot"
                    self.snapshots.process(
                        spec=render_templates(step.snapshot, context.template_scope()),
                        result=result,
                        context=context,
                        step_id=step.id,
                    )
                    key = step.save_as or step.id
                    context.step_outputs[key] = result.output
                    results[step.id] = result
                    recorder.emit(
                        "step.done",
                        run_id=context.run_id,
                        case_id=case.id,
                        step_id=step.id,
                        executor=step.executor,
                        operation=step.operation,
                        response=result.output,
                        mocked=result.mocked,
                        elapsed_ms=elapsed_ms,
                    )
                    step_report.status = "passed"
                    step_report.phase = "done"
                except BaseException as exc:
                    exc.easytest_location = {
                        "case_id": case.id, "step_id": step.id, "operation": step.operation,
                        "source": case.source, "source_row": step.source_row,
                    }
                    step_report.fail(exc)
                    location = f"Case={case.id}, Step={step.id}, Operation={step.operation}"
                    if case.source:
                        location += f", Source={case.source}"
                    if step.source_row is not None:
                        location += f", sheet=steps, row={step.source_row}"
                    try:
                        exc.add_note(str(redact(location)))
                        recorder.emit(
                            "step.error",
                            run_id=context.run_id,
                            case_id=case.id,
                            step_id=step.id,
                            executor=step.executor,
                            operation=step.operation,
                            error_type=type(exc).__name__,
                            error=error_info(exc, phase),
                        )
                    except BaseException as failure:
                        _add_failure_note(exc, "error reporting", failure)
                    raise
                finally:
                    step_report.duration_ms = round(
                        (time.perf_counter() - step_started) * 1000, 3
                    )
        except BaseException as exc:
            error, traceback = exc, exc.__traceback__
            report.fail(exc, phase)
        try:
            _close_resources(owned.values(), set())
        except BaseException as failure:
            report.fail(failure, "case_cleanup")
            if error is None:
                error, traceback = failure, failure.__traceback__
            else:
                _add_failure_note(error, "case cleanup", failure)
        try:
            self.snapshots.finish_case(context, success=error is None)
        except BaseException as failure:
            report.fail(failure, "snapshot_finish")
            if error is None:
                error, traceback = failure, failure.__traceback__
            else:
                _add_failure_note(error, "snapshot finish", failure)

        report.duration_ms = round((time.perf_counter() - case_started) * 1000, 3)
        if error is not None:
            report.status = "failed" if isinstance(error, Exception) else "interrupted"
            try:
                recorder.emit(
                    "case.error",
                    run_id=context.run_id,
                    case_id=case.id,
                )
            except BaseException as failure:
                _add_failure_note(error, "error reporting", failure)
            self.last_events = list(recorder.events)
            raise error.with_traceback(traceback)

        recorder.emit(
            "case.done",
            run_id=context.run_id,
            case_id=case.id,
            step_count=len(results),
        )
        self.last_events = list(recorder.events)
        report.status = "passed"
        return results

    def preflight(
        self,
        cases: Iterable[Case],
        *,
        reuse_for_run: bool = False,
    ) -> PreflightResult:
        """Check the entire selection before calling run for any of its cases."""
        selected = list(cases)
        self._preflight_permits.clear()
        try:
            checked = preflight(
                selected, self.config, self.settings,
                custom_executors=self._custom_executors, handlers=self._handlers,
                execution_policy=self.execution_policy,
            )
            if reuse_for_run:
                self._preflight_permits = {
                    id(case): (case, checked.input_hash)
                    for case in selected
                }
            return checked
        except (ConfigurationError, ContractError) as error:
            self.last_events = []
            for case in selected:
                report = CaseReport.for_case(
                    case, profile=self.settings["profile"], run_mode=self.run_mode,
                )
                if case.id == getattr(error, "preflight_case_id", None):
                    report.fail(error, "preflight")
                    for step in report.steps:
                        if step.id == getattr(error, "preflight_step_id", None):
                            step.phase = "preflight"
                            step.fail(error)
                    self.last_report = report
                self.case_reports.append(report)
            raise
