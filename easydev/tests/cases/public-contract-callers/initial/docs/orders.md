# 订单读取契约

`get_order(order_id)` 返回订单字典；订单不存在时返回 `None`。
调用方自行处理“是否已认证”和“能否查看该订单”。

调用方：

- `app/api.py`：订单详情接口，`request` 携带已认证用户。
- `app/admin.py`：运营导出，要求 operator 具备 admin 角色。

仓库自带 `check_orders.py` 检查上述读取契约；`probe.py` 打印固定用户读取结果。
