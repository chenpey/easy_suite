from app.orders import get_order


def handle_show_order(request, order_id):
    order = get_order(order_id)
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
