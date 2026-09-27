from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar


T = TypeVar("T")


@dataclass(frozen=True)
class PollResult:
    value: Any
    attempts: int
    elapsed_seconds: float


class PollTimeoutError(TimeoutError):
    def __init__(self, message: str, *, last_value: Any, attempts: int) -> None:
        super().__init__(message)
        self.last_value = last_value
        self.attempts = attempts


def poll(
    operation: Callable[[], T],
    *,
    until: Callable[[T], bool],
    reject: Callable[[T], bool] | None = None,
    timeout_seconds: float = 30,
    interval_seconds: float = 1,
    retry_exceptions: tuple[type[Exception], ...] = (),
    on_attempt: Callable[[int, T | None, Exception | None], None] | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> PollResult:
    if timeout_seconds < 0 or interval_seconds < 0:
        raise ValueError("poll timeout and interval must be non-negative")

    started = clock()
    attempts = 0
    last_value: T | None = None
    last_error: Exception | None = None
    while True:
        attempts += 1
        try:
            last_value = operation()
            last_error = None
        except retry_exceptions as exc:
            last_error = exc
        if on_attempt:
            on_attempt(attempts, last_value, last_error)
        if last_error is None:
            if reject and reject(last_value):
                raise RuntimeError(
                    f"poll rejected value after {attempts} attempts: {last_value!r}"
                )
            if until(last_value):
                return PollResult(
                    value=last_value,
                    attempts=attempts,
                    elapsed_seconds=clock() - started,
                )

        elapsed = clock() - started
        if elapsed >= timeout_seconds:
            detail = f"; last error={last_error!r}" if last_error else ""
            raise PollTimeoutError(
                f"poll timed out after {attempts} attempts and {elapsed:.3f}s{detail}",
                last_value=last_value,
                attempts=attempts,
            )
        sleep(min(interval_seconds, max(0, timeout_seconds - elapsed)))
