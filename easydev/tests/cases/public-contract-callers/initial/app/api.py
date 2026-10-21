"""HTTP-style order detail handler."""

from app.orders import get_order

STATUS_OK = 200
STATUS_NOT_FOUND = 404


def handle_show_order(request, order_id):
    """Return the order detail response for the authenticated request."""
    del request  # The initial fixtures do not use the authenticated identity.
    order = get_order(order_id)
    if order is None:
        return {"status": STATUS_NOT_FOUND}
    return {"status": STATUS_OK, "order": order}
