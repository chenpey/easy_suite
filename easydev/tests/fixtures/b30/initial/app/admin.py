from app.orders import get_order


def export_order(order_id, operator):
    if operator.get("role") != "admin":
        raise PermissionError("export requires admin role")
    return get_order(order_id)
