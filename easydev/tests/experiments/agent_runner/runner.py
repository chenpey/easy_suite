#!/usr/bin/env python3
"""Run isolated EasyDev behavior scenarios against one host adapter."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple


AGENT_RUNNER_ROOT = Path(__file__).resolve().parent
EXPERIMENTS_ROOT = AGENT_RUNNER_ROOT.parent
EASYDEV_ROOT = AGENT_RUNNER_ROOT.parents[2]
BEHAVIOR_RESULT_PROTOCOL = "behavior-v1"
SWEBENCH_ROOT = EXPERIMENTS_ROOT / "swebench"
if str(SWEBENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(SWEBENCH_ROOT))

from analyze_events import analyze_run  # noqa: E402
from adapters.codex_cli import run_codex  # noqa: E402
from scenarios import load_scenario  # noqa: E402
from scenarios.common import install_skill  # noqa: E402


def run_command(
    args: Sequence[str],
    cwd: Path,
    *,
    check: bool = True,
    timeout: int = 120,
) -> subprocess.CompletedProcess:
    command = list(args)
    env = os.environ.copy()
    if command and Path(command[0]).name == "git":
        command[1:1] = [
            "-c",
            f"core.hooksPath={os.devnull}",
            "-c",
            "core.fsmonitor=false",
        ]
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        env["GIT_ATTR_SYSTEM"] = os.devnull
        env["GIT_ATTR_GLOBAL"] = os.devnull
        env.pop("GIT_CONFIG_COUNT", None)
        env.pop("GIT_CONFIG_PARAMETERS", None)
        for key in list(env):
            if key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
                env.pop(key, None)
    result = subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(args)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


@contextmanager
def _trusted_git_config(workspace: Path, content: bytes) -> Iterator[None]:
    git_dir = workspace / ".git"
    if git_dir.is_symlink() or not git_dir.is_dir():
        raise RuntimeError("Git metadata directory changed before capture")

    config_path = git_dir / "config"
    backup_path = git_dir / f".runner-config-{uuid.uuid4().hex}"
    had_config = os.path.lexists(config_path)
    if had_config:
        os.replace(config_path, backup_path)
    temporary_path: Optional[Path] = None
    try:
        fd, name = tempfile.mkstemp(prefix=".runner-config-", dir=git_dir)
        temporary_path = Path(name)
        with os.fdopen(fd, "wb") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, config_path)
        temporary_path = None
        yield
    finally:
        try:
            if os.path.lexists(config_path):
                if config_path.is_dir() and not config_path.is_symlink():
                    shutil.rmtree(config_path)
                else:
                    config_path.unlink()
        finally:
            if had_config and os.path.lexists(backup_path):
                os.replace(backup_path, config_path)
            if temporary_path is not None and os.path.lexists(temporary_path):
                temporary_path.unlink()


def init_git(workspace: Path) -> str:
    run_command(["git", "init", "-q"], workspace)
    run_command(["git", "config", "user.email", "behavior@example.com"], workspace)
    run_command(["git", "config", "user.name", "behavior-runner"], workspace)
    run_command(["git", "config", "commit.gpgsign", "false"], workspace)
    exclude = workspace / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text(
        "\n".join(
            [
                ".agents/skills/",
                ".pytest_cache/",
                "__pycache__/",
                "*.pyc",
                ".coverage",
                ".venv/",
                "",
            ]
        ),
        encoding="utf-8",
    )
    run_command(["git", "add", "-A"], workspace)
    run_command(["git", "commit", "-qm", "behavior fixture"], workspace)
    return run_command(["git", "rev-parse", "HEAD"], workspace).stdout.strip()


def capture_changes(
    workspace: Path,
    base_sha: str,
    trusted_git_config: bytes,
) -> Dict[str, Any]:
    with _trusted_git_config(workspace, trusted_git_config):
        return _capture_changes(workspace, base_sha)


def _capture_changes(
    workspace: Path,
    base_sha: str,
) -> Dict[str, Any]:
    staged_before = staged_changes(workspace)
    flags_before = index_flags(workspace)
    changed_flags = {
        path: flag for path, flag in flags_before.items() if flag not in {"H", "M"}
    }
    index_changed = bool(staged_before or changed_flags)
    for path, flag in changed_flags.items():
        if flag.islower():
            run_command(
                ["git", "update-index", "--no-assume-unchanged", "--", path],
                workspace,
            )
        elif flag == "S":
            run_command(
                ["git", "update-index", "--no-skip-worktree", "--", path],
                workspace,
            )
    run_command(["git", "add", "-A"], workspace)
    names = run_command(
        ["git", "diff", "--cached", "--name-only", base_sha],
        workspace,
    ).stdout.splitlines()
    patch = run_command(
        [
            "git",
            "diff",
            "--cached",
            "--binary",
            base_sha,
            "--",
            ".",
            ":(exclude).agents/skills",
        ],
        workspace,
    ).stdout
    uncaptured_paths = set(
        run_command(["git", "diff", "--name-only"], workspace).stdout.splitlines()
    )
    uncaptured_paths.update(
        run_command(
            ["git", "ls-files", "--others", "--exclude-standard"],
            workspace,
        ).stdout.splitlines()
    )
    return {
        "changed_paths": sorted(
            path for path in names if not path.startswith(".agents/skills/")
        ),
        "patch": patch,
        "base_sha": base_sha,
        "index_changed": index_changed,
        "staged_paths_before_capture": sorted(staged_before),
        "index_flags_before_capture": dict(sorted(flags_before.items())),
        "index_flag_paths": sorted(changed_flags),
        "uncaptured_worktree_paths": sorted(uncaptured_paths),
    }


def staged_changes(workspace: Path, base_sha: str = "HEAD") -> List[str]:
    return run_command(
        ["git", "diff", "--cached", "--name-only", base_sha],
        workspace,
    ).stdout.splitlines()


def index_flags(workspace: Path) -> Dict[str, str]:
    flags: Dict[str, str] = {}
    for line in run_command(["git", "ls-files", "-v"], workspace).stdout.splitlines():
        if len(line) >= 3 and line[1] == " ":
            flags[line[2:]] = line[0]
    return flags


def prepare_workspace(
    *,
    scenario_id: str,
    workspace: Path,
    skill_root: Path,
    case_root: Path,
) -> Dict[str, Any]:
    if workspace.exists() and any(workspace.iterdir()):
        raise SystemExit(f"workspace is not empty: {workspace}")
    workspace.mkdir(parents=True, exist_ok=True)
    scenario = load_scenario(scenario_id)
    scenario.prepare(workspace, case_root)
    base_sha = init_git(workspace)
    skill_path = install_skill(skill_root, workspace)
    return {
        "scenario": scenario_id,
        "title": scenario.title,
        "workspace": str(workspace.resolve()),
        "skill": str(skill_path.resolve()),
        "base_sha": base_sha,
        "prompt": scenario.prompt,
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    temporary: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as target:
            temporary = Path(target.name)
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _snapshot_tree(root: Path, *, exclude_names: set[str] | None = None) -> Dict[str, str]:
    if not root.exists():
        return {}
    excluded = exclude_names or set()
    snapshot: Dict[str, str] = {}
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(
            name for name in directories if name not in excluded
        )
        for name in list(directories):
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            mode = path.lstat().st_mode & 0o7777
            if path.is_symlink():
                snapshot[relative] = f"symlink:{path.readlink()}"
                directories.remove(name)
            else:
                snapshot[relative] = f"directory:{mode:o}"
        for name in sorted(files):
            if name in excluded:
                continue
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            mode = path.lstat().st_mode & 0o7777
            if path.is_symlink():
                snapshot[relative] = f"symlink:{path.readlink()}"
            elif path.is_file():
                snapshot[relative] = (
                    f"file:{mode:o}:sha256:"
                    + hashlib.sha256(path.read_bytes()).hexdigest()
                )
            else:
                snapshot[relative] = f"other:{mode:o}"
    return snapshot


def snapshot_runtime_tree(root: Path) -> Dict[str, str]:
    return _snapshot_tree(root)


def snapshot_workspace(root: Path) -> Dict[str, str]:
    return _snapshot_tree(root, exclude_names={".git"})


def snapshot_git_metadata(workspace: Path) -> Dict[str, str]:
    """Capture Git controls while excluding the expected index/object/log churn."""
    return _snapshot_tree(
        workspace / ".git",
        exclude_names={"index", "objects", "logs"},
    )


def git_metadata_changes(before: Dict[str, str], workspace: Path) -> List[str]:
    after = snapshot_git_metadata(workspace)
    return sorted(
        path
        for path in before.keys() | after.keys()
        if before.get(path) != after.get(path)
    )


def workspace_changes(
    before: Dict[str, str],
    workspace: Path,
) -> List[str]:
    after = snapshot_workspace(workspace)
    return sorted(
        path
        for path in before.keys() | after.keys()
        if before.get(path) != after.get(path)
    )


def runtime_tree_changes(
    before: Dict[str, str],
    skill_root: Path,
) -> List[str]:
    after = snapshot_runtime_tree(skill_root)
    return sorted(
        path
        for path in before.keys() | after.keys()
        if before.get(path) != after.get(path)
    )


def run_scenario(args: argparse.Namespace) -> Dict[str, Any]:
    experiment = args.out
    run_dir = (
        experiment
        / "runs"
        / args.scenario
        / "easydev"
        / f"r{args.repeat}"
    )
    if run_dir.exists() and any(run_dir.iterdir()):
        if not args.overwrite:
            raise SystemExit(f"run directory is not empty: {run_dir}")
        shutil.rmtree(run_dir)
    workspace = run_dir / "workspace"
    run_dir.mkdir(parents=True, exist_ok=True)
    prepared = prepare_workspace(
        scenario_id=args.scenario,
        workspace=workspace,
        skill_root=args.skill_root,
        case_root=args.case_root,
    )
    skill_path = Path(prepared["skill"])
    runtime_before = snapshot_runtime_tree(skill_path)
    workspace_before = snapshot_workspace(workspace)
    git_metadata_before = snapshot_git_metadata(workspace)
    trusted_git_config = (workspace / ".git" / "config").read_bytes()
    agent = run_codex(
        workspace=workspace,
        run_dir=run_dir,
        prompt=prepared["prompt"],
        codex_bin=args.codex_bin,
        auth_path=args.codex_auth,
        model=args.model,
        reasoning_effort=args.reasoning_effort,
        base_url=args.base_url,
        timeout=args.agent_timeout,
    )
    runtime_skill_changes = runtime_tree_changes(runtime_before, skill_path)
    workspace_changes_before_capture = workspace_changes(
        workspace_before,
        workspace,
    )
    git_metadata_changes_before_capture = git_metadata_changes(
        git_metadata_before,
        workspace,
    )
    captured = capture_changes(
        workspace,
        prepared["base_sha"],
        trusted_git_config,
    )
    workspace_changes_after_capture = workspace_changes(workspace_before, workspace)
    git_metadata_changes_after_capture = git_metadata_changes(
        git_metadata_before,
        workspace,
    )
    (run_dir / "agent.patch").write_text(captured["patch"], encoding="utf-8")
    valid_invocation = bool(
        agent.get("returncode") == 0
        and agent.get("turn_completed")
        and not agent.get("timed_out")
        and (agent.get("event_count") or 0) > 0
        and agent.get("malformed_event_lines") == 0
    )
    result = {
        "scenario": args.scenario,
        "title": prepared["title"],
        "repeat": args.repeat,
        "behavior_result_protocol": BEHAVIOR_RESULT_PROTOCOL,
        "request": {
            "model": args.model or "inherit",
            "reasoning_effort": args.reasoning_effort,
            "codex_bin": str(args.codex_bin),
            "base_url": args.base_url,
        },
        "valid_invocation": valid_invocation,
        "wall_seconds": agent.get("wall_seconds"),
        "usage": agent.get("usage", {}),
        "agent": {
            "returncode": agent.get("returncode"),
            "timed_out": agent.get("timed_out"),
            "turn_completed": agent.get("turn_completed"),
            "wall_seconds": agent.get("wall_seconds"),
            "usage": agent.get("usage", {}),
            "event_count": agent.get("event_count"),
            "malformed_event_lines": agent.get("malformed_event_lines"),
        },
        "changed_paths": captured["changed_paths"],
        "index_changed": captured["index_changed"],
        "staged_paths_before_capture": captured["staged_paths_before_capture"],
        "index_flags_before_capture": captured["index_flags_before_capture"],
        "index_flag_paths": captured["index_flag_paths"],
        "runtime_skill_changes": runtime_skill_changes,
        "workspace_changes_before_capture": workspace_changes_before_capture,
        "workspace_changes_after_capture": workspace_changes_after_capture,
        "git_metadata_changes_before_capture": git_metadata_changes_before_capture,
        "git_metadata_changes_after_capture": git_metadata_changes_after_capture,
        "uncaptured_worktree_paths": captured["uncaptured_worktree_paths"],
        "patch_chars": len(captured["patch"]),
        "final_message": agent.get("final_message", ""),
    }
    write_json(run_dir / "result.json", result)
    observed = analyze_run(run_dir, experiment)
    observed.index_changed = captured["index_changed"]
    observed.runtime_skill_changes = runtime_skill_changes
    observed.workspace_changes = workspace_changes_after_capture
    observed.git_metadata_changes = git_metadata_changes_after_capture
    observed.uncaptured_worktree_paths = captured["uncaptured_worktree_paths"]
    scenario = load_scenario(args.scenario)
    evaluation = scenario.evaluate(
        workspace,
        captured["changed_paths"],
        agent.get("final_message", ""),
        observed,
    )
    resolved = bool(valid_invocation and evaluation["passed"])
    observed.resolved = resolved
    result.update(
        {
            "resolved": resolved,
            "tool_calls": observed.observed_tool_calls,
            "observed": observed.as_dict(),
            "evaluation": evaluation,
            "final_message": agent.get("final_message", ""),
        }
    )
    write_json(run_dir / "result.json", result)
    return result


def prepare_command(args: argparse.Namespace) -> Dict[str, Any]:
    workspace = (
        args.out
        / "runs"
        / args.scenario
        / "easydev"
        / f"r{args.repeat}"
        / "workspace"
    )
    if workspace.parent.exists() and any(workspace.parent.iterdir()):
        if not args.overwrite:
            raise SystemExit(f"prepared run directory is not empty: {workspace.parent}")
        shutil.rmtree(workspace.parent)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    return prepare_workspace(
        scenario_id=args.scenario,
        workspace=workspace,
        skill_root=args.skill_root,
        case_root=args.case_root,
    )


def list_command(args: argparse.Namespace) -> List[Dict[str, str]]:
    del args
    return [
        {"id": "b01", "title": load_scenario("b01").title},
        {"id": "b02", "title": load_scenario("b02").title},
        {"id": "b16", "title": load_scenario("b16").title},
        {
            "id": "public-contract-callers",
            "title": load_scenario("public-contract-callers").title,
        },
    ]


def default_codex_bin() -> Path:
    discovered = shutil.which("codex")
    if discovered:
        return Path(discovered)
    return Path(
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/"
        "CodexCLI.app/Contents/MacOS/codex"
    )


def common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--scenario",
        choices=("b01", "b02", "b16", "public-contract-callers"),
        required=True,
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing non-empty run directory.",
    )
    parser.add_argument("--skill-root", type=Path, default=EASYDEV_ROOT)
    parser.add_argument(
        "--case-root",
        type=Path,
        default=EASYDEV_ROOT / "tests" / "cases",
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    common_args(prepare_parser)

    run_parser = subparsers.add_parser("run")
    common_args(run_parser)
    run_parser.add_argument("--codex-bin", type=Path, default=default_codex_bin())
    run_parser.add_argument(
        "--codex-auth",
        type=Path,
        default=Path.home() / ".codex" / "auth.json",
    )
    run_parser.add_argument("--model")
    run_parser.add_argument("--reasoning-effort", default="inherit")
    run_parser.add_argument("--base-url")
    run_parser.add_argument("--agent-timeout", type=int, default=900)

    subparsers.add_parser("list")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.command == "list":
        print(json.dumps(list_command(args), ensure_ascii=False, indent=2))
        return 0
    if args.command == "prepare":
        print(json.dumps(prepare_command(args), ensure_ascii=False, indent=2))
        return 0
    result = run_scenario(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["resolved"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
