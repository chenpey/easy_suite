"""In-memory order store shared by the fixture callers."""

ORDERS = [
    {"id": "o1", "owner_id": "u1", "total": 120},
    {"id": "o2", "owner_id": "u2", "total": 80},
]


def find_order(order_id):
    """Return the order with this id, or None when it does not exist."""
    for order in ORDERS:
        if order["id"] == order_id:
            return order
    return None
