"""Order read API used by the API and export callers."""

from app.db import find_order


def get_order(order_id):
    """Return the order with this id, or None when it does not exist."""
    return find_order(order_id)
