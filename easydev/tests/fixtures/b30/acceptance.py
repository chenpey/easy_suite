"""独立验收脚本：不依赖被测仓库的 check_orders.py，可单独用于 Agent 任务评测。

用法：
    python3 acceptance.py <被测仓库目录>
"""
import sys

sys.path.insert(0, sys.argv[1])

from app.admin import export_order  # noqa: E402
from app.api import handle_show_order  # noqa: E402
from app.orders import get_order  # noqa: E402

order = {"id": "o1", "owner_id": "u1", "total": 120}
failures = []


def expect(label, fn, expected):
    try:
        actual = fn()
    except Exception as error:  # noqa: BLE001 - 验收脚本
        actual = type(error).__name__
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


expect("owner reads own order", lambda: get_order("o1", "u1"), order)
expect("other user denied", lambda: get_order("o1", "u2"), "PermissionError")
expect("missing order returns None", lambda: get_order("nope", "u1"), None)
expect("owner 200", lambda: handle_show_order({"user_id": "u1"}, "o1"), {"status": 200, "order": order})
expect("other user 403", lambda: handle_show_order({"user_id": "u2"}, "o1"), {"status": 403})
expect("missing order 404", lambda: handle_show_order({"user_id": "u1"}, "nope"), {"status": 404})
expect("admin export works", lambda: export_order("o1", {"role": "admin"}), order)
expect("non-admin export denied", lambda: export_order("o1", {"role": "viewer"}), "PermissionError")

if failures:
    print("FAIL")
    for failure in failures:
        print(f"- {failure}")
    raise SystemExit(1)
print("PASS: 8/8 independent acceptance checks")
