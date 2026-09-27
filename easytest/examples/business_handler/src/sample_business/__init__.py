"""An installable business adapter, deliberately outside the EasyTest core."""
from decimal import Decimal, ROUND_HALF_UP


def quote(*, request, context):
    """Local pricing example; replace the calculation with the company's SDK call."""
    quantity = request["quantity"]
    if type(quantity) is not int or quantity < 1:
        raise ValueError("quantity must be a positive integer")
    price = Decimal(request["unit_price"])
    if not price.is_finite() or price < 0:
        raise ValueError("unit_price must be finite and non-negative")
    total = (price * quantity).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    # output is a business field, not an implicit framework envelope.
    return {"output": {"total": str(total)}, "status": "SUCCESS", "quantity": quantity}
