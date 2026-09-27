from pathlib import Path


def pytest_configure(config):
    """Use the fixture project for framework table cases unless explicitly overridden."""
    if config.getoption("--easytest-root") is None:
        config.option.easytest_root = str(Path(__file__).resolve().parent / "fixtures" / "project")
