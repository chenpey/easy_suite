#!/usr/bin/env python3
"""CLI contracts for the SWE-bench experiment runner.

Coverage gap: earlier in-process tests could not observe the published
``setup`` / ``run`` / ``summarize`` contract, the ``invalid-result.json``
artifact, protection modes across a real process interruption, or a template
escape attempted by the command users actually run.  Every case drives
``run.py`` in a temporary experiment; the external boundaries are replaced by
``tests/experiments/stubs/codex_stub.py`` and ``pytest_stub.py`` while the
asset security checks (template extraction, protected modes) run against real
files.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


SWEBENCH = Path(__file__).resolve().parent
TESTS_ROOT = SWEBENCH.parents[1]
RUN = SWEBENCH / "run.py"
STUBS = TESTS_ROOT / "experiments" / "stubs"
CODEX_STUB = STUBS / "codex_stub.py"
PYTEST_STUB = STUBS / "pytest_stub.py"

TASK = {
    "id": "demo__task-1",
    "f2p": "tests/test_f2p.py::test_f2p",
    "p2p": "tests/test_p2p.py::test_p2p",
}
TASK2 = {
    "id": "demo__task-2",
    "f2p": "tests/test_f2p.py::test_f2p",
    "p2p": "tests/test_p2p.py::test_p2p",
}
TASK3 = {"id": "demo__task-3", "f2p": "tests/test_f2p.py::test_f2p", "p2p": "tests/test_p2p.py::test_p2p"}
TASK4 = {"id": "demo__task-4", "f2p": "tests/test_f2p.py::test_f2p", "p2p": "tests/test_p2p.py::test_p2p"}
TASK5 = {"id": "demo__task-5", "f2p": "tests/test_f2p.py::test_f2p", "p2p": "tests/test_p2p.py::test_p2p"}


def new_file_patch(path: str, content: str) -> str:
    lines = content.splitlines()
    body = "".join(f"+{line}\n" for line in lines)
    return (
        f"diff --git a/{path} b/{path}\n"
        "new file mode 100644\n"
        "index 0000000..e69de29\n"
        "--- /dev/null\n"
        f"+++ b/{path}\n"
        f"@@ -0,0 +1,{len(lines)} @@\n"
        f"{body}"
    )


TEST_PATCH = new_file_patch(
    "tests/test_f2p.py", "def test_f2p():\n    assert True\n"
) + new_file_patch(
    "tests/test_p2p.py", "def test_p2p():\n    assert True\n"
)


def write_dataset(path: Path, tasks) -> None:
    rows = [
        {
            "instance_id": task["id"],
            "repo": "demo/repo",
            "FAIL_TO_PASS": json.dumps([task["f2p"]]),
            "PASS_TO_PASS": json.dumps([task["p2p"]]),
            "patch": "",
            "test_patch": TEST_PATCH,
            "problem_statement": "Fix the module.",
        }
        for task in tasks
    ]
    path.write_text(json.dumps(rows), encoding="utf-8")


def write_baseline(experiment: Path, task: dict) -> None:
    path = experiment / "task-baselines" / f"{task['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "eligible_p2p": [task["p2p"]],
                "excluded_p2p": [],
                "statuses": {task["p2p"]: "PASSED"},
                "pytest_returncode": 0,
            }
        ),
        encoding="utf-8",
    )


def add_file(archive: tarfile.TarFile, name: str, content: str) -> None:
    payload = content.encode("utf-8")
    info = tarfile.TarInfo(name)
    info.size = len(payload)
    info.mode = 0o644
    archive.addfile(info, io.BytesIO(payload))


def add_dir(
    archive: tarfile.TarFile,
    name: str,
    mode: int = 0o755,
    mtime: int = 0,
) -> None:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = mode
    info.mtime = mtime
    archive.addfile(info)


def add_link(
    archive: tarfile.TarFile,
    name: str,
    linkname: str,
    *,
    hard: bool = False,
) -> None:
    info = tarfile.TarInfo(name)
    info.type = tarfile.LNKTYPE if hard else tarfile.SYMTYPE
    info.linkname = linkname
    info.mode = 0o644
    archive.addfile(info)


def standard_template(path: Path) -> None:
    with tarfile.open(path, "w") as archive:
        add_file(archive, "src/mod.py", "VALUE = 1\n")


def read_only_template(path: Path) -> None:
    with tarfile.open(path, "w") as archive:
        add_dir(archive, "pkg", 0o555)
        add_file(archive, "pkg/data.txt", "readable\n")
        add_dir(archive, "pkg/nested", 0o500)
        add_file(archive, "pkg/nested/inner.txt", "inner\n")


def force_remove(path: str) -> None:
    """Remove a tree that the tests may have locked at mode 0."""
    for current, directories, files in os.walk(path):
        for name in directories:
            try:
                os.chmod(os.path.join(current, name), 0o777)
            except OSError:
                pass
        for name in files:
            try:
                os.chmod(os.path.join(current, name), 0o777)
            except OSError:
                pass
    try:
        os.chmod(path, 0o777)
    except OSError:
        pass
    shutil.rmtree(path, ignore_errors=True)


def alive(pid: int) -> bool:
    """A zombie is already dead; macOS (no /proc) relies on launchd reaping."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    stat_path = Path(f"/proc/{pid}/stat")
    if stat_path.exists():
        try:
            state = stat_path.read_text(encoding="utf-8").rsplit(") ", 1)[1].split()[0]
        except (OSError, IndexError, UnicodeError):
            return True
        return state != "Z"
    return True


def wait_until(predicate, timeout: float, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class SwebenchCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="easydev-swebench-cli-"))
        self.addCleanup(force_remove, str(self.root))

    # -- fixture helpers -------------------------------------------------
    def make_stub(self, name: str) -> SimpleNamespace:
        base = self.root / name
        base.mkdir(parents=True, exist_ok=True)
        launcher = base / "codex-stub"
        launcher.write_text(
            "#!/bin/sh\nexec \"{}\" -B \"{}\" \"$@\"\n".format(
                sys.executable, CODEX_STUB
            ),
            encoding="utf-8",
        )
        launcher.chmod(0o755)
        home = base / "home"
        (home / ".codex").mkdir(parents=True)
        (home / ".codex" / "auth.json").write_text("{}\n", encoding="utf-8")
        return SimpleNamespace(base=base, launcher=launcher, home=home)

    def environment(
        self,
        stub: SimpleNamespace,
        plan: dict,
        statuses: dict,
    ) -> dict:
        plan_path = stub.base / "codex-plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        pytest_path = stub.base / "pytest-plan.json"
        pytest_path.write_text(
            json.dumps({"statuses": statuses}), encoding="utf-8"
        )
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(stub.home),
                "EASYDEV_STUB_PLAN": str(plan_path),
                "EASYDEV_PYTEST_PLAN": str(pytest_path),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
        )
        return env

    def make_assets(
        self,
        name: str,
        tasks=(TASK,),
        template=standard_template,
    ) -> SimpleNamespace:
        root = self.root / name
        source = root / "source"
        templates = source / "templates"
        venvs = source / "venvs"
        templates.mkdir(parents=True)
        for task in tasks:
            template_path = templates / f"{task['id']}.tar"
            template(template_path)
            binary = venvs / task["id"] / "bin"
            binary.mkdir(parents=True)
            (binary / "python").symlink_to(PYTEST_STUB)
        dataset = source / "dataset.json"
        write_dataset(dataset, tasks)
        return SimpleNamespace(
            root=root,
            source=source,
            dataset=dataset,
            templates=templates,
            venvs=venvs,
        )

    def install_experiment(
        self,
        assets: SimpleNamespace,
        name: str,
        tasks=(TASK,),
    ) -> Path:
        experiment = assets.root / name
        experiment.mkdir(parents=True)
        shutil.copy2(assets.dataset, experiment / "dataset.json")
        (experiment / "templates").mkdir()
        (experiment / "venvs").mkdir()
        for task in tasks:
            (experiment / "templates" / f"{task['id']}.tar").symlink_to(
                assets.templates / f"{task['id']}.tar"
            )
            (experiment / "venvs" / task["id"]).symlink_to(
                assets.venvs / task["id"]
            )
            write_baseline(experiment, task)
        return experiment

    def cli(
        self,
        args,
        *,
        env: dict,
        timeout: int = 120,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-B", str(RUN), *[str(value) for value in args]],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=timeout,
            env=env,
            cwd=str(cwd) if cwd else None,
        )

    def summarize(self, experiment: Path, *, cwd: Path | None = None):
        return self.cli(
            ["summarize", "--experiment", experiment],
            env=os.environ.copy(),
            cwd=cwd,
        )

    def attribution(self, experiment: Path) -> dict:
        completed = subprocess.run(
            [
                sys.executable,
                "-B",
                str(SWEBENCH / "analyze_events.py"),
                "--experiment",
                str(experiment),
                "--format",
                "json",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=60,
            env=os.environ.copy(),
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def write_manifest(self, experiment: Path, tasks) -> None:
        (experiment / "manifest.json").write_text(
            json.dumps(
                {
                    "kind": "swebench-lite-local-pilot",
                    "tasks": [task["id"] for task in tasks],
                    "model": "stub",
                    "reasoning_effort": "low",
                }
            ),
            encoding="utf-8",
        )

    def clone_experiment(self, experiment: Path, name: str) -> Path:
        clone = self.root / "clones" / name
        clone.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(experiment, clone)
        return clone

    def valid_experiment(self, name: str, plan: dict | None = None):
        assets = self.make_assets(name)
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub(name + "-stub")
        completed = self.run_command(
            stub,
            experiment,
            plan=plan or self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        return assets, experiment, stub

    def run_command(
        self,
        stub: SimpleNamespace,
        experiment: Path,
        *,
        plan: dict,
        statuses: dict,
        tasks=(TASK,),
        extra=(),
        agent_timeout: int = 30,
    ) -> subprocess.CompletedProcess:
        return self.cli(
            [
                "run",
                "--experiment",
                experiment,
                "--tasks",
                *[task["id"] for task in tasks],
                "--arms",
                "baseline",
                "--repeats",
                "1",
                "--concurrency",
                "1",
                "--agent-timeout",
                agent_timeout,
                "--test-timeout",
                "30",
                "--codex-bin",
                stub.launcher,
                *extra,
            ],
            env=self.environment(stub, plan, statuses),
        )

    def result(self, experiment: Path, task: dict = TASK) -> dict:
        path = (
            experiment
            / "runs"
            / task["id"]
            / "baseline"
            / "r1"
            / "result.json"
        )
        return json.loads(path.read_text(encoding="utf-8"))

    def run_path(self, experiment: Path, task: dict = TASK) -> Path:
        return experiment / "runs" / task["id"] / "baseline" / "r1"

    def complete_plan(self, content: str = "VALUE = 2\n") -> dict:
        return {
            "events": 2,
            "agent_messages": ["Implemented the fix."],
            "mutations": [{"path": "src/mod.py", "content": content}],
        }

    # -- setup -----------------------------------------------------------
    def test_setup_installs_usable_assets(self) -> None:
        assets = self.make_assets("setup")
        stub = self.make_stub("setup-stub")
        experiment = assets.root / "experiment"
        completed = self.cli(
            [
                "setup",
                "--dataset",
                assets.dataset,
                "--templates",
                assets.templates,
                "--venvs",
                assets.venvs,
                "--experiment",
                experiment,
                "--tasks",
                TASK["id"],
            ],
            env=os.environ.copy(),
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(
            (experiment / "dataset.json").read_text(encoding="utf-8"),
            assets.dataset.read_text(encoding="utf-8"),
        )
        template = experiment / "templates" / f"{TASK['id']}.tar"
        venv = experiment / "venvs" / TASK["id"]
        self.assertEqual(template.resolve(), (assets.templates / template.name).resolve())
        self.assertTrue((venv / "bin" / "python").exists())
        self.assertTrue(template.read_bytes())

        write_baseline(experiment, TASK)
        run = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertTrue(self.result(experiment)["resolved"])

    # -- template extraction security -----------------------------------
    def test_template_extraction_rejects_escape_members(self) -> None:
        outside = self.root / "outside-target.txt"

        def escaped_member(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_file(archive, "../escape.txt", "escaped\n")

        def absolute_member(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_file(archive, str(self.root / "abs-escaped.txt"), "escaped\n")

        def absolute_symlink(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_link(archive, "abs-link", str(outside))

        def escaping_symlink(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_link(archive, "rel-link", "../rel-target.txt")

        def escaping_hardlink(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_link(archive, "hard-link", "../../outside-hard.txt", hard=True)

        def chained_symlink(path: Path) -> None:
            # Both link targets are lexically inside, but `a` resolves to the
            # destination itself, so `a/..` is its parent and `b/pwn` escapes.
            with tarfile.open(path, "w") as archive:
                add_link(archive, "a", ".")
                add_link(archive, "b", "a/..")
                add_file(archive, "b/pwn", "pwn\n")

        cases = (
            ("member escape", escaped_member, "escape.txt"),
            ("absolute member", absolute_member, "abs-escaped.txt"),
            ("absolute symlink", absolute_symlink, "outside-target.txt"),
            ("escaping symlink", escaping_symlink, "rel-target.txt"),
            ("escaping hardlink", escaping_hardlink, "outside-hard.txt"),
            ("chained symlink", chained_symlink, "pwn"),
        )
        for label, writer, escaped_name in cases:
            with self.subTest(case=label):
                name = label.replace(" ", "-")
                assets = self.make_assets(name, template=writer)
                experiment = self.install_experiment(assets, "experiment")
                stub = self.make_stub(name + "-stub")
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=self.complete_plan(),
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
                self.assertIn("unsafe tar", completed.stdout)
                run_path = self.run_path(experiment)
                self.assertFalse(
                    (self.root / escaped_name).exists(),
                    f"{label} created {self.root / escaped_name}",
                )
                self.assertFalse((run_path / escaped_name).exists())
                self.assertFalse((run_path / "repo" / escaped_name).exists())

    def test_read_only_template_directories_stay_usable(self) -> None:
        assets = self.make_assets("read-only", template=read_only_template)
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("read-only-stub")
        completed = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        repo = self.run_path(experiment) / "repo"
        package = repo / "pkg"
        nested = package / "nested"
        self.assertEqual((package / "data.txt").read_text(encoding="utf-8"), "readable\n")
        self.assertEqual((nested / "inner.txt").read_text(encoding="utf-8"), "inner\n")
        self.assertEqual(stat.S_IMODE(package.stat().st_mode), 0o555)
        self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o500)

    # -- protected modes -------------------------------------------------
    def test_protection_refuses_experiment_directory_and_ancestors(self) -> None:
        assets = self.make_assets("protect-refuse")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("protect-refuse-stub")
        for label, target in (
            ("experiment directory", experiment),
            ("ancestor directory", assets.root),
        ):
            with self.subTest(case=label):
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=self.complete_plan(),
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                    extra=("--protect-paths", target),
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("refusing to protect", completed.stdout)
                self.assertFalse((experiment / "protected-modes.json").exists())
                self.assertTrue((experiment / "dataset.json").exists())

    def test_protection_locks_during_run_and_restores_afterwards(self) -> None:
        assets = self.make_assets("protect-normal")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("protect-normal-stub")
        protected = assets.root / "protected.txt"
        protected.write_text("keep\n", encoding="utf-8")
        protected.chmod(0o644)
        mode_during = assets.root / "mode-during.txt"
        plan = self.complete_plan()
        plan["mode_probes"] = [
            {"path": str(protected), "output": str(mode_during)}
        ]
        completed = self.run_command(
            stub,
            experiment,
            plan=plan,
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            extra=("--protect-paths", protected),
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(mode_during.read_text(encoding="utf-8").strip(), "0")
        self.assertEqual(stat.S_IMODE(protected.stat().st_mode), 0o644)
        self.assertFalse((experiment / "protected-modes.json").exists())

    def test_interrupted_run_restores_modes_on_next_start(self) -> None:
        assets = self.make_assets(
            "protect-interrupted", tasks=(TASK, TASK2)
        )
        experiment = self.install_experiment(
            assets, "experiment", tasks=(TASK, TASK2)
        )
        stub = self.make_stub("protect-interrupted-stub")
        protected = assets.root / "protected.txt"
        protected.write_text("keep\n", encoding="utf-8")
        protected.chmod(0o644)
        stub_pid_file = assets.root / "stub.pid"
        plan = {
            "sleep_seconds": 3,
            "pid_file": str(stub_pid_file),
        }
        env = self.environment(
            stub,
            plan,
            {TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        command = [
            sys.executable,
            "-B",
            str(RUN),
            "run",
            "--experiment",
            str(experiment),
            "--tasks",
            TASK["id"],
            "--arms",
            "baseline",
            "--repeats",
            "1",
            "--concurrency",
            "1",
            "--agent-timeout",
            "60",
            "--test-timeout",
            "30",
            "--codex-bin",
            str(stub.launcher),
            "--protect-paths",
            str(protected),
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        try:
            locked = wait_until(
                lambda: stub_pid_file.exists()
                and stat.S_IMODE(protected.stat().st_mode) == 0,
                timeout=20,
            )
            self.assertTrue(locked, "protected path was never locked")
            self.assertTrue((experiment / "protected-modes.json").exists())
            process.kill()
            process.wait(timeout=20)
        finally:
            if process.poll() is None:
                process.kill()
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(stat.S_IMODE(protected.stat().st_mode), 0)
        self.assertTrue((experiment / "protected-modes.json").exists())
        stub_pid = int(stub_pid_file.read_text(encoding="utf-8").strip())
        self.assertTrue(wait_until(lambda: not alive(stub_pid), timeout=20))

        completed = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK2["f2p"]: "PASSED", TASK2["p2p"]: "PASSED"},
            tasks=(TASK2,),
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(stat.S_IMODE(protected.stat().st_mode), 0o644)
        self.assertFalse((experiment / "protected-modes.json").exists())
        self.assertTrue(self.result(experiment, TASK2)["resolved"])

    # -- run grading -----------------------------------------------------
    def test_run_records_resolved_result_and_artifacts(self) -> None:
        assets = self.make_assets("run-normal")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("run-normal-stub")
        completed = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        result = self.result(experiment)
        self.assertTrue(result["resolved"])
        self.assertTrue(result["f2p_pass"])
        self.assertEqual(result["p2p_regressions"], [])
        self.assertEqual(result["test_statuses"][TASK["p2p"]], "PASSED")
        run_path = self.run_path(experiment)
        self.assertTrue((run_path / "grade" / "junit.xml").is_file())
        self.assertIn("src/mod.py", (run_path / "agent.patch").read_text(encoding="utf-8"))

    def test_run_writes_invalid_result_for_broken_invocations(self) -> None:
        cases = (
            (
                "missing turn.completed",
                {"events": 2, "agent_messages": ["x"], "invalid_events": "missing_turn_completed"},
                "turn.completed is missing",
                30,
            ),
            (
                "nonzero exit",
                {"events": 2, "agent_messages": ["x"], "exit_code": 7},
                "returncode=7",
                30,
            ),
            (
                "timeout",
                {"sleep_seconds": 30},
                "agent timed out",
                1,
            ),
        )
        for label, plan, reason, agent_timeout in cases:
            with self.subTest(case=label):
                name = label.replace(" ", "-").replace(".", "")
                assets = self.make_assets("invalid-" + name)
                experiment = self.install_experiment(assets, "experiment")
                stub = self.make_stub("invalid-" + name + "-stub")
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=plan,
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                    agent_timeout=agent_timeout,
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
                invalid = json.loads(
                    (
                        self.run_path(experiment) / "invalid-result.json"
                    ).read_text(encoding="utf-8")
                )
                self.assertIn(reason, invalid["reason"])
                self.assertFalse(
                    (self.run_path(experiment) / "result.json").exists()
                )

    def test_run_reports_p2p_regressions(self) -> None:
        assets = self.make_assets("run-regression")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("run-regression-stub")
        completed = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "FAILED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        result = self.result(experiment)
        self.assertFalse(result["resolved"])
        self.assertEqual(result["p2p_regressions"], [TASK["p2p"]])

    # -- summarize -------------------------------------------------------
    def test_summarize_reports_every_arm_rate_and_sample_count(self) -> None:
        assets = self.make_assets("summarize")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("summarize-stub")
        run = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(run.returncode, 0, run.stdout)
        completed = self.cli(
            ["summarize", "--experiment", experiment],
            env=os.environ.copy(),
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        report = (experiment / "report.md").read_text(encoding="utf-8")
        self.assertIn("resolved rate", report)
        self.assertIn("| baseline | 1 | 1 | 100.0% |", report)
        self.assertIn("| demo__task-1 | 1/1 |", report)
        summary = json.loads(
            (experiment / "summary.json").read_text(encoding="utf-8")
        )
        self.assertEqual(summary["baseline"]["runs"], 1)
        self.assertEqual(summary["baseline"]["resolved_rate"], 1.0)
        self.assertTrue((experiment / "results.jsonl").is_file())



    # -- F1: stored-result and asset rejection ---------------------------
    def test_summarize_and_attribution_reject_corrupt_results(self) -> None:
        plan = {
            "events": 3,
            "agent_messages": ["采用 quick，先核对影响面。", "Implemented."],
            "mutations": [{"path": "src/mod.py", "content": "VALUE = 2\n"}],
        }
        _, experiment, _ = self.valid_experiment("corrupt-results", plan)

        def result_file(root: Path) -> Path:
            return root / "runs" / TASK["id"] / "baseline" / "r1" / "result.json"

        def load(root: Path) -> dict:
            return json.loads(result_file(root).read_text(encoding="utf-8"))

        def store(root: Path, value: dict) -> None:
            result_file(root).write_text(json.dumps(value), encoding="utf-8")

        def rename_arm(root: Path) -> None:
            source = root / "runs" / TASK["id"] / "baseline"
            source.rename(source.parent / "easydev")

        def rename_repeat(root: Path) -> None:
            source = root / "runs" / TASK["id"] / "baseline" / "r1"
            source.rename(source.parent / "r2")

        def drop_turn_completed(root: Path) -> None:
            events = root / "runs" / TASK["id"] / "baseline" / "r1" / "events.jsonl"
            kept = [
                line
                for line in events.read_text(encoding="utf-8").splitlines()
                if '"turn.completed"' not in line
            ]
            events.write_text("\n".join(kept) + "\n", encoding="utf-8")

        def bump_events(root: Path) -> None:
            value = load(root)
            value["events"] = int(value["events"]) + 1
            store(root, value)

        def mismatch_task(root: Path) -> None:
            value = load(root)
            value["task_id"] = "another-task"
            store(root, value)

        def mismatch_repeat(root: Path) -> None:
            value = load(root)
            value["repeat"] = 2
            store(root, value)

        def drop_protocol(root: Path) -> None:
            value = load(root)
            value.pop("result_protocol")
            store(root, value)

        def old_protocol(root: Path) -> None:
            value = load(root)
            value["result_protocol"] = 1
            store(root, value)

        def p2p_contradiction(root: Path) -> None:
            value = load(root)
            value["test_statuses"][TASK["p2p"]] = "FAILED"
            store(root, value)

        def f2p_contradiction(root: Path) -> None:
            value = load(root)
            value["f2p_status"][TASK["f2p"]] = "FAILED"
            store(root, value)

        cases = (
            ("directory arm mismatch", rename_arm),
            ("directory repeat mismatch", rename_repeat),
            ("result task_id mismatch", mismatch_task),
            ("result repeat mismatch", mismatch_repeat),
            ("event count mismatch", bump_events),
            (
                "missing events file",
                lambda root: (
                    root
                    / "runs"
                    / TASK["id"]
                    / "baseline"
                    / "r1"
                    / "events.jsonl"
                ).unlink(),
            ),
            ("missing turn.completed", drop_turn_completed),
            ("missing protocol", drop_protocol),
            ("old protocol", old_protocol),
            ("resolved with failed p2p", p2p_contradiction),
            ("f2p_pass with failed f2p", f2p_contradiction),
        )
        for label, mutate in cases:
            with self.subTest(case=label):
                clone = self.clone_experiment(
                    experiment, "corrupt-" + label.replace(" ", "-")
                )
                mutate(clone)
                completed = self.summarize(clone)
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
                self.assertIn("no completed runs", completed.stdout)
                if label == "missing events file":
                    # discover_runs requires events.jsonl, so the attribution
                    # CLI reports the run directory as absent instead of valid.
                    attributed = subprocess.run(
                        [
                            sys.executable,
                            "-B",
                            str(SWEBENCH / "analyze_events.py"),
                            "--experiment",
                            str(clone),
                            "--format",
                            "json",
                        ],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        errors="replace",
                        timeout=60,
                        env=os.environ.copy(),
                    )
                    self.assertNotEqual(attributed.returncode, 0)
                    self.assertIn("no runs with events.jsonl", attributed.stdout)
                    continue
                payload = self.attribution(clone)
                run = payload["runs"][0]
                self.assertFalse(run["result_valid"], (label, run))
                self.assertEqual(run["declared_initial_path"], "quick")
        historical_clone = self.clone_experiment(experiment, "corrupt-historical")
        drop_protocol(historical_clone)
        historical = self.attribution(historical_clone)["runs"][0]
        self.assertFalse(historical["result_valid"])
        self.assertTrue(historical["historical_resolved"])

    def test_summarize_fails_closed_on_dataset_and_baseline_damage(self) -> None:
        _, experiment, _ = self.valid_experiment("asset-damage")

        def remove_baseline(root: Path) -> None:
            (root / "task-baselines" / f"{TASK['id']}.json").unlink()

        def corrupt_dataset(root: Path) -> None:
            (root / "dataset.json").write_text("{not json", encoding="utf-8")

        def remove_dataset(root: Path) -> None:
            (root / "dataset.json").unlink()

        def inconsistent_baseline(root: Path) -> None:
            path = root / "task-baselines" / f"{TASK['id']}.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value["eligible_p2p"] = []
            path.write_text(json.dumps(value), encoding="utf-8")

        cases = (
            ("missing baseline", remove_baseline),
            ("corrupt dataset", corrupt_dataset),
            ("missing dataset", remove_dataset),
            ("inconsistent baseline", inconsistent_baseline),
        )
        for label, mutate in cases:
            with self.subTest(case=label):
                clone = self.clone_experiment(
                    experiment, "damage-" + label.replace(" ", "-")
                )
                mutate(clone)
                completed = self.summarize(clone)
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
        with self.subTest(case="non-contract baseline status"):
            clone = self.clone_experiment(experiment, "damage-extra-status")
            path = clone / "task-baselines" / f"{TASK['id']}.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value["statuses"]["tests/test_extra.py::test_extra"] = "PASSED"
            path.write_text(json.dumps(value), encoding="utf-8")
            completed = self.summarize(clone)
            self.assertEqual(completed.returncode, 0, completed.stdout)

    def test_manifest_selection_report_counts_and_stray_runs(self) -> None:
        tasks = (TASK, TASK2, TASK3, TASK4, TASK5)
        extra_task = {
            "id": "demo__extra",
            "f2p": TASK["f2p"],
            "p2p": TASK["p2p"],
        }
        assets = self.make_assets("manifest", tasks=tasks)
        experiment = self.install_experiment(assets, "experiment", tasks=tasks)
        stub = self.make_stub("manifest-stub")
        for task in (TASK, TASK2):
            completed = self.run_command(
                stub,
                experiment,
                plan=self.complete_plan(),
                statuses={task["f2p"]: "PASSED", task["p2p"]: "PASSED"},
                tasks=(task,),
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
        self.write_manifest(experiment, tasks)

        # Dataset rows outside the manifest: one never runs (needs no baseline),
        # the other later gains a run and must still be baseline-checked.
        dataset = json.loads(
            (experiment / "dataset.json").read_text(encoding="utf-8")
        )
        for task_id, statement in (
            ("demo__unused", "unused"),
            (extra_task["id"], "outside manifest"),
        ):
            dataset.append(
                {
                    "instance_id": task_id,
                    "repo": "demo/repo",
                    "FAIL_TO_PASS": json.dumps([TASK["f2p"]]),
                    "PASS_TO_PASS": json.dumps([TASK["p2p"]]),
                    "patch": "",
                    "test_patch": TEST_PATCH,
                    "problem_statement": statement,
                }
            )
        (experiment / "dataset.json").write_text(
            json.dumps(dataset), encoding="utf-8"
        )
        completed = self.summarize(experiment)
        self.assertEqual(completed.returncode, 0, completed.stdout)
        report = (experiment / "report.md").read_text(encoding="utf-8")
        self.assertIn("任务数：2", report)
        self.assertIn("校准清单：5 个任务", report)
        self.assertIn(f"| {TASK['id']} | 1/1 |", report)
        self.assertIn(f"| {TASK2['id']} | 1/1 |", report)
        self.assertNotIn(TASK3["id"], report)

        stray = experiment / "runs" / TASK["id"] / "baseline" / "rfoo"
        stray.mkdir(parents=True)
        (stray / "events.jsonl").write_text(
            json.dumps({"type": "turn.completed", "usage": {}}) + "\n",
            encoding="utf-8",
        )
        (stray / "result.json").write_text("{}", encoding="utf-8")
        completed = self.summarize(experiment)
        self.assertEqual(completed.returncode, 0, completed.stdout)
        summary = json.loads((experiment / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["baseline"]["runs"], 2)

        extra = experiment / "runs" / TASK3["id"] / "baseline" / "r1"
        shutil.copytree(experiment / "runs" / TASK["id"] / "baseline" / "r1", extra)
        result = json.loads((extra / "result.json").read_text(encoding="utf-8"))
        result.update({"task_id": TASK3["id"]})
        (extra / "result.json").write_text(json.dumps(result), encoding="utf-8")
        completed = self.summarize(experiment)
        self.assertEqual(completed.returncode, 0, completed.stdout)
        report = (experiment / "report.md").read_text(encoding="utf-8")
        self.assertIn(f"| {TASK3['id']} | 1/1 |", report)

        # A run outside the manifest is still selected and counted, and its
        # baseline contract is still enforced (fail closed).
        write_baseline(experiment, extra_task)
        outside = experiment / "runs" / extra_task["id"] / "baseline" / "r1"
        shutil.copytree(experiment / "runs" / TASK["id"] / "baseline" / "r1", outside)
        result = json.loads((outside / "result.json").read_text(encoding="utf-8"))
        result.update({"task_id": extra_task["id"]})
        (outside / "result.json").write_text(json.dumps(result), encoding="utf-8")
        completed = self.summarize(experiment)
        self.assertEqual(completed.returncode, 0, completed.stdout)
        report = (experiment / "report.md").read_text(encoding="utf-8")
        self.assertIn(f"| {extra_task['id']} | 1/1 |", report)
        self.assertIn("任务数：4", report)
        summary = json.loads((experiment / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["baseline"]["runs"], 4)

        (experiment / "task-baselines" / f"{extra_task['id']}.json").unlink()
        completed = self.summarize(experiment)
        self.assertNotEqual(completed.returncode, 0, completed.stdout)
        self.assertIn(extra_task["id"], completed.stdout)

    def test_rerun_skips_valid_result_without_calling_codex(self) -> None:
        marker = self.root / "codex-invocations.txt"
        plan = self.complete_plan()
        plan["marker_file"] = str(marker)
        assets = self.make_assets("idempotent")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("idempotent-stub")
        for _ in range(2):
            completed = self.run_command(
                stub,
                experiment,
                plan=plan,
                statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(len(marker.read_text(encoding="utf-8").splitlines()), 1)

    # -- F2: protected mode recovery -------------------------------------
    def test_restart_keeps_a_mode_the_user_tightened(self) -> None:
        assets = self.make_assets("tightened")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("tightened-stub")
        sentinel = assets.root / "sentinel.txt"
        sentinel.write_text("keep\n", encoding="utf-8")
        sentinel.chmod(0o600)
        (experiment / "protected-modes.json").write_text(
            json.dumps({str(sentinel): 0o644}), encoding="utf-8"
        )
        completed = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0o600)

        # No record at all: the run must keep the current non-default mode.
        sentinel.chmod(0o640)
        shutil.rmtree(experiment / "runs" / TASK["id"])
        mode_during = assets.root / "mode-during.txt"
        plan = self.complete_plan()
        plan["mode_probes"] = [
            {"path": str(sentinel), "output": str(mode_during)}
        ]
        completed = self.run_command(
            stub,
            experiment,
            plan=plan,
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            extra=("--protect-paths", sentinel),
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(mode_during.read_text(encoding="utf-8").strip(), "0")
        self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0o640)

    def test_damaged_or_linked_records_fail_without_chmod(self) -> None:
        cases = (
            ("invalid json", "{not json"),
            ("not an object", json.dumps(["/tmp/x"])),
            ("non-integer mode", json.dumps({"/tmp/x": "0644"})),
            ("boolean mode", json.dumps({"/tmp/x": True})),
            ("out-of-range mode", json.dumps({"/tmp/x": 0o1000})),
            ("relative path", json.dumps({"dataset.json": 0o644})),
        )
        for label, payload in cases:
            with self.subTest(case=label):
                assets = self.make_assets("record-" + label.replace(" ", "-"))
                experiment = self.install_experiment(assets, "experiment")
                stub = self.make_stub("record-" + label.replace(" ", "-") + "-stub")
                sentinel = assets.root / "sentinel.txt"
                sentinel.write_text("keep\n", encoding="utf-8")
                sentinel.chmod(0o640)
                record = experiment / "protected-modes.json"
                record.write_text(payload, encoding="utf-8")
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=self.complete_plan(),
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
                self.assertIn("protected-modes.json", completed.stdout)
                self.assertIn("chmod", completed.stdout)
                self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0o640)
                self.assertTrue(record.exists())

        with self.subTest(case="parent component with valid entry first"):
            assets = self.make_assets("record-parent-component")
            experiment = self.install_experiment(assets, "experiment")
            stub = self.make_stub("record-parent-component-stub")
            sentinel = assets.root / "sentinel.txt"
            sentinel.write_text("keep\n", encoding="utf-8")
            sentinel.chmod(0)
            padding = assets.root / "pad1" / "pad2"
            padding.mkdir(parents=True)
            devious = str(padding / ".." / "..") + "/private"
            (experiment / "protected-modes.json").write_text(
                json.dumps({str(sentinel): 0o644, devious: 0o755}),
                encoding="utf-8",
            )
            completed = self.run_command(
                stub,
                experiment,
                plan=self.complete_plan(),
                statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            )
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
            self.assertIn(devious, completed.stdout)
            self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0)

        for label, target_payload, dangling in (
            ("valid symlink", "{}", False),
            ("dangling symlink", None, True),
        ):
            with self.subTest(case=label):
                assets = self.make_assets("record-" + label.replace(" ", "-"))
                experiment = self.install_experiment(assets, "experiment")
                stub = self.make_stub("record-" + label.replace(" ", "-") + "-stub")
                sentinel = assets.root / "sentinel.txt"
                sentinel.write_text("keep\n", encoding="utf-8")
                sentinel.chmod(0o640)
                outside = assets.root / "outside-record.json"
                record = experiment / "protected-modes.json"
                if dangling:
                    record.symlink_to(outside)
                else:
                    outside.write_text(target_payload, encoding="utf-8")
                    outside.chmod(0o640)
                    record.symlink_to(outside)
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=self.complete_plan(),
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
                self.assertIn(str(record), completed.stdout)
                self.assertIn(
                    "refusing to use the protected mode record", completed.stdout
                )
                self.assertIn("symlink", completed.stdout)
                self.assertTrue(record.is_symlink())
                self.assertEqual(os.readlink(record), str(outside))
                self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0o640)
                if dangling:
                    self.assertFalse(outside.exists())
                    self.assertFalse(record.exists())
                else:
                    self.assertEqual(
                        outside.read_text(encoding="utf-8"), target_payload
                    )
                    self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o640)

    def test_restore_order_parent_child_and_merged_protection(self) -> None:
        assets = self.make_assets("restore-order")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("restore-order-stub")
        private = assets.root / "private"
        nested = private / "data"
        nested.mkdir(parents=True)
        private.chmod(0o755)
        nested.chmod(0o750)
        (experiment / "protected-modes.json").write_text(
            json.dumps({str(nested): 0o750, str(private): 0o755}),
            encoding="utf-8",
        )
        nested.chmod(0)
        private.chmod(0)
        completed = self.run_command(
            stub,
            experiment,
            plan=self.complete_plan(),
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o750)

        shutil.rmtree(experiment / "runs" / TASK["id"])
        observed_record = assets.root / "record-during-run.json"
        plan = self.complete_plan()
        plan["file_probes"] = [
            {
                "path": str(experiment / "protected-modes.json"),
                "output": str(observed_record),
            }
        ]
        completed = self.run_command(
            stub,
            experiment,
            plan=plan,
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            extra=("--protect-paths", private, nested),
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        recorded = json.loads(observed_record.read_text(encoding="utf-8"))
        selected = [
            entry
            for entry in recorded
            if entry == str(private.resolve())
            or entry.startswith(str(private.resolve()) + os.sep)
        ]
        self.assertEqual(selected, [str(private.resolve())])
        self.assertEqual(recorded[str(private.resolve())], 0o755)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(nested.stat().st_mode), 0o750)

    def test_failed_run_restores_modes_and_keeps_record(self) -> None:
        assets = self.make_assets("failed-run")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("failed-run-stub")
        sentinel = assets.root / "sentinel.txt"
        sentinel.write_text("keep\n", encoding="utf-8")
        sentinel.chmod(0o640)
        completed = self.run_command(
            stub,
            experiment,
            plan={"events": 2, "agent_messages": ["x"], "invalid_events": "missing_turn_completed"},
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            extra=("--protect-paths", sentinel),
        )
        self.assertNotEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0o640)
        self.assertTrue((experiment / "protected-modes.json").exists())

    def test_restart_from_another_cwd_only_restores_recorded_paths(self) -> None:
        assets = self.make_assets("cwd-restart")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("cwd-restart-stub")
        original = assets.root / "original" / "dataset.json"
        original.parent.mkdir()
        original.write_text("{}", encoding="utf-8")
        original.chmod(0)
        decoy_dir = assets.root / "decoy"
        decoy_dir.mkdir()
        decoy = decoy_dir / "dataset.json"
        decoy.write_text("{}", encoding="utf-8")
        decoy.chmod(0o600)
        (experiment / "protected-modes.json").write_text(
            json.dumps({str(original): 0o644}), encoding="utf-8"
        )
        completed = self.cli(
            [
                "run",
                "--experiment",
                experiment,
                "--tasks",
                TASK["id"],
                "--arms",
                "baseline",
                "--repeats",
                "1",
                "--concurrency",
                "1",
                "--codex-bin",
                stub.launcher,
            ],
            env=self.environment(
                stub,
                self.complete_plan(),
                {TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            ),
            cwd=decoy_dir,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(decoy.stat().st_mode), 0o600)

    # -- F3: capture does not execute Agent Git config -------------------
    def test_capture_patch_does_not_execute_agent_hook_or_filter(self) -> None:
        marker = self.root / "swe-hook-or-filter-ran.txt"
        filter_script = self.root / "swe-clean-filter.sh"
        filter_script.write_text(
            "#!/bin/sh\n"
            f"printf ran > {str(marker)!r}\n"
            "cat\n",
            encoding="utf-8",
        )
        filter_script.chmod(0o755)
        hook = self.root / "swe-post-index-change.sh"
        hook.write_text(
            "#!/bin/sh\n"
            f"printf ran > {str(marker)!r}\n"
            "printf 'VALUE = 99\n' > src/mod.py\n",
            encoding="utf-8",
        )
        plan = self.complete_plan()
        plan["append_files"] = [
            {
                "path": ".git/config",
                "content": (
                    '\n[filter "agent-clean"]\n'
                    f"\tclean = {filter_script}\n"
                ),
            },
            {"path": ".git/info/attributes", "content": "*.py filter=agent-clean\n"},
        ]
        plan["mutations"].append(
            {
                "path": ".git/hooks/post-index-change",
                "content": hook.read_text(encoding="utf-8"),
            }
        )
        plan["chmod_files"] = [
            {"path": ".git/hooks/post-index-change", "mode": 0o755}
        ]
        assets = self.make_assets("capture-protection")
        experiment = self.install_experiment(assets, "experiment")
        stub = self.make_stub("capture-protection-stub")
        completed = self.run_command(
            stub,
            experiment,
            plan=plan,
            statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertFalse(marker.exists(), "capture executed an Agent hook or filter")
        patch = (self.run_path(experiment) / "agent.patch").read_text(encoding="utf-8")
        self.assertIn("+VALUE = 2", patch)
        self.assertNotIn("VALUE = 99", patch)
        config = (self.run_path(experiment) / "repo" / ".git" / "config").read_text(
            encoding="utf-8"
        )
        self.assertIn("agent-clean", config)

    # -- matrix: allowed links, attributes and directory escape ----------
    def test_template_allows_inside_links_and_subdirectory_symlink(self) -> None:
        def symlink_template(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_file(archive, "target.txt", "content\n")
                add_link(archive, "link.txt", "target.txt")

        def hardlink_template(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_file(archive, "a.txt", "content\n")
                add_link(archive, "b.txt", "a.txt", hard=True)

        def subdir_template(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_file(archive, "target.txt", "content\n")
                add_dir(archive, "sub")
                add_link(archive, "sub/link", "../target.txt")

        cases = (
            ("inside symlink", symlink_template),
            ("inside hardlink", hardlink_template),
            ("subdir relative symlink", subdir_template),
        )
        for label, writer in cases:
            with self.subTest(case=label):
                assets = self.make_assets(
                    "links-" + label.replace(" ", "-"), template=writer
                )
                experiment = self.install_experiment(assets, "experiment")
                stub = self.make_stub("links-" + label.replace(" ", "-") + "-stub")
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=self.complete_plan(),
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                )
                self.assertEqual(completed.returncode, 0, completed.stdout)
                repo = self.run_path(experiment) / "repo"
                if label == "inside symlink":
                    link = repo / "link.txt"
                    self.assertTrue(link.is_symlink())
                    self.assertEqual(link.read_text(encoding="utf-8"), "content\n")
                elif label == "inside hardlink":
                    first = repo / "a.txt"
                    second = repo / "b.txt"
                    self.assertFalse(second.is_symlink())
                    self.assertEqual(second.read_text(encoding="utf-8"), "content\n")
                    self.assertEqual(first.stat().st_ino, second.stat().st_ino)
                else:
                    link = repo / "sub" / "link"
                    self.assertEqual(link.read_text(encoding="utf-8"), "content\n")

    def test_template_rejects_directory_escape_and_hardlink_escape_keeps_target(self) -> None:
        external = self.root / "external-target.txt"
        external.write_text("keep\n", encoding="utf-8")

        def directory_escape(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_dir(archive, "../evil", 0o755)
                add_file(archive, "../evil/pwn", "pwn\n")

        def hardlink_escape(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_link(archive, "hard-link", str(external), hard=True)

        for label, writer in (
            ("directory escape", directory_escape),
            ("hardlink escape", hardlink_escape),
        ):
            with self.subTest(case=label):
                assets = self.make_assets(
                    "escape-" + label.replace(" ", "-"), template=writer
                )
                experiment = self.install_experiment(assets, "experiment")
                stub = self.make_stub("escape-" + label.replace(" ", "-") + "-stub")
                completed = self.run_command(
                    stub,
                    experiment,
                    plan=self.complete_plan(),
                    statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout)
                self.assertIn("unsafe tar", completed.stdout)
                self.assertFalse((self.run_path(experiment).parent / "evil").exists())
                self.assertEqual(external.read_text(encoding="utf-8"), "keep\n")

    def test_template_reversed_chain_and_delayed_directory_attributes(self) -> None:
        def reversed_chain(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_file(archive, "b/pwn", "pwn\n")
                add_link(archive, "a", ".")
                add_link(archive, "b", "a/..")

        def delayed_attributes(path: Path) -> None:
            # `u/sub` is first created at repo/base/sub (u -> base), then `u`
            # is retargeted through `x` to the real directory `v`, so `u/sub`
            # later resolves to repo/v/sub. The delayed attribute call must
            # still land on the creation-resolved path repo/base/sub. The
            # initial target cannot be the destination root: tarfile's
            # data_filter (3.12+) rejects re-extracting a symlink that already
            # resolves to the destination itself, so `base` is a real
            # in-destination directory instead of ".".
            with tarfile.open(path, "w") as archive:
                add_dir(archive, "v/sub", 0o750, mtime=1_900_000_000)
                add_dir(archive, "v", 0o750, mtime=1_800_000_000)
                add_link(archive, "u", "base")
                add_dir(archive, "u/sub", 0o500, mtime=1_700_000_000)
                add_link(archive, "u", "x")
                add_link(archive, "x", "v")

        def escaping_redirect(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_link(archive, "u", ".")
                add_link(archive, "u", "x/..")
                add_link(archive, "x", ".")
                add_file(archive, "u/evil", "pwn\n")

        def child_before_parent(path: Path) -> None:
            with tarfile.open(path, "w") as archive:
                add_dir(archive, "parent/child", 0o500)
                add_dir(archive, "parent", 0o400)
                add_file(archive, "parent/child/file.txt", "nested\n")

        with self.subTest(case="reversed member order"):
            assets = self.make_assets("attrs-reversed", template=reversed_chain)
            experiment = self.install_experiment(assets, "experiment")
            stub = self.make_stub("attrs-reversed-stub")
            completed = self.run_command(
                stub,
                experiment,
                plan=self.complete_plan(),
                statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            )
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
            self.assertIn("unsafe tar", completed.stdout)
            self.assertFalse((self.run_path(experiment) / "pwn").exists())

        with self.subTest(case="escaping symlink redirect rejected"):
            assets = self.make_assets(
                "attrs-escape-redirect", template=escaping_redirect
            )
            experiment = self.install_experiment(assets, "experiment")
            stub = self.make_stub("attrs-escape-redirect-stub")
            external = self.root / "escape-sentinel.txt"
            external.write_text("keep\n", encoding="utf-8")
            completed = self.run_command(
                stub,
                experiment,
                plan=self.complete_plan(),
                statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            )
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
            # run.py enables filter="data" exactly when tarfile.data_filter
            # exists (3.12+); the stdlib filter rejects the retarget before
            # run.py's own member checks, while older Pythons reject the file
            # member that would be written through the escaped link.
            expected_reject = (
                "outside the destination"
                if hasattr(tarfile, "data_filter")
                else "unsafe tar"
            )
            self.assertIn(expected_reject, completed.stdout)
            self.assertFalse((self.run_path(experiment) / "evil").exists())
            self.assertEqual(external.read_text(encoding="utf-8"), "keep\n")

        with self.subTest(case="delayed attributes target the created path"):
            assets = self.make_assets("attrs-delayed", template=delayed_attributes)
            experiment = self.install_experiment(assets, "experiment")
            stub = self.make_stub("attrs-delayed-stub")
            repo = self.run_path(experiment) / "repo"
            outside = self.run_path(experiment) / "sub"
            outside.mkdir(parents=True)
            outside.chmod(0o750)
            os.utime(outside, (1_234_567, 1_234_567))
            completed = self.run_command(
                stub,
                experiment,
                plan=self.complete_plan(),
                statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            )
            self.assertEqual(completed.returncode, 0, completed.stdout)
            created = repo / "base" / "sub"
            redirect = repo / "v" / "sub"
            anchor = repo / "v"
            try:
                # The archived 0500 mode lands on the path resolved when the
                # directory was created, not on the path `u/sub` resolves to
                # after the later retarget.
                self.assertEqual(stat.S_IMODE(created.stat().st_mode), 0o500)
                self.assertEqual(stat.S_IMODE(redirect.stat().st_mode), 0o750)
                self.assertEqual(int(redirect.stat().st_mtime), 1_900_000_000)
                self.assertEqual(stat.S_IMODE(anchor.stat().st_mode), 0o750)
                self.assertEqual(int(anchor.stat().st_mtime), 1_800_000_000)
                self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o750)
                self.assertEqual(int(outside.stat().st_mtime), 1_234_567)
            finally:
                if created.exists():
                    created.chmod(0o755)

        with self.subTest(case="child directory attributes before parent"):
            assets = self.make_assets("attrs-child-first", template=child_before_parent)
            experiment = self.install_experiment(assets, "experiment")
            stub = self.make_stub("attrs-child-first-stub")
            completed = self.run_command(
                stub,
                experiment,
                plan=self.complete_plan(),
                statuses={TASK["f2p"]: "PASSED", TASK["p2p"]: "PASSED"},
            )
            # 0400 denies search, so git init fails after extraction; the modes
            # still prove the attribute order (the artifact under test).
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
            parent = self.run_path(experiment) / "repo" / "parent"
            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o400)
            parent.chmod(0o700)
            child = parent / "child"
            self.assertEqual(stat.S_IMODE(child.stat().st_mode), 0o500)
            parent.chmod(0o755)
            child.chmod(0o755)

    # -- matrix: calibrate and report ------------------------------------
    def test_calibrate_keeps_only_eligible_contract_p2p(self) -> None:
        p2p_pass = "tests/test_p2p.py::test_p2p_pass"
        p2p_skip = "tests/test_p2p.py::test_p2p_skip"
        p2p_fail = "tests/test_p2p.py::test_p2p_fail"
        extra = "tests/test_p2p.py::test_extra"
        assets = self.make_assets("calibrate")
        dataset = [
            {
                "instance_id": TASK["id"],
                "repo": "demo/repo",
                "FAIL_TO_PASS": json.dumps([TASK["f2p"]]),
                "PASS_TO_PASS": json.dumps([p2p_pass, p2p_skip, p2p_fail]),
                "patch": (
                    "diff --git a/src/mod.py b/src/mod.py\n"
                    "--- a/src/mod.py\n"
                    "+++ b/src/mod.py\n"
                    "@@ -1 +1 @@\n"
                    "-VALUE = 1\n"
                    "+VALUE = 2\n"
                ),
                "test_patch": TEST_PATCH,
                "problem_statement": "Fix the module.",
            }
        ]
        assets.dataset.write_text(json.dumps(dataset), encoding="utf-8")
        stub = self.make_stub("calibrate-stub")
        counter = stub.base / "pytest-counter.txt"
        baseline_statuses = {
            TASK["f2p"]: "FAILED",
            p2p_pass: "PASSED",
            p2p_skip: "SKIPPED",
            p2p_fail: "FAILED",
            extra: "PASSED",
        }
        gold_statuses = {
            TASK["f2p"]: "PASSED",
            p2p_pass: "PASSED",
            p2p_skip: "SKIPPED",
            p2p_fail: "FAILED",
        }
        env = self.environment(stub, {}, {})
        plan_path = stub.base / "codex-plan.json"
        plan_path.write_text(json.dumps({}), encoding="utf-8")
        pytest_plan = stub.base / "pytest-plan.json"
        pytest_plan.write_text(
            json.dumps(
                {
                    "sequence": [
                        {"statuses": baseline_statuses},
                        {"statuses": gold_statuses},
                    ],
                    "counter_file": str(counter),
                }
            ),
            encoding="utf-8",
        )
        out = assets.root / "calibrated"
        completed = self.cli(
            [
                "calibrate",
                "--dataset",
                assets.dataset,
                "--templates",
                assets.templates,
                "--venvs",
                assets.venvs,
                "--tasks",
                TASK["id"],
                "--out",
                out,
            ],
            env=env,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        baseline = json.loads(
            (out / "task-baselines" / f"{TASK['id']}.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(baseline["eligible_p2p"], sorted([p2p_pass, p2p_skip]))
        self.assertEqual(
            baseline["excluded_p2p"],
            [{"nodeid": p2p_fail, "status": "FAILED"}],
        )
        self.assertEqual(baseline["statuses"][extra], "PASSED")
        self.assertEqual(counter.read_text(encoding="utf-8").strip(), "2")
        self.assertTrue((out / "gold" / f"{TASK['id']}.json").exists())


if __name__ == "__main__":
    unittest.main()
