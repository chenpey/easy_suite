#!/usr/bin/env python3
"""Repository-level contract check for order reads."""

from app.orders import get_order

ORDER = {"id": "o1", "owner_id": "u1", "total": 120}
CHECKS = (
    ("owner reads own order", lambda: get_order("o1", "u1"), ORDER),
    ("other user denied", lambda: get_order("o1", "u2"), "PermissionError"),
    ("missing order returns None", lambda: get_order("nope", "u1"), None),
)


def observed(call):
    try:
        return call()
    except Exception as error:  # noqa: BLE001 - fixture check
        return type(error).__name__


failures = []
for label, call, expected in CHECKS:
    actual = observed(call)
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")
if failures:
    print("FAIL")
    for failure in failures:
        print(f"- {failure}")
    raise SystemExit(1)
print(f"PASS: {len(CHECKS)}/{len(CHECKS)} ownership checks")
