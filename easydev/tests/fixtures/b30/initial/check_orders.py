from app.orders import get_order

failures = []


def expect(label, fn, expected):
    try:
        actual = fn()
    except Exception as error:  # noqa: BLE001 - fixture check
        actual = type(error).__name__
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


order = {"id": "o1", "owner_id": "u1", "total": 120}
expect("owner reads own order", lambda: get_order("o1", "u1"), order)
expect("other user denied", lambda: get_order("o1", "u2"), "PermissionError")
expect("missing order returns None", lambda: get_order("nope", "u1"), None)

if failures:
    print("FAIL")
    for failure in failures:
        print(f"- {failure}")
    raise SystemExit(1)
print("PASS: 3/3 ownership checks")
