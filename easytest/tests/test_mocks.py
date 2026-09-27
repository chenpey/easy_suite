from __future__ import annotations

from pathlib import Path

import pytest

from easytest.config import ProjectConfig
from easytest.models import Case, RunContext
from easytest.runtime.mocks import MockEngine

ROOT = Path(__file__).resolve().parent / "fixtures" / "project"


def _context() -> RunContext:
    case = Case(
        id="mock.case",
        name="Mock case",
        case_type="scenario",
        enabled=True,
        tags=(),
        variables={},
        mock_profile=None,
        snapshot_profile="default",
        steps=(),
    )
    return RunContext(case=case, root=ROOT, run_mode="read", variables={})


def test_sequence_mock_advances_and_repeats_last() -> None:
    engine = MockEngine(ProjectConfig(ROOT))
    context = _context()
    spec = {"kind": "sequence", "values": [{"n": 1}, {"n": 2}]}

    outputs = [
        engine.apply(
            spec=spec,
            request={},
            context=context,
            executor="rpc",
            operation="rpc.calculate_limit",
            invocation_key="sequence",
        ).result.output
        for _ in range(3)
    ]

    assert outputs == [{"n": 1}, {"n": 2}, {"n": 2}]


def test_inject_mock_changes_request_without_short_circuiting() -> None:
    engine = MockEngine(ProjectConfig(ROOT))
    decision = engine.apply(
        spec={"kind": "inject", "request": {"headers": {"X-Fault": "1"}}},
        request={"headers": {"Accept": "application/json"}},
        context=_context(),
        executor="http",
        operation="http.get_profile",
        invocation_key="inject",
    )

    assert decision.result is None
    assert decision.request["headers"] == {
        "Accept": "application/json",
        "X-Fault": "1",
    }


def test_exception_mock_raises_configured_error() -> None:
    engine = MockEngine(ProjectConfig(ROOT))

    with pytest.raises(ConnectionError, match="offline"):
        engine.apply(
            spec={
                "kind": "exception",
                "exception": "ConnectionError",
                "message": "offline",
            },
            request={},
            context=_context(),
            executor="rpc",
            operation="rpc.calculate_limit",
            invocation_key="exception",
        )
