"""独立验收脚本：不依赖被测仓库的 check_orders.py，可单独用于 Agent 任务评测。

用法：
    python3 acceptance.py <被测仓库目录>
"""
import sys
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])

from app import db  # noqa: E402

order = {"id": "o1", "owner_id": "u1", "total": 120}
order2 = {"id": "o2", "owner_id": "u2", "total": 80}

# 动态订单用于确认实现读取实际 owner_id，而不是把固定订单映射写死。
# 在导入被测模块前写入，避免把“导入时从 ORDERS 派生映射”误判为硬编码。
suffix = uuid.uuid4().hex[:12]
dynamic_order = {
    "id": f"o-{suffix}",
    "owner_id": f"owner-{suffix}",
    "total": 100000 + int(suffix[:6], 16) % 900000,
}
other_user = f"other-{suffix}"
db.ORDERS.append(dynamic_order)

from app.admin import export_order  # noqa: E402
from app.api import handle_show_order  # noqa: E402
from app.orders import get_order  # noqa: E402

known_order_values = {
    order["id"],
    order["owner_id"],
    order["total"],
    order2["id"],
    order2["owner_id"],
    order2["total"],
    *dynamic_order.values(),
}
checks = 0
failures = []


def count_check():
    global checks
    checks += 1


def expect(label, fn, expected):
    count_check()
    try:
        actual = fn()
    except Exception as error:  # noqa: BLE001 - 验收脚本
        actual = f"{type(error).__name__}: {error}"
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


def expect_raises(label, fn, exc_type):
    count_check()
    try:
        actual = fn()
    except exc_type:
        return
    except Exception as error:  # noqa: BLE001 - 验收脚本
        failures.append(f"{label}: expected {exc_type.__name__}, got {type(error).__name__}: {error}")
        return
    failures.append(f"{label}: expected {exc_type.__name__}, got return value {actual!r}")


def is_order_value(value):
    # 先判类型再查集合，避免响应中的不可哈希字段让验收器崩溃。
    return type(value) in (str, int, float) and value in known_order_values


def contains_order(value):
    if value == order or value == order2 or value == dynamic_order:
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
    # 缺失身份时直接返回订单字段（如金额 120）也属于泄露，不能只查容器。
    return is_order_value(value)


def expect_no_order(label, fn):
    """缺少身份时允许报错或返回空结果，但不得返回订单数据。"""
    count_check()
    try:
        actual = fn()
    except Exception:  # noqa: BLE001 - 验收脚本
        return
    # 有效结果只有报错、None 或状态容器；裸标量不是订单读取的合法空结果。
    if type(actual) in (str, int, float):
        failures.append(f"{label}: returned scalar {actual!r}")
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

expect("dynamic owner reads own order", lambda: get_order(dynamic_order["id"], dynamic_order["owner_id"]), dynamic_order)
expect_raises("dynamic other user denied", lambda: get_order(dynamic_order["id"], other_user), PermissionError)
expect_raises("fixed user denied on dynamic order", lambda: get_order(dynamic_order["id"], "u1"), PermissionError)
expect("dynamic owner 200", lambda: handle_show_order({"user_id": dynamic_order["owner_id"]}, dynamic_order["id"]), {"status": 200, "order": dynamic_order})
expect("dynamic other user 403", lambda: handle_show_order({"user_id": other_user}, dynamic_order["id"]), {"status": 403})
expect("dynamic admin export works", lambda: export_order(dynamic_order["id"], {"role": "admin"}), dynamic_order)

previous_owner = dynamic_order["owner_id"]
dynamic_order["owner_id"] = other_user
known_order_values.add(other_user)
expect_raises("previous owner denied after ownership change", lambda: get_order(dynamic_order["id"], previous_owner), PermissionError)
expect("new owner reads after ownership change", lambda: get_order(dynamic_order["id"], other_user), dynamic_order)
expect("new owner 200 after ownership change", lambda: handle_show_order({"user_id": other_user}, dynamic_order["id"]), {"status": 200, "order": dynamic_order})

# 审计原始场景：直接改动固定订单的实际所有者，混合硬编码（固定映射 + 动态回退）也应被拒绝。
fixed_new_owner = f"fixed-{suffix}"
known_order_values.add(fixed_new_owner)
for fixed_order, old_owner in ((order, "u1"), (order2, "u2")):
    db_order = next(item for item in db.ORDERS if item["id"] == fixed_order["id"])
    db_order["owner_id"] = fixed_new_owner
    fixed_order["owner_id"] = fixed_new_owner
    expect_raises(
        f"{fixed_order['id']} previous owner denied after ownership change",
        lambda order_id=fixed_order["id"], user_id=old_owner: get_order(order_id, user_id),
        PermissionError,
    )
    expect(
        f"{fixed_order['id']} new owner reads after ownership change",
        lambda order_id=fixed_order["id"]: get_order(order_id, fixed_new_owner),
        fixed_order,
    )
    expect(
        f"{fixed_order['id']} new owner 200 after ownership change",
        lambda order_id=fixed_order["id"]: handle_show_order({"user_id": fixed_new_owner}, order_id),
        {"status": 200, "order": fixed_order},
    )

if failures:
    print("FAIL")
    for failure in failures:
        print(f"- {failure}")
    raise SystemExit(1)
print(f"PASS: {checks}/{checks} independent acceptance checks")
