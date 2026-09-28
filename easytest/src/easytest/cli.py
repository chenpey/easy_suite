from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

from easytest.cases.compiler import compile_path
from easytest.cases.editor import edit_workbook
from easytest.cases.loader import load_project_cases
from easytest.config import ProjectConfig
from easytest.models import ConfigurationError, ContractError
from easytest.reports.html import write_html
from easytest.reports.results import CaseReport, RunReport, error_info, safe_value, timestamp
from easytest.runtime.policy import load_execution_policy
from easytest.runtime.preflight import preflight
from easytest.runtime.runner import CaseRunner
from easytest.starter import init_project


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="easytest")
    subcommands = parser.add_subparsers(dest="command", required=True)
    init_command = subcommands.add_parser("init", help="Create a small offline test project")
    init_command.add_argument("directory")

    compile_command = subcommands.add_parser(
        "compile", help="Compile XLSX cases to JSON"
    )
    compile_command.add_argument("path", help="XLSX file or directory")
    compile_command.add_argument(
        "--check", action="store_true",
        help="Fail without writing when a same-name JSON is missing or out of date.",
    )
    edit_command = subcommands.add_parser(
        "edit",
        help="Apply validated structured operations to an XLSX source and recompile it",
    )
    edit_command.add_argument("path", help="XLSX case source")
    edit_command.add_argument("--validate", action="store_true", help="Preflight edited cases before replacing the source.")
    edit_command.add_argument("--root", default=".")
    edit_command.add_argument("--profile")
    edit_command.add_argument("--execution-policy")
    edit_source = edit_command.add_mutually_exclusive_group(required=True)
    edit_source.add_argument(
        "--patch",
        help="JSON file containing an operations list or {'operations': [...]}.",
    )
    edit_source.add_argument(
        "--operation",
        action="append",
        help="JSON edit operation; repeat to apply one atomic batch.",
    )

    run_command = subcommands.add_parser("run", help="Run XLSX, JSON or a case directory")
    run_command.add_argument("source", nargs="?", default="cases")
    run_command.add_argument("--root", default=".")
    run_command.add_argument("--profile")
    failure_options = run_command.add_mutually_exclusive_group()
    failure_options.add_argument("--fail-fast", action="store_true", help="Stop after the first failed case.")
    failure_options.add_argument("--max-failures", type=_positive_integer, help="Stop after this many failed cases.")
    report_options = run_command.add_mutually_exclusive_group()
    report_options.add_argument(
        "--report", default="artifacts/report.html",
        help="Offline HTML report path, relative to --root.",
    )
    report_options.add_argument("--no-report", action="store_true", help="Disable HTML output.")
    run_command.add_argument(
        "--result", help="Write the same JSON result as stdout, relative to --root.",
    )
    run_command.add_argument(
        "--allow-db-write", action=argparse.BooleanOptionalAction, default=None,
        help="Allow database writes independently of snapshot mode.",
    )
    run_command.add_argument(
        "--run-mode",
        choices=("read", "write", "baseline"),
        default=None,
    )
    validate_command = subcommands.add_parser(
        "validate", help="Read-only preflight; no compilation output, clients or handler imports",
    )
    validate_command.add_argument("source", nargs="?", default="cases")
    validate_command.add_argument("--root", default=".")
    validate_command.add_argument("--profile")
    validate_command.add_argument("--run-mode", choices=("read", "write", "baseline"))
    validate_command.add_argument("--allow-db-write", action=argparse.BooleanOptionalAction, default=None)
    for command in (run_command, validate_command):
        command.add_argument(
            "--execution-policy",
            help=(
                "Trusted policy JSON path, relative to --root. "
                "EASYTEST_EXECUTION_POLICY, when set, cannot be overridden."
            ),
        )
    list_command = subcommands.add_parser(
        "list", help="Read-only discovery of enabled cases and operation names; no credentials needed",
    )
    list_command.add_argument("source", nargs="?", default="cases")
    list_command.add_argument("--root", default=".")
    for command in (run_command, validate_command, list_command):
        command.add_argument(
            "--case-id", action="append",
            help="Select an exact enabled Case ID; repeat to select several, in source order.",
        )
    return parser


def _positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a positive integer") from None
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    if args.command == "init":
        print(init_project(args.directory))
        return
    if args.command == "compile":
        for output in compile_path(args.path, check=args.check):
            print(output)
        return
    # Handler prints and enabled event streams belong to stderr in the CLI.
    with redirect_stdout(sys.stderr):
        result, error, traceback = {
            "edit": _edit, "validate": _validate, "list": _list, "run": _run,
        }[args.command](args)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    if error is not None:
        # Even a nonzero SystemExit code (e.g. 256) can become zero at OS level.
        if isinstance(error, SystemExit):
            raise SystemExit(1) from error.with_traceback(traceback)
        raise error.with_traceback(traceback)


def _envelope(command, status, data, errors, artifacts=None):
    return {
        "schema_version": 1, "command": command, "status": status,
        "data": data, "errors": errors,
        "artifacts": artifacts or {"html": None, "result": None},
    }


def _edit(args):
    phase = "edit"
    try:
        if args.patch:
            source = Path(args.patch).resolve()
            try:
                document = json.loads(source.read_text(encoding="utf-8"))
            except FileNotFoundError as exc:
                raise ContractError(
                    f"edit patch does not exist: {source}",
                    code="INVALID_EDIT",
                    field="patch",
                ) from exc
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise ContractError(
                    f"edit patch is not valid JSON: {source}",
                    code="INVALID_EDIT",
                    field="patch",
                ) from exc
            if isinstance(document, dict) and set(document) != {"operations"}:
                raise ContractError(
                    "edit patch object must contain only 'operations'",
                    code="INVALID_EDIT",
                    field="patch",
                )
            operations = document.get("operations") if isinstance(document, dict) else document
        else:
            operations = []
            for index, value in enumerate(args.operation):
                try:
                    operations.append(json.loads(value))
                except json.JSONDecodeError as exc:
                    raise ContractError(
                        f"--operation {index + 1} is not valid JSON",
                        code="INVALID_EDIT",
                        field="operation",
                    ) from exc
        data = edit_workbook(
            Path(args.root) / args.path, operations,
            validate=args.validate, root=args.root, profile=args.profile,
            execution_policy=args.execution_policy,
        )
    except BaseException as error:
        status = "failed" if isinstance(error, Exception) else "interrupted"
        return _envelope("edit", status, None, [error_info(error, phase)]), error, error.__traceback__
    return _envelope("edit", "edited", data, []), None, None


def _validate(args):
    phase = "initialization"
    try:
        config = ProjectConfig(args.root)
        settings = config.resolve_run(
            run_mode=args.run_mode, profile=args.profile, allow_db_write=args.allow_db_write,
        )
        policy = load_execution_policy(args.root, args.execution_policy)
        phase = "collection"
        cases = load_project_cases(
            args.source, root=args.root, write_compiled=False, case_ids=args.case_id,
        )
        phase = "preflight"
        data = preflight(
            cases,
            config,
            settings,
            execution_policy=policy,
        ).as_dict()
    except BaseException as error:
        status = "failed" if isinstance(error, Exception) else "interrupted"
        return _envelope("validate", status, None, [error_info(error, phase)]), error, error.__traceback__
    return _envelope("validate", "valid", data, []), None, None


def _list(args):
    phase = "initialization"
    try:
        config = ProjectConfig(args.root)
        phase = "collection"
        cases = load_project_cases(
            args.source, root=args.root, write_compiled=False, case_ids=args.case_id,
        )
        data = {
            "case_count": len(cases), "step_count": sum(len(case.steps) for case in cases),
            "cases": [
                {
                    "id": case.id, "name": safe_value(case.name), "source": safe_value(case.source),
                    "tags": [safe_value(tag) for tag in case.tags],
                    "steps": [
                        {"id": step.id, "order": step.order, "executor": step.executor,
                         "operation": step.operation, "source_row": step.source_row}
                        for step in case.steps
                    ],
                }
                for case in cases
            ],
            "operations": [
                {"name": safe_value(name), "executor": operation["executor"]}
                for name, operation in sorted(config.operations.items())
            ],
        }
    except BaseException as error:
        status = "failed" if isinstance(error, Exception) else "interrupted"
        return _envelope("list", status, None, [error_info(error, phase)]), error, error.__traceback__
    return _envelope("list", "listed", data, []), None, None


def _write_result(path: Path, result: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=".result-", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _output_paths(args) -> tuple[Path | None, Path | None]:
    root = Path(args.root)
    html = None if args.no_report else (root / args.report).resolve()
    result = (root / args.result).resolve() if args.result else None
    if html is not None and result is not None and (
        html == result or (html.exists() and result.exists() and html.samefile(result))
    ):
        raise ConfigurationError("--report and --result must resolve to different files")
    return html, result


def _run(args):
    report = RunReport()
    artifacts = {"html": None, "result": None}
    runner = None
    error: BaseException | None = None
    traceback = None
    html_target = result_target = None
    phase = "output_paths"
    try:
        html_target, result_target = _output_paths(args)
        phase = "initialization"
        runner = CaseRunner(
            Path(args.root), run_mode=args.run_mode, profile=args.profile,
            allow_db_write=args.allow_db_write,
            execution_policy=args.execution_policy,
        )
        phase = "collection"
        cases = load_project_cases(args.source, root=args.root, case_ids=args.case_id)
        phase = "preflight"
        checked = runner.preflight(cases, reuse_for_run=True)
        report.input_hash = checked.input_hash
        phase = "execution"
        failures = 0
        max_failures = 1 if args.fail_fast else args.max_failures
        for index, case in enumerate(cases):
            before = len(runner.case_reports)
            try:
                runner.run(case)
            except BaseException as exc:
                failures += 1
                if len(runner.case_reports) == before:
                    record = CaseReport.for_case(
                        case,
                        input_hash=checked.input_hash,
                    )
                    record.fail(exc, "case_start")
                    runner.case_reports.append(record)
                if error is None or not isinstance(exc, Exception):
                    error, traceback = exc, exc.__traceback__
                if not isinstance(exc, Exception) or (
                    max_failures is not None and failures >= max_failures
                ):
                    runner.case_reports.extend(
                        CaseReport.for_case(
                            pending,
                            input_hash=checked.input_hash,
                        )
                        for pending in cases[index + 1:]
                    )
                    break
    except BaseException as exc:
        if not (phase == "preflight" and runner is not None and runner.case_reports):
            report.add_error(exc, phase, str(args.source))
        if error is None:
            error, traceback = exc, exc.__traceback__
    finally:
        if runner is not None:
            report.cases.extend(runner.case_reports)
            try:
                runner.close()
            except BaseException as exc:
                report.add_error(exc, "runner_cleanup")
                if error is None:
                    error, traceback = exc, exc.__traceback__
                else:
                    error.add_note(f"runner cleanup also failed: {type(exc).__name__}")
    report.finished_at = timestamp()
    if html_target is not None:
        try:
            target = write_html(report, html_target)
            artifacts["html"] = str(target)
            print(f"EasyTest report: {target}", file=sys.stderr)
        except BaseException as exc:
            report.add_error(exc, "html_report")
            if error is None:
                error, traceback = exc, exc.__traceback__
            else:
                error.add_note(f"HTML report could not be written: {type(exc).__name__}")

    def result():
        status = "passed" if error is None else (
            "failed" if isinstance(error, Exception) else "interrupted"
        )
        return _envelope(
            "run", status, report.as_dict(),
            [item for case in report.cases for item in case.errors], artifacts.copy(),
        )

    if result_target is not None:
        try:
            artifacts["result"] = str(result_target)
            _write_result(result_target, result())
        except BaseException as exc:
            artifacts["result"] = None
            report.add_error(exc, "json_result")
            if error is None:
                error, traceback = exc, exc.__traceback__
            else:
                error.add_note(f"JSON result could not be written: {type(exc).__name__}")
    return result(), error, traceback
