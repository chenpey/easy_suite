from pathlib import Path

import pytest

from easytest.executors.rpc import RpcExecutor
from easytest.executors.scenario import ScenarioExecutor
from easytest.executors.ui import UiExecutor
from easytest.models import Case, ExecutionResult, RunContext


@pytest.fixture(params=[RpcExecutor, ScenarioExecutor, UiExecutor])
def execute(request, tmp_path):
    case = Case("handler", "handler", "scenario", True, (), {}, None, "default", ())
    context = RunContext(case, tmp_path, "read", {})

    def run(value):
        executor = request.param({"call": lambda **_kwargs: value})
        return executor.execute("call", {}, {}, context)

    return run


@pytest.mark.parametrize("value", [
    {"output": "business-data", "status": "SUCCESS", "id": 7},
    {"output": {"nested": True}, "artifacts": "BUSINESS_FIELD"},
    {"output": None},
])
def test_handler_preserves_business_output_fields(execute, value):
    result = execute(value)
    assert result.output is value
    assert result.artifacts == {}


def test_handler_explicit_result_preserves_artifacts_and_metadata(execute):
    value = ExecutionResult("ui", "call", {"visible": True},
                            artifacts={"screenshot": Path("/tmp/page.png")},
                            metadata={"trace": "example"})
    assert execute(value) is value
