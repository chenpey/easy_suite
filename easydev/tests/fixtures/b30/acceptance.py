"""独立验收脚本：不依赖被测仓库的 check_orders.py，可单独用于 Agent 任务评测。

用法：
    python3 acceptance.py <被测仓库目录>
"""
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])

from app.admin import export_order  # noqa: E402
from app.api import handle_show_order  # noqa: E402
from app.orders import get_order  # noqa: E402

order = {"id": "o1", "owner_id": "u1", "total": 120}
order2 = {"id": "o2", "owner_id": "u2", "total": 80}
failures = []


def expect(label, fn, expected):
    try:
        actual = fn()
    except Exception as error:  # noqa: BLE001 - 验收脚本
        actual = f"{type(error).__name__}: {error}"
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def expect_raises(label, fn, exc_type):
    try:
        actual = fn()
    except exc_type:
        return
    except Exception as error:  # noqa: BLE001 - 验收脚本
        failures.append(f"{label}: expected {exc_type.__name__}, got {type(error).__name__}: {error}")
        return
    failures.append(f"{label}: expected {exc_type.__name__}, got return value {actual!r}")


def contains_order(value):
    if value == order or value == order2:
        return True
    if isinstance(value, dict):
        if (
            value.get("id") in ("o1", "o2")
            or value.get("owner_id") in ("u1", "u2")
            or value.get("total") in (120, 80)
        ):
            return True
        return any(contains_order(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(contains_order(item) for item in value)
    return False


def expect_no_order(label, fn):
    """缺少身份时允许报错或返回空结果，但不得返回订单数据。"""
    try:
        actual = fn()
    except Exception:  # noqa: BLE001 - 验收脚本
        return
    if contains_order(actual):
        failures.append(f"{label}: returned order data {actual!r}")


expect("owner reads own order", lambda: get_order("o1", "u1"), order)
expect("second owner reads own order", lambda: get_order("o2", "u2"), order2)
expect_raises("other user denied", lambda: get_order("o1", "u2"), PermissionError)
expect_raises("first user denied on second order", lambda: get_order("o2", "u1"), PermissionError)
expect("missing order returns None", lambda: get_order("nope", "u1"), None)
expect_no_order("missing identity does not read order", lambda: get_order("o1"))
expect_no_order("none identity does not read order", lambda: get_order("o1", None))
expect_no_order("empty identity does not read order", lambda: get_order("o1", ""))
expect_raises("admin user_id is not owner in get_order", lambda: get_order("o1", "admin"), PermissionError)
expect("owner 200", lambda: handle_show_order({"user_id": "u1"}, "o1"), {"status": 200, "order": order})
expect("second owner 200", lambda: handle_show_order({"user_id": "u2"}, "o2"), {"status": 200, "order": order2})
expect("other user 403", lambda: handle_show_order({"user_id": "u2"}, "o1"), {"status": 403})
expect("first user 403 on second order", lambda: handle_show_order({"user_id": "u1"}, "o2"), {"status": 403})
expect("missing order 404", lambda: handle_show_order({"user_id": "u1"}, "nope"), {"status": 404})
expect_no_order("missing request identity does not read order", lambda: handle_show_order({}, "o1"))
expect("admin user_id 403 in handle_show_order", lambda: handle_show_order({"user_id": "admin"}, "o1"), {"status": 403})
expect_no_order("none request identity does not read order", lambda: handle_show_order({"user_id": None}, "o1"))
expect_no_order("empty request identity does not read order", lambda: handle_show_order({"user_id": ""}, "o1"))
expect("admin export works", lambda: export_order("o1", {"role": "admin"}), order)
expect("admin exports another user's order", lambda: export_order("o2", {"role": "admin"}), order2)
expect_raises("missing role export denied", lambda: export_order("o1", {}), PermissionError)
expect_raises("none role export denied", lambda: export_order("o1", {"role": None}), PermissionError)
expect_raises("non-admin export denied", lambda: export_order("o1", {"role": "viewer"}), PermissionError)

if failures:
    print("FAIL")
    for failure in failures:
        print(f"- {failure}")
    raise SystemExit(1)
print("PASS: 23/23 independent acceptance checks")
