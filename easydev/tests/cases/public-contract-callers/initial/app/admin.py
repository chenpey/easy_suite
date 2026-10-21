"""Operations export caller."""

from app.orders import get_order


def export_order(order_id, operator):
    """Export one order; only operators with the admin role may call this."""
    role = (operator or {}).get("role")
    if role != "admin":
        raise PermissionError("export requires admin role")
    return get_order(order_id)
