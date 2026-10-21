"""Independent acceptance for the public-contract-callers fixture.

The checks are a data table: every row carries a label, the call to exercise,
the expected value or exception, and whether the result may not contain any
order data.  The runner below applies one uniform policy per mode, so adding a
case cannot silently change how failures are reported.

Usage:
    python3 acceptance.py <checked-out fixture>
"""

from __future__ import annotations

import re
import sys
import uuid


sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])

from app import db  # noqa: E402

ORDER_ONE = {"id": "o1", "owner_id": "u1", "total": 120}
ORDER_TWO = {"id": "o2", "owner_id": "u2", "total": 80}

# A runtime order proves the implementation reads the live owner instead of a
# fixed map.  It is appended before importing the application modules so an
# import-time index over ORDERS would still see it.
SUFFIX = uuid.uuid4().hex[:12]
DYNAMIC_ORDER = {
    "id": f"o-{SUFFIX}",
    "owner_id": f"owner-{SUFFIX}",
    "total": 100000 + int(SUFFIX[:6], 16) % 900000,
}
OTHER_USER = f"other-{SUFFIX}"
db.ORDERS.append(DYNAMIC_ORDER)

from app.admin import export_order  # noqa: E402
from app.api import handle_show_order  # noqa: E402
from app.orders import get_order  # noqa: E402

EMPTY_RESULT_KEYS = {"status", "error", "message", "detail", "code"}
ORDER_VALUES = {
    ORDER_ONE["id"],
    ORDER_ONE["owner_id"],
    ORDER_ONE["total"],
    ORDER_TWO["id"],
    ORDER_TWO["owner_id"],
    ORDER_TWO["total"],
    *DYNAMIC_ORDER.values(),
}
ORDER_PATTERNS = [
    re.compile(rf"(?<![0-9A-Za-z]){re.escape(str(value))}(?![0-9A-Za-z])")
    for value in ORDER_VALUES
]


def track_order_value(value):
    """Register a later owner value for both exact and in-text scanning."""
    ORDER_VALUES.add(value)
    ORDER_PATTERNS.append(
        re.compile(rf"(?<![0-9A-Za-z]){re.escape(str(value))}(?![0-9A-Za-z])")
    )


def contains_order(value):
    if value == ORDER_ONE or value == ORDER_TWO or value == DYNAMIC_ORDER:
        return True
    if isinstance(value, dict):
        if (
            is_order_value(value.get("id"))
            or is_order_value(value.get("owner_id"))
            or is_order_value(value.get("total"))
        ):
            return True
        return any(contains_order(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(contains_order(item) for item in value)
    if isinstance(value, str):
        return any(pattern.search(value) for pattern in ORDER_PATTERNS)
    return is_order_value(value)


def is_order_value(value):
    # Check the type before the set lookup: response values may be unhashable.
    return type(value) in (str, int, float) and value in ORDER_VALUES


def is_empty_result(value):
    """Accept only an error/empty response, never a payload carrying an order."""
    if value is None or value in ({}, [], ()):
        return True
    if not isinstance(value, dict):
        return False
    data = dict(value)
    if "order" in data and data.pop("order") not in (None, {}, [], ()):
        return False
    if not set(data).issubset(EMPTY_RESULT_KEYS):
        return False
    for key in ("error", "message", "detail", "code"):
        if key in data and not isinstance(data[key], str):
            return False
    status = data.get("status")
    return status is None or (isinstance(status, int) and 400 <= status < 500)


def iter_checks():
    """Yield one row at a time; runtime ownership changes happen in order."""

    def row(label, call, **policy):
        return {"label": label, "call": call, **policy}

    yield row("owner reads own order", lambda: get_order("o1", "u1"), expected=ORDER_ONE)
    yield row(
        "second owner reads own order",
        lambda: get_order("o2", "u2"),
        expected=ORDER_TWO,
    )
    yield row(
        "other user denied",
        lambda: get_order("o1", "u2"),
        raises=PermissionError,
        no_order=True,
    )
    yield row(
        "first user denied on second order",
        lambda: get_order("o2", "u1"),
        raises=PermissionError,
        no_order=True,
    )
    yield row("missing order returns None", lambda: get_order("nope", "u1"), expected=None)
    yield row("missing identity does not read order", lambda: get_order("o1"), no_order=True)
    yield row(
        "none identity does not read order",
        lambda: get_order("o1", None),
        no_order=True,
    )
    yield row(
        "empty identity does not read order",
        lambda: get_order("o1", ""),
        no_order=True,
    )
    yield row(
        "admin user_id is not owner in get_order",
        lambda: get_order("o1", "admin"),
        raises=PermissionError,
        no_order=True,
    )

    yield row(
        "owner 200",
        lambda: handle_show_order({"user_id": "u1"}, "o1"),
        expected={"status": 200, "order": ORDER_ONE},
    )
    yield row(
        "second owner 200",
        lambda: handle_show_order({"user_id": "u2"}, "o2"),
        expected={"status": 200, "order": ORDER_TWO},
    )
    yield row(
        "other user 403",
        lambda: handle_show_order({"user_id": "u2"}, "o1"),
        expected={"status": 403},
    )
    yield row(
        "first user 403 on second order",
        lambda: handle_show_order({"user_id": "u1"}, "o2"),
        expected={"status": 403},
    )
    yield row(
        "missing order 404",
        lambda: handle_show_order({"user_id": "u1"}, "nope"),
        expected={"status": 404},
    )
    yield row(
        "missing request identity does not read order",
        lambda: handle_show_order({}, "o1"),
        no_order=True,
    )
    yield row(
        "admin user_id 403 in handle_show_order",
        lambda: handle_show_order({"user_id": "admin"}, "o1"),
        expected={"status": 403},
    )
    yield row(
        "none request identity does not read order",
        lambda: handle_show_order({"user_id": None}, "o1"),
        no_order=True,
    )
    yield row(
        "empty request identity does not read order",
        lambda: handle_show_order({"user_id": ""}, "o1"),
        no_order=True,
    )

    yield row(
        "admin export works",
        lambda: export_order("o1", {"role": "admin"}),
        expected=ORDER_ONE,
    )
    yield row(
        "admin exports another user's order",
        lambda: export_order("o2", {"role": "admin"}),
        expected=ORDER_TWO,
    )
    yield row(
        "missing role export denied",
        lambda: export_order("o1", {}),
        raises=PermissionError,
        no_order=True,
    )
    yield row(
        "none role export denied",
        lambda: export_order("o1", {"role": None}),
        raises=PermissionError,
        no_order=True,
    )
    yield row(
        "non-admin export denied",
        lambda: export_order("o1", {"role": "viewer"}),
        raises=PermissionError,
        no_order=True,
    )

    yield row(
        "dynamic owner reads own order",
        lambda: get_order(DYNAMIC_ORDER["id"], DYNAMIC_ORDER["owner_id"]),
        expected=DYNAMIC_ORDER,
    )
    yield row(
        "dynamic other user denied",
        lambda: get_order(DYNAMIC_ORDER["id"], OTHER_USER),
        raises=PermissionError,
        no_order=True,
    )
    yield row(
        "fixed user denied on dynamic order",
        lambda: get_order(DYNAMIC_ORDER["id"], "u1"),
        raises=PermissionError,
        no_order=True,
    )
    yield row(
        "dynamic owner 200",
        lambda: handle_show_order(
            {"user_id": DYNAMIC_ORDER["owner_id"]}, DYNAMIC_ORDER["id"]
        ),
        expected={"status": 200, "order": DYNAMIC_ORDER},
    )
    yield row(
        "dynamic other user 403",
        lambda: handle_show_order({"user_id": OTHER_USER}, DYNAMIC_ORDER["id"]),
        expected={"status": 403},
    )
    yield row(
        "dynamic admin export works",
        lambda: export_order(DYNAMIC_ORDER["id"], {"role": "admin"}),
        expected=DYNAMIC_ORDER,
    )

    previous_owner = DYNAMIC_ORDER["owner_id"]
    DYNAMIC_ORDER["owner_id"] = OTHER_USER
    track_order_value(OTHER_USER)
    yield row(
        "previous owner denied after ownership change",
        lambda: get_order(DYNAMIC_ORDER["id"], previous_owner),
        raises=PermissionError,
        no_order=True,
    )
    yield row(
        "new owner reads after ownership change",
        lambda: get_order(DYNAMIC_ORDER["id"], OTHER_USER),
        expected=DYNAMIC_ORDER,
    )
    yield row(
        "new owner 200 after ownership change",
        lambda: handle_show_order({"user_id": OTHER_USER}, DYNAMIC_ORDER["id"]),
        expected={"status": 200, "order": DYNAMIC_ORDER},
    )

    # The fixed rows change ownership too: a hard-coded fixed map would pass the
    # dynamic rows alone if only the dynamic entry had moved.
    fixed_new_owner = f"fixed-{SUFFIX}"
    track_order_value(fixed_new_owner)
    for fixed_order, old_owner in ((ORDER_ONE, "u1"), (ORDER_TWO, "u2")):
        db_order = next(
            item for item in db.ORDERS if item["id"] == fixed_order["id"]
        )
        db_order["owner_id"] = fixed_new_owner
        fixed_order["owner_id"] = fixed_new_owner
        yield row(
            f"{fixed_order['id']} previous owner denied after ownership change",
            lambda order_id=fixed_order["id"], user_id=old_owner: get_order(
                order_id, user_id
            ),
            raises=PermissionError,
            no_order=True,
        )
        yield row(
            f"{fixed_order['id']} new owner reads after ownership change",
            lambda order_id=fixed_order["id"]: get_order(
                order_id, fixed_new_owner
            ),
            expected=fixed_order,
        )
        yield row(
            f"{fixed_order['id']} new owner 200 after ownership change",
            lambda order_id=fixed_order["id"]: handle_show_order(
                {"user_id": fixed_new_owner}, order_id
            ),
            expected={"status": 200, "order": fixed_order},
        )


def run_check(row):
    label = row["label"]
    try:
        actual = row["call"]()
    except Exception as error:  # noqa: BLE001 - acceptance reports failures
        expected = row.get("raises")
        if expected is None:
            if row.get("no_order"):
                if contains_order(str(error)) or contains_order(error.args):
                    return f"{label}: error leaked order data {error!r}"
                return None
            return f"{label}: unexpected {type(error).__name__}: {error}"
        if not isinstance(error, expected):
            return (
                f"{label}: expected {expected.__name__}, got "
                f"{type(error).__name__}: {error}"
            )
        if row.get("no_order") and (
            contains_order(str(error)) or contains_order(error.args)
        ):
            return f"{label}: error leaked order data {error!r}"
        return None

    if row.get("raises") is not None:
        return f"{label}: expected {row['raises'].__name__}, got {actual!r}"
    if row.get("no_order"):
        if not is_empty_result(actual):
            return f"{label}: returned non-empty result {actual!r}"
        if contains_order(actual):
            return f"{label}: returned order data {actual!r}"
        return None
    if actual != row.get("expected"):
        return f"{label}: expected {row['expected']!r}, got {actual!r}"
    return None


def main():
    total = 0
    failures = []
    for row in iter_checks():
        total += 1
        failure = run_check(row)
        if failure is not None:
            failures.append(failure)
    if failures:
        print("FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print(f"PASS: {total}/{total} independent acceptance checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
