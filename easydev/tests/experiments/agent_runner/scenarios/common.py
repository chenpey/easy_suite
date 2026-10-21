"""Shared scenario helpers."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Dict, Iterable, List


def write_files(root: Path, files: Dict[str, str]) -> None:
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def install_skill(skill_root: Path, workspace: Path) -> Path:
    destination = workspace / ".agents" / "skills" / "easydev"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(skill_root / "SKILL.md", destination / "SKILL.md")
    shutil.copytree(
        skill_root / "references",
        destination / "references",
        dirs_exist_ok=True,
    )
    return destination


def is_test_path(path: str) -> bool:
    parts = Path(path).parts
    if any(part in {"test", "tests", "testing"} for part in parts):
        return True
    name = parts[-1] if parts else path
    return name.startswith("test_") or name.endswith("_test.py")


def changed_outside(
    changed_paths: Iterable[str],
    allowed_prefixes: Iterable[str],
) -> List[str]:
    prefixes = tuple(allowed_prefixes)
    return sorted(
        path
        for path in changed_paths
        if not any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes)
    )


def hidden_workspace_changes(observed: object, captured_paths: Iterable[str]) -> List[str]:
    captured = set(captured_paths)
    return sorted(
        path
        for path in getattr(observed, "workspace_changes", [])
        if path not in captured
    )


def entered_full(observed: object) -> bool:
    initial = getattr(observed, "declared_initial_path", None)
    final = getattr(observed, "declared_final_path", None)
    if final in {"quick", "full-local", "full-staged"}:
        return False
    if final == "full":
        return True
    return bool(
        initial == "full"
        or getattr(observed, "upgraded_to_full", False)
    )


def evaluation(
    checks: List[Dict[str, object]],
    details: Dict[str, object] | None = None,
) -> Dict[str, object]:
    return {
        "passed": all(bool(check["passed"]) for check in checks),
        "checks": checks,
        "details": details or {},
    }


def check(name: str, passed: bool, evidence: object) -> Dict[str, object]:
    return {
        "name": name,
        "passed": bool(passed),
        "evidence": evidence,
    }


def run_python(
    workspace: Path,
    code: str,
    *,
    timeout: int = 60,
) -> Dict[str, object]:
    import subprocess

    env = os.environ.copy()
    env.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(workspace),
        }
    )
    result = subprocess.run(
        [os.environ.get("PYTHON", "python3"), "-S", "-B", "-c", code],
        cwd=str(workspace),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        timeout=timeout,
    )
    return {
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
