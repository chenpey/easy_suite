from app.db import find_order


def get_order(order_id):
    return find_order(order_id)
