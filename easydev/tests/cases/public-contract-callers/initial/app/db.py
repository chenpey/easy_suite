ORDERS = [
    {"id": "o1", "owner_id": "u1", "total": 120},
    {"id": "o2", "owner_id": "u2", "total": 80},
]


def find_order(order_id):
    return next((order for order in ORDERS if order["id"] == order_id), None)
