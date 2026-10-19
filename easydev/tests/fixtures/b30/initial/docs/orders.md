# 订单读取契约

`get_order(order_id)` 返回订单或 `None`。

调用方：
- `app/api.py`：订单详情接口，`request` 携带已认证用户。
- `app/admin.py`：运营导出，要求 operator 具备 admin 角色。
