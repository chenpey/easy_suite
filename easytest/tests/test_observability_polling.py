from __future__ import annotations

import pytest

from easytest.runtime.observability import REDACTED, EventRecorder, redact
from easytest.runtime.polling import PollTimeoutError, poll


def test_redact_masks_secrets_and_hashes_pii() -> None:
    value = redact(
        {
            "Authorization": "Bearer secret",
            "user_id": "123456",
            "nested": '{"password":"secret","status":"ok"}',
            "error": "request failed: token=abc Authorization: Bearer xyz",
        }
    )

    assert value["Authorization"] == REDACTED
    assert value["nested"]["password"] == REDACTED
    assert value["nested"]["status"] == "ok"
    assert value["user_id"].startswith("<redacted:sha256:")
    assert value["error"] == (
        "request failed: token=***REDACTED*** Authorization: ***REDACTED***"
    )


def test_event_recorder_bounds_large_events() -> None:
    recorder = EventRecorder(max_event_length=100)

    event = recorder.emit("step.done", response={"body": "x" * 1000})

    assert event["truncated"] is True
    assert "payload_sha256" in event


@pytest.mark.parametrize("target", ["redact", "serialize", "logger", "stdout"])
def test_event_failures_do_not_change_execution_or_leak_values(monkeypatch, target):
    import json
    from unittest.mock import Mock

    logger = Mock()
    recorder = EventRecorder(emit_stdout=True, logger=logger)

    def fail(*_args, **_kwargs):
        raise OSError("password=hidden-value")

    if target == "redact":
        monkeypatch.setattr("easytest.runtime.observability.redact", fail)
    elif target == "serialize":
        monkeypatch.setattr("easytest.runtime.observability.json.dumps", fail)
    elif target == "logger":
        logger.info.side_effect = fail
    else:
        monkeypatch.setattr("builtins.print", fail)

    event = recorder.emit("step.done", password="hidden-value", output="safe")
    monkeypatch.undo()
    assert event["event"] == "step.done"
    assert "hidden-value" not in json.dumps(event)
    assert "hidden-value" not in str(logger.info.call_args_list)
    assert recorder.events == [event]
    if target in {"redact", "serialize"}:
        assert event["detail"] == "[REDACTED_DUE_TO_ERROR]"


def test_event_recorder_does_not_swallow_interrupt(monkeypatch):
    from unittest.mock import Mock

    logger = Mock()
    logger.info.side_effect = KeyboardInterrupt
    with pytest.raises(KeyboardInterrupt):
        EventRecorder(logger=logger).emit("step.done")


def test_poll_retries_selected_exceptions_and_returns_attempt_count() -> None:
    values = [ConnectionError("not ready"), {"status": "PENDING"}, {"status": "DONE"}]
    sleeps = []

    def operation():
        value = values.pop(0)
        if isinstance(value, Exception):
            raise value
        return value

    result = poll(
        operation,
        until=lambda value: value["status"] == "DONE",
        retry_exceptions=(ConnectionError,),
        timeout_seconds=10,
        interval_seconds=0.1,
        sleep=sleeps.append,
    )

    assert result.value == {"status": "DONE"}
    assert result.attempts == 3
    assert sleeps == [0.1, 0.1]


def test_poll_timeout_preserves_last_value() -> None:
    ticks = iter([0.0, 0.0, 1.0, 1.0])

    with pytest.raises(PollTimeoutError) as error:
        poll(
            lambda: {"status": "PENDING"},
            until=lambda value: value["status"] == "DONE",
            timeout_seconds=1,
            interval_seconds=1,
            clock=lambda: next(ticks),
            sleep=lambda _seconds: None,
        )

    assert error.value.last_value == {"status": "PENDING"}
