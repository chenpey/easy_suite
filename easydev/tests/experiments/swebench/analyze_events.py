#!/usr/bin/env python3
"""Attribute Codex run artifacts without starting an agent.

The analyzer reads the event and result files produced by ``run.py``. It keeps
declared routing separate from observed behavior and never treats a subagent
report as proof that the task itself passed.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import shlex
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from protocol import (
    RESULT_PROTOCOL,
    is_valid_event,
    is_valid_stored_result,
    load_task_contracts,
)


MODULE_RE = re.compile(
    r"(?P<path>(?:[^\s\"'`]+/)?(?:SKILL\.md|references/(?:[A-Za-z0-9_.*-]+/)*[A-Za-z0-9_.*-]+\.md))"
)
FILE_PATH_RE = re.compile(
    r"(?<![\w./-])(?P<path>(?:\./)?(?:[A-Za-z0-9_.-]+/)*"
    r"[A-Za-z0-9_.*-]+\.(?:py|js|jsx|ts|tsx|go|rs|java|rb|php|sh|md|json|toml|yaml|yml|patch|diff))"
    r"(?=$|[\s\"'`;&|),])"
)
DECLARED_PATH_RE = re.compile(
    r"(?:采用|使用|走|进入|路径\s*[：:]?\s*)"
    r"\s*(?:easydev\s*)?[`*]*\s*(full-local|full-staged|full|quick)\b",
    re.IGNORECASE,
)
DECLARED_PATH_RE_2 = re.compile(
    r"\b(full-local|full-staged|full|quick)\s*(?:路径|流程)", re.IGNORECASE
)
UPGRADE_RE = re.compile(
    r"(?:升级|转入|转为)\s*(?:为|到)?\s*[`*]*\s*(full)(?![-A-Za-z0-9_])\b",
    re.IGNORECASE,
)
FINDING_RE = re.compile(
    r"(?:\*\*)?\[(P[0-3])\](?:\*\*)?\s*"
    r"([^\n*]+)",
)
FINDING_BULLET_RE = re.compile(
    r"\*\*(P[0-3])[:：]\s*([^*\n]+)\*\*",
)
REVIEW_PROMPT_MARKERS = (
    "references/review.md",
    "独立只读审查",
    "独立只读",
    "独立审查",
    "independent read-only",
    "independent read-only reviewer",
    "independent review",
)
ZERO_FINDING_MARKERS = (
    "未发现确定缺陷",
    "未发现任何确定缺陷",
    "未发现确定的 p0",
    "未发现确定缺陷，p0-p3 均无",
    "p0-p3 均无",
    "p0–p3 均无",
    "p0/p1/p2/p3 均无",
    "p0/p1/p2/p3均无",
    "p0、p1、p2、p3 均无",
    "无确定发现",
    "无确定缺陷",
    "zero confirmed findings",
    "no confirmed findings",
    "no confirmed defects",
)
PENDING_RISK_MARKERS = (
    "待验证风险",
    "剩余风险",
    "残余风险",
    "未覆盖",
    "未验证",
    "remaining risk",
    "residual risk",
    "not verified",
)
PENDING_RISK_NEGATIONS = (
    "无待验证风险",
    "无高影响待验证风险",
    "无其他有具体线索的高影响待验证风险",
    "无其他",
    "没有待验证",
    "无未覆盖",
    "无剩余风险",
    "无残余风险",
    "none",
    "not applicable",
    "no remaining risk",
    "no residual risk",
)
CLOSING_NEGATIONS = (
    "未关闭",
    "尚未关闭",
    "仍未关闭",
    "无法确认",
    "未确认",
    "未完成",
    "not closed",
    "unresolved",
    "not verified",
)
HISTORICAL_MARKERS = ("历史", "historical", "旧版", "旧版本")
DECLARATION_NEGATIONS = (
    "不走",
    "不使用",
    "不采用",
    "不进入",
    "不是",
    "未采用",
    "而不是",
    "排除",
    "不要",
    "没有",
    "不会",
)
BENCHMARK_ACCESS_PATTERNS = (
    ("solution.patch", re.compile(r"solution\.patch(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("acceptance.py", re.compile(r"acceptance\.py(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    (
        "tests/cases/public-contract-callers",
        re.compile(r"tests/cases/public-contract-callers(?:/|$)", re.IGNORECASE),
    ),
    ("reviewer-report.md", re.compile(r"reviewer-report\.md(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("dataset.json", re.compile(r"dataset\.json(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("manifest.json", re.compile(r"manifest\.json(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("results.jsonl", re.compile(r"results\.jsonl(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("summary.json", re.compile(r"summary\.json(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("result.json", re.compile(r"result\.json(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("report.md", re.compile(r"report\.md(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("agent.patch", re.compile(r"agent\.patch(?:$|[\s\"'`;&|),])", re.IGNORECASE)),
    ("task-baselines", re.compile(r"task-baselines(?:/|$)", re.IGNORECASE)),
    ("gold/", re.compile(r"(?:^|[/\s\"'`:])gold(?:/|$)", re.IGNORECASE)),
    ("runs/", re.compile(r"(?:^|[/\s\"'`])runs(?:/|$)", re.IGNORECASE)),
    ("junit.xml", re.compile(r"(?:junit|pytest)[^/\s\"'`;&|]*\.xml\b", re.IGNORECASE)),
    (".pytest_cache/", re.compile(r"(?:^|[/\s\"'`])\.pytest_cache(?:/|$)", re.IGNORECASE)),
)
CONTENT_COMMANDS = {
    ".",
    "awk",
    "base64",
    "cat",
    "cmp",
    "diff",
    "grep",
    "head",
    "jq",
    "less",
    "more",
    "nl",
    "od",
    "perl",
    "rg",
    "sed",
    "source",
    "tail",
    "xxd",
    "yq",
}
SEARCH_COMMANDS = {"grep", "rg"}
SCRIPT_PROGRAM_COMMANDS = {"awk", "perl", "sed"}
SHELL_COMMANDS = {"bash", "sh", "zsh"}
GIT_SUMMARY_OPTIONS = {
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--check",
    "--quiet",
}
GIT_CONTENT_OPTIONS = {
    "--binary",
    "--cc",
    "--combined-all-paths",
    "--full-index",
    "--patch",
    "--patch-with-raw",
    "--patch-with-stat",
    "--raw",
    "--word-diff",
    "--word-diff-regex",
    "-p",
}
METADATA_OPERATIONS = CONTENT_COMMANDS | {
    "cp",
    "exec",
    "install",
    "mv",
    "node",
    "open",
    "php",
    "python",
    "python3",
    "ruby",
    "source",
    "tar",
    "unzip",
}


@dataclass
class Finding:
    severity: str
    title: str


@dataclass
class RunAttribution:
    run_id: str
    task_id: str
    arm: str
    repeat: int
    result_present: bool = False
    result_protocol: Optional[int] = None
    result_valid: bool = False
    result_validation_error: Optional[str] = None
    resolved: Optional[bool] = None
    historical_resolved: Optional[bool] = None
    wall_seconds: Optional[float] = None
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reported_tool_calls: Optional[int] = None
    observed_tool_calls: int = 0
    event_count: int = 0
    malformed_event_lines: int = 0
    declared_initial_path: Optional[str] = None
    declared_final_path: Optional[str] = None
    upgraded_to_full: bool = False
    reviewer_instances: int = 0
    reviewer_completed_instances: int = 0
    reviewer_reports: int = 0
    reviewer_zero_findings: Optional[bool] = None
    reviewer_pending_risks: bool = False
    findings: List[Finding] = field(default_factory=list)
    module_access: Counter = field(default_factory=Counter)
    file_access: Counter = field(default_factory=Counter)
    benchmark_metadata_access: Counter = field(default_factory=Counter)
    closing_mentions: List[str] = field(default_factory=list)
    agent_messages: int = 0

    @property
    def cache_rate(self) -> Optional[float]:
        if not self.input_tokens:
            return None
        return self.cached_input_tokens / self.input_tokens

    @property
    def declared_quick_with_reviewer(self) -> bool:
        return self.declared_initial_path == "quick" and self.reviewer_instances > 0

    @property
    def event_stream_valid(self) -> bool:
        return self.event_count > 0 and self.malformed_event_lines == 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "task_id": self.task_id,
            "arm": self.arm,
            "repeat": self.repeat,
            "result_present": self.result_present,
            "result_protocol": self.result_protocol,
            "result_valid": self.result_valid,
            "result_validation_error": self.result_validation_error,
            "resolved": self.resolved,
            "historical_resolved": self.historical_resolved,
            "wall_seconds": self.wall_seconds,
            "input_tokens": self.input_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "output_tokens": self.output_tokens,
            "cache_rate": self.cache_rate,
            "reported_tool_calls": self.reported_tool_calls,
            "observed_tool_calls": self.observed_tool_calls,
            "event_count": self.event_count,
            "malformed_event_lines": self.malformed_event_lines,
            "event_stream_valid": self.event_stream_valid,
            "declared_initial_path": self.declared_initial_path,
            "declared_final_path": self.declared_final_path,
            "upgraded_to_full": self.upgraded_to_full,
            "declared_quick_with_reviewer": self.declared_quick_with_reviewer,
            "reviewer_instances": self.reviewer_instances,
            "reviewer_completed_instances": self.reviewer_completed_instances,
            "reviewer_reports": self.reviewer_reports,
            "reviewer_zero_findings": self.reviewer_zero_findings,
            "reviewer_pending_risks": self.reviewer_pending_risks,
            "findings": [
                {"severity": finding.severity, "title": finding.title}
                for finding in self.findings
            ],
            "module_access": dict(sorted(self.module_access.items())),
            "file_access": dict(sorted(self.file_access.items())),
            "benchmark_metadata_access": dict(
                sorted(self.benchmark_metadata_access.items())
            ),
            "closing_mentions": self.closing_mentions,
            "agent_messages": self.agent_messages,
        }


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _number(value: Any, kind: type) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return kind(value)


def _shell_segments(command: str) -> List[List[str]]:
    try:
        lexer = shlex.shlex(
            command,
            posix=True,
            punctuation_chars=";&|\n<>()",
        )
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        tokens = re.findall(r"[^\s]+", command)
    separators = {"&&", "||", ";", "|", "&", "\n", "(", ")"}
    segments: List[List[str]] = []
    current: List[str] = []
    for token in tokens:
        if token in separators:
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)
    return segments


def _command_name(token: str) -> str:
    return token.rsplit("/", 1)[-1]


def _strip_command_prefix(tokens: List[str]) -> List[str]:
    result = list(tokens)
    while result:
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", result[0]):
            result.pop(0)
            continue
        command = _command_name(result[0])
        if command == "command":
            result.pop(0)
        if result and result[0] == "--":
            result.pop(0)
            continue
        if command == "env":
            result.pop(0)
            while result and (
                result[0].startswith("-")
                or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", result[0])
            ):
                result.pop(0)
            continue
        if command in {"nice", "time", "nohup"}:
            result.pop(0)
            while result and result[0].startswith("-"):
                option = result.pop(0)
                if command == "nice" and option in {"-n", "--adjustment"} and result:
                    result.pop(0)
            continue
        if command == "timeout":
            result.pop(0)
            while result and result[0].startswith("-"):
                option = result.pop(0)
                if option in {"-k", "--kill-after", "-s", "--signal"} and result:
                    result.pop(0)
            if result:
                result.pop(0)
            continue
        if command == "sudo":
            result.pop(0)
            while result and result[0].startswith("-"):
                option = result.pop(0)
                if option in {"-u", "-g", "-h", "-p", "-r", "-t", "-U"} and result:
                    result.pop(0)
            continue
        break
    return result


def _git_summary_only(args: List[str]) -> bool:
    if any(
        token in GIT_CONTENT_OPTIONS
        or token.startswith(("--patch=", "--word-diff=", "-U", "--unified="))
        for token in args
    ):
        return False
    return any(
        token in GIT_SUMMARY_OPTIONS or token.startswith("--stat=")
        for token in args
    )


def _git_subcommand(tokens: List[str]) -> Tuple[Optional[str], List[str]]:
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in {"-C", "-c", "--git-dir", "--work-tree"}:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        return token, tokens[index + 1:]
    return None, []


def _positionals(args: List[str]) -> List[str]:
    result: List[str] = []
    stop_options = False
    for token in args:
        if token == "--":
            stop_options = True
            continue
        if not stop_options and token.startswith("-"):
            continue
        result.append(token)
    return result


def _search_paths(args: List[str]) -> List[str]:
    paths: List[str] = []
    pattern_seen = False
    index = 0
    stop_options = False
    while index < len(args):
        token = args[index]
        if token == "--":
            stop_options = True
            index += 1
            continue
        if not stop_options and (
            token.startswith("--regexp=")
            or (token.startswith("-e") and len(token) > 2)
        ):
            pattern_seen = True
            index += 1
            continue
        if not stop_options and token in {"-e", "--regexp"}:
            pattern_seen = True
            index += 2
            continue
        if not stop_options and token.startswith("-"):
            index += 1
            continue
        if not pattern_seen:
            pattern_seen = True
            index += 1
            continue
        paths.append(token)
        index += 1
    return paths


def _shell_payload(args: List[str]) -> Optional[str]:
    for index, token in enumerate(args):
        if token in {"-c", "-lc", "-cl"} or re.fullmatch(
            r"-[A-Za-z]*c[A-Za-z]*",
            token,
        ):
            if index + 1 < len(args):
                return args[index + 1]
    return None


def _script_paths(args: List[str]) -> List[str]:
    paths: List[str] = []
    program_seen = False
    index = 0
    stop_options = False
    while index < len(args):
        token = args[index]
        if token == "--":
            stop_options = True
            index += 1
            continue
        if not stop_options and token in {"-e", "--expression"}:
            program_seen = True
            index += 2
            continue
        if not stop_options and token.startswith("-"):
            if "e" in token.lstrip("-") and token.startswith("-"):
                program_seen = True
            index += 1
            continue
        if not program_seen:
            program_seen = True
            index += 1
            continue
        paths.append(token)
        index += 1
    return paths


def _normalize_file_path(path: str, cwd: str = ".") -> str:
    trailing_slash = path.endswith("/")
    normalized = posixpath.normpath(posixpath.join(cwd, path))
    if normalized == ".":
        return "./" if trailing_slash or path in {".", "./"} else normalized
    return normalized + ("/" if trailing_slash else "")


def _change_directory(cwd: str, tokens: List[str]) -> str:
    args = _positionals(tokens[1:])
    if not args or args[0] == "-":
        return cwd
    return _normalize_file_path(args[0], cwd).rstrip("/") or "."


def _module_from_token(token: str) -> Optional[str]:
    candidates = [token]
    if ":" in token:
        candidates.append(token.rsplit(":", 1)[-1])
    for candidate in candidates:
        marker = candidate.rfind("references/")
        if marker >= 0:
            tail = candidate[marker:]
            if tail in {"references/", "references"}:
                return "references/"
            if tail.endswith(".md"):
                return tail
        if candidate.endswith("SKILL.md"):
            return "SKILL.md"
    return None


def _paths_from_tokens(
    tokens: List[str],
    *,
    allow_directories: bool = False,
    cwd: str = ".",
) -> Set[str]:
    paths: Set[str] = set()
    for token in tokens:
        if (
            not token
            or token.startswith("-")
            or token in {"<", ">", ">>", "2>", "2>&1"}
            or token.isdigit()
        ):
            continue
        matches = list(FILE_PATH_RE.finditer(token))
        if matches:
            paths.update(
                _normalize_file_path(match.group("path"), cwd)
                for match in matches
            )
            continue
        if allow_directories:
            candidate = token.rstrip("/")
            if candidate == ".":
                paths.add(_normalize_file_path("./", cwd))
            elif (
                candidate
                and candidate != ".."
                and (
                    "/" in candidate
                    or candidate in {"src", "app", "lib", "tests"}
                )
            ):
                paths.add(_normalize_file_path(candidate + "/", cwd))
    return paths


def _read_targets(tokens: List[str], cwd: str = ".") -> Tuple[Set[str], bool]:
    tokens = _strip_command_prefix(tokens)
    if not tokens:
        return set(), False
    command = _command_name(tokens[0])
    args = tokens[1:]
    allow_directories = False

    if command == "git":
        subcommand, args = _git_subcommand(tokens)
        if subcommand in {"diff", "show"} and _git_summary_only(args):
            return set(), True
        if subcommand in {"diff", "show", "cat-file"}:
            return _paths_from_tokens(
                args,
                allow_directories=True,
                cwd=cwd,
            ), True
        if subcommand == "grep":
            return _paths_from_tokens(
                _search_paths(args),
                allow_directories=True,
                cwd=cwd,
            ), True
        return set(), subcommand in {"diff", "show", "cat-file", "grep"}

    if command in {"python", "python3"}:
        if "-c" in args:
            index = args.index("-c")
            if index + 1 >= len(args):
                return set(), True
            return _paths_from_tokens(
                [args[index + 1]],
                allow_directories=True,
                cwd=cwd,
            ), True
        if "-m" in args:
            return set(), True
        script_args = _positionals(args)
        return _paths_from_tokens(
            script_args,
            allow_directories=True,
            cwd=cwd,
        ), True

    if command not in CONTENT_COMMANDS:
        return set(), False
    if command == "sed" and any(
        token == "-i" or token.startswith("-i") for token in args
    ):
        return set(), True
    if command in SEARCH_COMMANDS:
        paths = _search_paths(args)
        allow_directories = True
    elif command in SCRIPT_PROGRAM_COMMANDS:
        paths = _script_paths(args)
    else:
        paths = _positionals(args)
    return _paths_from_tokens(
        paths,
        allow_directories=allow_directories,
        cwd=cwd,
    ), True


def _read_access(
    command: str,
    depth: int = 0,
    cwd: str = ".",
) -> Tuple[Set[str], Set[str]]:
    files: Set[str] = set()
    modules: Set[str] = set()
    if depth > 8:
        return files, modules
    current_cwd = cwd
    directory_stack: List[str] = []
    for segment in _shell_segments(command):
        stripped = _strip_command_prefix(segment)
        command_name = _command_name(stripped[0]) if stripped else ""
        if command_name in {"cd", "pushd", "popd"}:
            if command_name == "popd":
                if directory_stack:
                    current_cwd = directory_stack.pop()
            else:
                if command_name == "pushd":
                    directory_stack.append(current_cwd)
                current_cwd = _change_directory(current_cwd, stripped)
            continue
        if stripped and _command_name(stripped[0]) in SHELL_COMMANDS:
            payload = _shell_payload(stripped[1:])
            if payload:
                inner_files, inner_modules = _read_access(
                    payload,
                    depth + 1,
                    current_cwd,
                )
                files.update(inner_files)
                modules.update(inner_modules)
            continue
        paths, did_read = _read_targets(segment, current_cwd)
        if not did_read:
            continue
        for path in paths:
            module = _module_from_token(path)
            if module:
                modules.add(module)
        files.update(paths)
    return files, modules


def extract_modules(command: str) -> Set[str]:
    return _read_access(command)[1]


def extract_files(command: str) -> Set[str]:
    return _read_access(command)[0]


def _metadata_markers(text: str) -> Set[str]:
    lowered = text.lower()
    return {
        marker
        for marker, pattern in BENCHMARK_ACCESS_PATTERNS
        if pattern.search(lowered)
    }


def extract_metadata_access(
    command: str,
    depth: int = 0,
    cwd: str = ".",
) -> Set[str]:
    markers: Set[str] = set()
    if depth > 8:
        return markers
    current_cwd = cwd
    directory_stack: List[str] = []
    for segment in _shell_segments(command):
        if not segment:
            continue
        tokens = _strip_command_prefix(segment)
        if not tokens:
            continue
        command_name = _command_name(tokens[0])
        if command_name in {"cd", "pushd", "popd"}:
            if command_name == "popd":
                if directory_stack:
                    current_cwd = directory_stack.pop()
            else:
                if command_name == "pushd":
                    directory_stack.append(current_cwd)
                current_cwd = _change_directory(current_cwd, tokens)
            continue
        present = _metadata_markers(current_cwd) | _metadata_markers(
            " ".join(tokens)
        )
        if not present:
            continue
        if command_name in SHELL_COMMANDS:
            payload = _shell_payload(tokens[1:])
            if payload:
                markers.update(
                    extract_metadata_access(
                        payload,
                        depth + 1,
                        current_cwd,
                    )
                )
            continue
        accesses = command_name in METADATA_OPERATIONS
        if command_name == "git":
            subcommand, args = _git_subcommand(tokens)
            accesses = subcommand in {
                "apply",
                "cat-file",
                "checkout",
                "diff",
                "grep",
                "restore",
                "show",
            }
            if subcommand in {"diff", "show"} and _git_summary_only(args):
                accesses = False
        elif command_name == "find":
            accesses = any(
                _command_name(token) in METADATA_OPERATIONS for token in tokens[1:]
            )
        elif "/" in tokens[0]:
            accesses = True
        if accesses:
            markers.update(present)
    return markers


def first_declared_path(texts: Sequence[str] | str) -> Optional[str]:
    if isinstance(texts, str):
        texts = [texts]
    for text in texts:
        candidates: List[Tuple[int, str]] = []
        for pattern in (DECLARED_PATH_RE, DECLARED_PATH_RE_2):
            for match in pattern.finditer(text):
                # Include the matched routing verb so phrases such as
                # "不走 quick" can be rejected before considering a later path.
                context = text[max(0, match.start() - 5):match.end()]
                if any(negation in context for negation in DECLARATION_NEGATIONS):
                    continue
                candidates.append((match.start(), match.group(1).lower()))
        if candidates:
            return min(candidates, key=lambda item: item[0])[1]
    return None


def has_positive_upgrade(text: str) -> bool:
    negations = DECLARATION_NEGATIONS + (
        "未升级",
        "未转入",
        "无需",
        "无需升级",
        "不升级",
        "不转入",
        "禁止升级",
        "禁止转入",
        "不应升级",
        "不得升级",
        "不要升级",
        "不需要",
        "尚未",
        "不转",
    )
    for match in UPGRADE_RE.finditer(text):
        context = text[max(0, match.start() - 12):match.end()]
        if any(negation in context for negation in negations):
            continue
        return True
    return False


def _line_at(text: str, offset: int) -> str:
    line_start = text.rfind("\n", 0, offset) + 1
    line_end = text.find("\n", offset)
    if line_end < 0:
        line_end = len(text)
    return text[line_start:line_end]


def extract_findings(text: str) -> List[Finding]:
    findings: List[Finding] = []
    seen: Set[Tuple[str, str]] = set()
    matches = []
    for pattern in (FINDING_RE, FINDING_BULLET_RE):
        matches.extend(pattern.finditer(text))
    for match in sorted(matches, key=lambda item: item.start()):
        if any(marker in _line_at(text, match.start()).lower() for marker in HISTORICAL_MARKERS):
            continue
        severity = match.group(1)
        raw_title = match.group(2)
        title = raw_title.strip(" :：-")
        title = re.sub(r"\s+", " ", title).strip()
        if not title:
            title = "(untitled finding)"
        if title.lower().startswith(("已关闭", "历史", "historical", "closed")):
            continue
        key = (severity.upper(), title)
        if key not in seen:
            seen.add(key)
            findings.append(Finding(*key))
    return findings


def has_zero_finding_statement(text: str) -> bool:
    for line in text.splitlines():
        lowered = line.lower()
        if any(marker in lowered for marker in HISTORICAL_MARKERS):
            continue
        if any(negation in lowered for negation in ("并非", "不是", "not ")):
            continue
        if any(marker in lowered for marker in ZERO_FINDING_MARKERS):
            return True
    return False


def _line_has_negated_risk(line: str) -> bool:
    lowered = line.lower()
    if any(negation in lowered for negation in PENDING_RISK_NEGATIONS):
        return True
    if re.search(
        r"(?:未发现|不存在)\s*(?:待验证风险|剩余风险|残余风险|未覆盖|未验证)",
        lowered,
    ):
        return True
    return bool(
        re.search(
            r"(?:待验证风险|剩余风险|残余风险|未覆盖|未验证)"
            r"[\s*:：-]*(?:无|没有|未发现|不存在|none\b|no\b)",
            lowered,
        )
    )


def has_pending_risks(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines()]
    for index, line in enumerate(lines):
        lowered = line.lower()
        if not any(marker in lowered for marker in PENDING_RISK_MARKERS):
            continue
        if any(marker in lowered for marker in HISTORICAL_MARKERS):
            continue
        if _line_has_negated_risk(line):
            continue
        content = line
        marker_matches = [
            (content.lower().find(marker), marker)
            for marker in PENDING_RISK_MARKERS
        ]
        marker_matches = [match for match in marker_matches if match[0] >= 0]
        if marker_matches:
            marker_start, marker = min(marker_matches, key=lambda item: item[0])
            marker_end = marker_start + len(marker)
            tail = content[marker_end:].strip(" \t*:：-")
            if re.match(r"^(?:无|没有|none\b|no\b)", tail, re.IGNORECASE):
                continue
            if tail:
                return True
        for following in lines[index + 1:]:
            if not following:
                continue
            if re.match(
                r"^[\s>*_`-]*(?:无|没有|未发现|不存在|none\b|no\b)",
                following,
                re.IGNORECASE,
            ):
                break
            return True
    return False


def extract_closing_mentions(text: str) -> List[str]:
    mentions: List[str] = []
    pattern = re.compile(
        r"(?:P[0-3](?:\s*[/、,，]\s*P[0-3])*|P0[-–]P3)"
        r"[^\n。；;,，]{0,30}(?:已关闭|关闭|已修复|fixed|closed)",
        re.IGNORECASE,
    )
    for line in text.splitlines():
        matches = list(pattern.finditer(line))
        lowered = line.lower()
        if not matches:
            continue
        if any(marker in lowered for marker in HISTORICAL_MARKERS):
            continue
        for match in matches:
            status_context = match.group(0).lower()
            history_context = line[max(0, match.start() - 8):match.end()].lower()
            if any(marker in history_context for marker in HISTORICAL_MARKERS):
                continue
            if any(negation in status_context for negation in CLOSING_NEGATIONS):
                continue
            value = re.sub(r"\s+", " ", match.group(0)).strip()
            if value not in mentions:
                mentions.append(value)
    return mentions


def analyze_run(
    run_dir: Path,
    experiment: Path,
    task_contracts: Optional[Dict[str, Tuple[List[str], List[str]]]] = None,
    task_contract_error: Optional[str] = None,
    contracts_loaded: bool = False,
) -> RunAttribution:
    relative = run_dir.relative_to(experiment)
    parts = relative.parts
    task_id = parts[1] if len(parts) > 2 else parts[0]
    arm = parts[2] if len(parts) > 2 else "unknown"
    repeat_match = re.fullmatch(r"r(\d+)", parts[3] if len(parts) > 3 else "")
    repeat = int(repeat_match.group(1)) if repeat_match else 0
    run_id = "/".join((task_id, arm, f"r{repeat}"))

    result = read_json(run_dir / "result.json")
    if not contracts_loaded:
        try:
            task_contracts = load_task_contracts(experiment, task_ids=[task_id])
        except ValueError as error:
            task_contract_error = str(error)
        contracts_loaded = True
    expected = (task_contracts or {}).get(task_id)
    validation_error = task_contract_error
    if (
        validation_error is None
        and task_contracts is None
        and result.get("result_protocol") == RESULT_PROTOCOL
    ):
        validation_error = f"experiment dataset is required: {experiment / 'dataset.json'}"
    if validation_error is None and task_contracts is not None and expected is None:
        validation_error = f"task {task_id} is missing from dataset/baseline contracts"
    expected_f2p, expected_p2p = expected or (None, None)
    result_valid = bool(
        validation_error is None
        and is_valid_stored_result(
            result,
            run_dir / "result.json",
            expected_task_id=task_id,
            expected_arm=arm,
            expected_repeat=repeat,
            expected_f2p=expected_f2p,
            expected_p2p=expected_p2p,
        )
    )
    result_protocol = result.get("result_protocol")
    if not isinstance(result_protocol, int) or isinstance(result_protocol, bool):
        result_protocol = None
    agent_result = result.get("agent") if isinstance(result.get("agent"), dict) else {}
    usage = result.get("usage")
    if not isinstance(usage, dict):
        usage = agent_result.get("usage") if isinstance(agent_result.get("usage"), dict) else {}
    wall_seconds = result.get("wall_seconds", agent_result.get("wall_seconds"))
    observed_result = result.get("observed")
    observed_tool_calls = (
        observed_result.get("observed_tool_calls")
        if isinstance(observed_result, dict)
        else None
    )
    reported_tool_calls = result.get("tool_calls", observed_tool_calls)

    attribution = RunAttribution(
        run_id=run_id,
        task_id=task_id,
        arm=arm,
        repeat=repeat,
        result_present=bool(result),
        result_protocol=result_protocol,
        result_valid=result_valid,
        result_validation_error=validation_error,
        resolved=result.get("resolved") if result_valid else None,
        historical_resolved=(
            result.get("resolved")
            if (
                not result_valid
                and result_protocol != RESULT_PROTOCOL
                and result.get("behavior_result_protocol") != "behavior-v1"
                and isinstance(result.get("resolved"), bool)
            )
            else None
        ),
        wall_seconds=_number(wall_seconds, float),
        reported_tool_calls=_number(reported_tool_calls, int),
    )
    attribution.input_tokens = int(
        _number(usage.get("input_tokens", 0), int) or 0
    )
    attribution.cached_input_tokens = int(
        _number(usage.get("cached_input_tokens", 0), int) or 0
    )
    attribution.output_tokens = int(
        _number(usage.get("output_tokens", 0), int) or 0
    )

    events_path = run_dir / "events.jsonl"
    if not events_path.exists():
        return attribution

    reviewer_ids: Set[str] = set()
    completed_reviewer_ids: Set[str] = set()
    reviewer_report_seen: Set[str] = set()
    reviewer_reports: List[str] = []
    seen_tool_items: Set[str] = set()
    agent_texts: List[str] = []

    for line in events_path.read_text(
        encoding="utf-8", errors="replace"
    ).splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            attribution.malformed_event_lines += 1
            continue
        if not is_valid_event(event):
            attribution.malformed_event_lines += 1
            continue
        event_type = event["type"]
        item = event.get("item")
        attribution.event_count += 1
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        item_id = str(item.get("id") or "")

        if event_type == "item.completed" and item_type in {
            "command_execution",
            "file_change",
            "collab_tool_call",
        }:
            if item_id not in seen_tool_items:
                seen_tool_items.add(item_id)
                attribution.observed_tool_calls += 1

        if item_type == "agent_message" and event_type == "item.completed":
            text = item.get("text")
            if isinstance(text, str) and text:
                attribution.agent_messages += 1
                agent_texts.append(text)

        if item_type == "command_execution" and event_type == "item.completed":
            command = item.get("command")
            if isinstance(command, str):
                for marker in extract_metadata_access(command):
                    attribution.benchmark_metadata_access[marker] += 1
            if item.get("exit_code") in (None, 0) and isinstance(command, str):
                files, modules = _read_access(command)
                for module in modules:
                    attribution.module_access[module] += 1
                for file_path in files:
                    attribution.file_access[file_path] += 1

    combined_agent_text = "\n".join(agent_texts)
    # The final response is excluded from the initial route sample. If the
    # agent only emits one final message, the initial path stays unknown.
    attribution.declared_initial_path = first_declared_path(agent_texts[:-1])
    if agent_texts:
        attribution.declared_final_path = first_declared_path([agent_texts[-1]])
    attribution.upgraded_to_full = bool(
        attribution.declared_initial_path == "quick"
        and attribution.declared_final_path
        not in {"quick", "full-local", "full-staged"}
        and (
            attribution.declared_final_path == "full"
            or has_positive_upgrade(combined_agent_text)
        )
    )

    # Re-read after gathering reviewer IDs so only reviewer messages are parsed.
    for line in events_path.read_text(
        encoding="utf-8", errors="replace"
    ).splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not is_valid_event(event):
            continue
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "collab_tool_call":
            continue
        if event.get("type") != "item.completed":
            continue
        prompt = item.get("prompt")
        tool = item.get("tool")
        if (
            tool == "spawn_agent"
            and isinstance(prompt, str)
            and any(marker in prompt.lower() for marker in REVIEW_PROMPT_MARKERS)
        ):
            reviewer_ids.update(
                str(value) for value in item.get("receiver_thread_ids", []) if value
            )

        if tool not in {"wait", "close_agent"}:
            continue
        states = item.get("agents_states")
        if not isinstance(states, dict):
            continue
        for agent_id, state in states.items():
            if agent_id not in reviewer_ids or not isinstance(state, dict):
                continue
            if state.get("status") != "completed":
                continue
            message = state.get("message")
            if not isinstance(message, str) or not message.strip():
                continue
            completed_reviewer_ids.add(agent_id)
            # Wait/close events repeat report snapshots. Deduplicate identical
            # messages while retaining a later follow-up from the same reviewer.
            if message not in reviewer_report_seen:
                reviewer_report_seen.add(message)
                reviewer_reports.append(message)

    attribution.reviewer_instances = len(reviewer_ids)
    attribution.reviewer_completed_instances = len(completed_reviewer_ids)
    attribution.reviewer_reports = len(reviewer_reports)
    report_text = "\n".join(reviewer_reports)
    if reviewer_reports:
        findings: List[Finding] = []
        finding_keys: Set[Tuple[str, str]] = set()
        for report in reviewer_reports:
            for finding in extract_findings(report):
                key = (finding.severity, finding.title)
                if key not in finding_keys:
                    finding_keys.add(key)
                    findings.append(finding)
        attribution.findings = findings
        attribution.reviewer_zero_findings = (
            not findings and has_zero_finding_statement(report_text)
        )
        attribution.reviewer_pending_risks = has_pending_risks(report_text)
        attribution.closing_mentions = extract_closing_mentions(
            combined_agent_text + "\n" + report_text
        )
    return attribution


def discover_runs(experiment: Path) -> List[RunAttribution]:
    runs_root = experiment / "runs"
    if not runs_root.exists():
        raise SystemExit(f"missing runs directory: {runs_root}")
    run_dirs = sorted(
        path
        for path in runs_root.glob("*/*/r*")
        if path.is_dir() and (path / "events.jsonl").exists()
    )
    task_ids = sorted({path.relative_to(runs_root).parts[0] for path in run_dirs})
    try:
        task_contracts = load_task_contracts(experiment, task_ids=task_ids)
        task_contract_error = None
    except ValueError as error:
        task_contracts = None
        task_contract_error = str(error)
    return [
        analyze_run(
            path,
            experiment,
            task_contracts,
            task_contract_error,
            contracts_loaded=True,
        )
        for path in run_dirs
    ]


def format_optional(value: Optional[float], digits: int = 1) -> str:
    return "unknown" if value is None else f"{value:.{digits}f}"


def aggregate_rows(runs: Sequence[RunAttribution]) -> List[Dict[str, Any]]:
    rows = []
    for arm in sorted({run.arm for run in runs}):
        selected = [run for run in runs if run.arm == arm]
        inputs = [run.input_tokens for run in selected if run.input_tokens]
        walls = [
            run.wall_seconds
            for run in selected
            if run.wall_seconds is not None
        ]
        modules = Counter()
        for run in selected:
            modules.update(run.module_access.keys())
        rows.append(
            {
                "arm": arm,
                "runs": len(selected),
                "resolved": sum(run.resolved is True for run in selected),
                "historical_resolved": sum(
                    run.historical_resolved is True for run in selected
                ),
                "current_protocol_runs": sum(run.result_valid for run in selected),
                "reviewer_runs": sum(run.reviewer_instances > 0 for run in selected),
                "reviewer_instances": sum(
                    run.reviewer_instances for run in selected
                ),
                "reviewer_completed_instances": sum(
                    run.reviewer_completed_instances for run in selected
                ),
                "quick_with_reviewer": sum(
                    run.declared_quick_with_reviewer for run in selected
                ),
                "mean_input_tokens": statistics.mean(inputs) if inputs else None,
                "mean_cache_rate": (
                    statistics.mean(
                        run.cache_rate
                        for run in selected
                        if run.cache_rate is not None
                    )
                    if any(run.cache_rate is not None for run in selected)
                    else None
                ),
                "mean_wall_seconds": statistics.mean(walls) if walls else None,
                "module_run_counts": dict(sorted(modules.items())),
            }
        )
    return rows


def to_payload(experiment: Path, runs: Sequence[RunAttribution]) -> Dict[str, Any]:
    event_lines = sum(run.event_count for run in runs)
    malformed = sum(run.malformed_event_lines for run in runs)
    reviewer_runs = sum(run.reviewer_instances > 0 for run in runs)
    invalid_event_runs = sum(not run.event_stream_valid for run in runs)
    return {
        "experiment": str(experiment.resolve()),
        "runs": [run.as_dict() for run in runs],
        "aggregate": aggregate_rows(runs),
        "summary": {
            "run_count": len(runs),
            "current_protocol_runs": sum(run.result_valid for run in runs),
            "runs_with_contract_errors": sum(
                run.result_validation_error is not None for run in runs
            ),
            "historical_result_runs": sum(
                run.historical_resolved is not None for run in runs
            ),
            "event_count": event_lines,
            "malformed_event_lines": malformed,
            "runs_with_invalid_event_stream": invalid_event_runs,
            "runs_with_reviewer": reviewer_runs,
            "runs_without_reviewer": len(runs) - reviewer_runs,
            "declared_quick_with_reviewer": sum(
                run.declared_quick_with_reviewer for run in runs
            ),
            "reviewer_finding_count": sum(
                len(run.findings) for run in runs
            ),
        },
        "limits": [
            "Subagent token usage is unavailable when the host does not expose it.",
            "A reviewer report is evidence of review activity, not task acceptance.",
            "Only current-protocol results contribute to resolved; historical results are reported separately.",
            "Command-path matching shows module access, not semantic comprehension.",
            "Successful command matching is not proof of complete file inspection.",
        ],
    }


def render_markdown(payload: Dict[str, Any]) -> str:
    summary = payload["summary"]
    lines = [
        "# Codex Event Attribution",
        "",
        f"- Experiment: `{payload['experiment']}`",
        f"- Runs: {summary['run_count']}",
        f"- Events: {summary['event_count']}",
        f"- Malformed event lines: {summary['malformed_event_lines']}",
        f"- Runs with invalid event streams: {summary['runs_with_invalid_event_stream']}",
        f"- Current-protocol result runs: {summary['current_protocol_runs']}",
        f"- Historical result records: {summary['historical_result_runs']}",
        (
            "- Runs with/without an observed reviewer: "
            f"{summary['runs_with_reviewer']}/"
            f"{summary['runs_without_reviewer']}"
        ),
        (
            "- Declared quick but spawned a reviewer: "
            f"{summary['declared_quick_with_reviewer']}"
        ),
        "",
        "## Aggregate",
        "",
        "| Arm | Runs | Current-protocol runs | Resolved | Historical resolved | "
        "Reviewer runs | Reviewer instances | "
        "Completed reviewers | "
        "Quick with reviewer | Mean input | Mean cache rate | Mean wall (s) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in payload["aggregate"]:
        mean_input = row["mean_input_tokens"]
        cache_rate = row["mean_cache_rate"]
        lines.append(
            f"| {row['arm']} | {row['runs']} | "
            f"{row['current_protocol_runs']} | {row['resolved']} | "
            f"{row['historical_resolved']} | {row['reviewer_runs']} | "
            f"{row['reviewer_instances']} | "
            f"{row['reviewer_completed_instances']} | "
            f"{row['quick_with_reviewer']} | "
            f"{'unknown' if mean_input is None else f'{mean_input:.0f}'} | "
            f"{'unknown' if cache_rate is None else f'{cache_rate:.1%}'} | "
            f"{format_optional(row['mean_wall_seconds'])} |"
        )

    lines.extend(
        [
            "",
            "## Module Access",
            "",
            "| Module | Runs that accessed it |",
            "| --- | ---: |",
        ]
    )
    module_runs = Counter()
    for run in payload["runs"]:
        module_runs.update(run["module_access"].keys())
    for module, count in sorted(module_runs.items()):
        lines.append(f"| `{module}` | {count} |")

    lines.extend(
        [
            "",
            "## Runs",
            "",
            "| Run | Resolved | Declared start | Declared final | Upgraded | "
            "Reviewers | Completed | Reports | Zero findings | Findings | Modules |",
            "| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
        ]
    )
    for run in payload["runs"]:
        findings = ", ".join(
            f"{item['severity']}: {item['title']}"
            for item in run["findings"]
        ) or "-"
        modules = ", ".join(run["module_access"].keys()) or "-"
        declared = run["declared_initial_path"] or "unknown"
        declared_final = run["declared_final_path"] or "unknown"
        upgraded = "yes" if run["upgraded_to_full"] else "no"
        zero = (
            "unknown"
            if run["reviewer_zero_findings"] is None
            else ("yes" if run["reviewer_zero_findings"] else "no")
        )
        lines.append(
            f"| `{run['run_id']}` | {str(run['resolved']).lower()} | "
            f"{declared} | {declared_final} | {upgraded} | "
            f"{run['reviewer_instances']} | {run['reviewer_completed_instances']} | "
            f"{run['reviewer_reports']} | {zero} | {findings} | {modules} |"
        )

    suspicious = [
        run for run in payload["runs"] if run["declared_quick_with_reviewer"]
    ]
    if suspicious:
        lines.extend(["", "## Routing Warnings", ""])
        for run in suspicious:
            lines.append(
                f"- `{run['run_id']}` declared quick and spawned "
                f"{run['reviewer_instances']} reviewer instance(s)."
            )

    closing = [
        (run["run_id"], mention)
        for run in payload["runs"]
        for mention in run["closing_mentions"]
    ]
    lines.extend(["", "## Closing Mentions", ""])
    if closing:
        for run_id, mention in closing:
            lines.append(f"- `{run_id}`: {mention}")
    else:
        lines.append("No explicit closing phrases were detected in reviewer reports.")

    lines.extend(["", "## Evidence Limits", ""])
    for limit in payload["limits"]:
        lines.append(f"- {limit}")
    lines.append("")
    return "\n".join(lines)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--experiment",
        type=Path,
        required=True,
        help="Experiment directory containing runs/<task>/<arm>/r<n>/.",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Stdout format. Defaults to markdown.",
    )
    parser.add_argument("--output", type=Path, help="Optional output path.")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    runs = discover_runs(args.experiment)
    if not runs:
        raise SystemExit("no runs with events.jsonl found")
    payload = to_payload(args.experiment, runs)
    if args.format == "json":
        rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    else:
        rendered = render_markdown(payload)
    if args.output:
        write_text(args.output, rendered)
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
