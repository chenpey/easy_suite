"""Install the release wheel and business adapter in isolation; exercise offline entrypoints."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]

    with tempfile.TemporaryDirectory(prefix="easytest-wheel-") as directory:
        work = Path(directory)

        def run(*command: str) -> str:
            try:
                return subprocess.run(
                    command, cwd=work, check=True, text=True, capture_output=True,
                ).stdout
            except subprocess.CalledProcessError as error:
                print(error.stdout, file=sys.stderr)
                print(error.stderr, file=sys.stderr)
                raise

        build_dir = work / "dist"
        run(
            "uv",
            "build",
            "--wheel",
            "--out-dir",
            str(build_dir),
            str(root),
        )
        wheels = list(build_dir.glob(f"easytest-{version}-*.whl"))
        if len(wheels) != 1:
            raise RuntimeError(
                f"expected one EasyTest {version} wheel, found {len(wheels)}"
            )
        wheel = wheels[0]
        environment = work / ".venv"
        run("uv", "venv", "--python", sys.executable, str(environment))
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        cli = environment / ("Scripts/easytest.exe" if sys.platform == "win32" else "bin/easytest")
        run("uv", "pip", "install", "--python", str(python), str(wheel),
            str(root / "examples/business_handler"))
        run(str(python), "-c",
            "import easytest; from easytest.util.get_config import get_config; "
            "from importlib.resources import files; "
            f"assert easytest.__version__ == {version!r}; "
            "contract = files('easytest').joinpath('CONTRACT.md').read_text(); "
            "assert 'max_response_bytes' in contract; "
            "assert 'snapshot maintain' in contract; "
            "assert get_config('common', 'browser') == 'chrome'; "
            "assert not hasattr(easytest, 'send_http'); "
            "assert not hasattr(easytest, 'DictObject')")
        project = work / "project"
        run(str(cli), "init", str(project))
        runtime_path = project / "config/runtime.json"
        runtime = json.loads(runtime_path.read_text())
        runtime["snapshot_backend"] = "sqlite"
        runtime_path.write_text(json.dumps(runtime))
        run(str(cli), "compile", str(project / "cases"), "--check")
        run(str(cli), "validate", "--root", str(project))
        result = json.loads(run(str(cli), "run", "--root", str(project), "--fail-fast",
                                "--result", "artifacts/result.json"))
        assert result["status"] == "passed"
        assert result["data"]["summary"]["passed"] == 1
        assert json.loads((project / "artifacts/result.json").read_text()) == result
        assert (project / "artifacts/report.html").is_file()
        assert json.loads(run(str(cli), "snapshot", "check", "--root", str(project)))[
            "status"
        ] == "healthy"
        assert json.loads(run(
            str(cli), "snapshot", "maintain", "--root", str(project),
        ))["status"] == "maintained"
        run(str(python), "-m", "pytest", "-q", str(project / "test_cases.py"),
            "--easytest-root", str(project))
        business = json.loads(run(str(cli), "run", "--root",
                                  str(root / "examples/business_handler/project"), "--no-report"))
        assert business["status"] == "passed"
        print(f"EasyTest {version}: isolated wheel, contract, CLI, pytest and business adapter passed.")


if __name__ == "__main__":
    main()
