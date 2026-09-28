from __future__ import annotations

import html
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from easytest.cases.compiler import compile_workbook
from easytest.cases.loader import load_project_cases
from easytest.models import Case, ConfigurationError, ExecutionResult, Step
from easytest.notebook.display import display_table
from easytest.reports.html import write_html
from easytest.reports.results import RunReport
from easytest.runtime.runner import CaseRunner
from easytest.runtime.preflight import PreflightResult


@dataclass(frozen=True)
class NotebookResult:
    step_id: str
    executor: str
    operation: str
    output: Any
    artifacts: dict[str, Path]
    mocked: bool

    @classmethod
    def from_execution(
        cls,
        step_id: str,
        result: ExecutionResult,
    ) -> NotebookResult:
        return cls(
            step_id=step_id,
            executor=result.executor,
            operation=result.operation,
            output=result.output,
            artifacts=result.artifacts,
            mocked=result.mocked,
        )

    def image(self, artifact: str = "screenshot"):
        """Return an IPython image object for a screenshot artifact."""
        try:
            from IPython.display import Image
        except ImportError as exc:
            raise ConfigurationError(
                "Notebook image display requires: uv sync --extra notebook"
            ) from exc
        try:
            path = self.artifacts[artifact]
        except KeyError as exc:
            raise ConfigurationError(
                f"result does not contain artifact {artifact!r}"
            ) from exc
        return Image(filename=str(path))

    def table(self, path: str = "$.rows", *, max_rows: int = 100):
        """Display list/dict output as a safe HTML table."""
        from easytest.runtime.values import resolve_path

        return display_table(resolve_path(self.output, path), max_rows=max_rows)

    def _repr_html_(self) -> str:
        payload = html.escape(
            json.dumps(self.output, ensure_ascii=False, indent=2, default=str)
        )
        mode = "mock" if self.mocked else "real"
        return (
            "<div><strong>"
            f"{html.escape(self.step_id)} · {html.escape(self.executor)} · "
            f"{html.escape(self.operation)} · {mode}"
            "</strong><pre>"
            f"{payload}"
            "</pre></div>"
        )


class NotebookSession:
    """Small interactive facade for manual tests in Jupyter notebooks."""

    def __init__(
        self,
        root: str | Path = ".",
        *,
        run_mode: str | None = None,
        profile: str | None = None,
        allow_db_write: bool | None = None,
        executors=None,
        rpc_handlers=None,
        ui_handlers=None,
        scenario_handlers=None,
        execution_policy: str | Path | None = None,
    ) -> None:
        self.root = Path(root).resolve()
        self.runner = CaseRunner(
            self.root,
            run_mode=run_mode,
            profile=profile,
            allow_db_write=allow_db_write,
            executors=executors,
            rpc_handlers=rpc_handlers,
            ui_handlers=ui_handlers,
            scenario_handlers=scenario_handlers,
            execution_policy=execution_policy,
        )

    def close(self) -> None:
        self.runner.close()

    def write_report(self, path: str | Path = "artifacts/report.html") -> Path:
        """Export all Case/Step runs in this session, including failed attempts."""
        return write_html(RunReport(cases=list(self.runner.case_reports)), self._path(path))

    def __enter__(self) -> NotebookSession:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.runner.__exit__(*_args)

    def compile(self, workbook: str | Path) -> Path:
        source = self._path(workbook)
        return compile_workbook(source)

    def cases(self, source: str | Path = "cases") -> list[dict[str, Any]]:
        values = []
        for case in self._load(source):
            value = {
                "id": case.id,
                "name": case.name,
                "type": case.case_type,
                "tags": list(case.tags),
                "steps": len(case.steps),
            }
            if case.data_id is not None:
                value.update(
                    execution_id=case.execution_id,
                    data_set=case.data_set,
                    data_id=case.data_id,
                )
            values.append(value)
        return values

    def operations(self, executor: str | None = None) -> list[dict[str, str]]:
        values = [
            {"operation": name, "executor": str(config["executor"])}
            for name, config in sorted(self.runner.config.operations.items())
            if executor is None or config["executor"] == executor
        ]
        return values

    def validate(self, source: str | Path = "cases") -> PreflightResult:
        """Check sources in memory without compiling or executing cases."""
        return self.runner.preflight(
            load_project_cases(source, root=self.root, write_compiled=False)
        )

    def run_case(
        self,
        source: str | Path = "cases",
        case_id: str | None = None,
    ) -> dict[str, NotebookResult]:
        cases = self._load(source)
        selected = self._select_case(cases, case_id)
        results = self.runner.run(selected)
        return {
            step_id: NotebookResult.from_execution(step_id, result)
            for step_id, result in results.items()
        }

    def run_step(
        self,
        *,
        executor: str,
        operation: str,
        request: dict[str, Any] | None = None,
        mock: Any = None,
        snapshot: Any = None,
        expect: Any = None,
        variables: dict[str, Any] | None = None,
        mock_profile: str | None = None,
        step_id: str = "manual",
        case_id: str | None = None,
    ) -> NotebookResult:
        """Run an independent Case; use explicit IDs for distinct data scenarios."""
        case_type = executor if executor in {"http", "rpc"} else "scenario"
        step = Step(
            id=step_id,
            order=1,
            executor=executor,
            operation=operation,
            request=request or {},
            mock=mock,
            snapshot=snapshot,
            expect=expect,
        )
        case = Case(
            id=case_id if case_id is not None else f"notebook.{executor}.{operation}",
            name="Notebook manual test",
            case_type=case_type,
            enabled=True,
            tags=("manual",),
            variables=variables or {},
            mock_profile=mock_profile,
            snapshot_profile="default",
            steps=(step,),
            source="notebook",
        )
        result = self.runner.run(case)[step_id]
        return NotebookResult.from_execution(step_id, result)

    def _path(self, value: str | Path) -> Path:
        path = Path(value)
        return path if path.is_absolute() else self.root / path

    def _load(self, source: str | Path) -> list[Case]:
        return load_project_cases(source, root=self.root)

    @staticmethod
    def _select_case(cases: list[Case], case_id: str | None) -> Case:
        if case_id is None:
            if len(cases) != 1:
                ids = ", ".join(case.id for case in cases)
                raise ConfigurationError(
                    f"case_id is required because source contains: {ids}"
                )
            return cases[0]
        exact = [case for case in cases if case.execution_id == case_id]
        if len(exact) == 1:
            return exact[0]
        matching = [case for case in cases if case.id == case_id]
        if len(matching) == 1:
            return matching[0]
        if matching:
            ids = ", ".join(case.execution_id for case in matching)
            raise ConfigurationError(
                f"case_id {case_id!r} has multiple data rows; use one of: {ids}"
            )
        raise ConfigurationError(f"case not found: {case_id}")
