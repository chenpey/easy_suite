# 0.3.1 行为记录：完整 full 链路（B30）

日期：2026-10-19。对象：0.3.1 工作树（SKILL.md 分流规则、orchestration.md 复审规则、B29a/B29b 与 B30–B33）。用例定义见 [behavior.md](../behavior.md)。

## 执行条件

- 宿主：DeepSeek Harness（本会话）。主代理模型 `deepseek-flash`（会话声明）；独立审查子代理由宿主默认继承主代理配置，工具未返回实际模型与推理深度，记为未知。
- 夹具：`/tmp/easydev-r1`，临时 Git 仓库，基线提交 `bf39ef9`，按 B30 夹具搭建（`app/db.py`、`app/orders.py`、`app/api.py`、`app/admin.py`、`docs/orders.md`、`check_orders.py`）。
- 任务原话：“订单详情接口没有所有权校验，任何已认证用户都能按订单 ID 读到别人的订单。给订单读取加上所有权校验：只有下单本人可以读取自己的订单；运营导出订单是内部用途，不受此限制，但必须仍然校验 admin 角色。完成后确保现有调用方适配，并给出验证证据。”
- 审查者只拿到技能路径、审查规程、夹具路径、原始需求与开发者自述的验证输出，未拿到通过条件与本节结论；独立只读，不修改文件、不派生代理。
- 主代理是唯一写入者，未委派开发者（开发与审查均继承，符合 [orchestration.md](../../references/orchestration.md) 默认配置）。

## 分流与实现

- 鉴权属于高风险边界，判定 `full`；风险先于文件数，未因“只涉及几个小文件”降为 quick。
- 修复前复现（诊断，不计修复尝试）：

```text
$ cd /tmp/easydev-r1 && python3 - <<'EOF'
from app.orders import get_order
print("调用方无身份参数时即可读取他人订单：", get_order("o1"))
EOF
调用方无身份参数时即可读取他人订单： {'id': 'o1', 'owner_id': 'u1', 'total': 120}
```

- 红：目标契约检查（本人可读、他人拒绝、不存在返回 `None`，随夹具提供）在修复前退出码 1：

```text
$ python3 check_orders.py
FAIL
- owner reads own order: expected {...}, got 'TypeError'
- other user denied: expected 'PermissionError', got 'TypeError'
- missing order returns None: expected None, got 'TypeError'
check exit=1
```

- 实现：`get_order(order_id, current_user_id)` 校验 `owner_id`，越权抛 `PermissionError`；新增 `get_order_for_export(order_id, operator_role)` 仅允许 admin；`app/api.py` 把越权映射为 403、不存在仍为 404；`app/admin.py` 改用导出入口；`docs/orders.md` 同步契约。
- 调用方核对：仓库内 `get_order` 的两个调用方（`app/api.py`、`app/admin.py`）均已同步，检查脚本覆盖两个调用方路径而非只测被改函数。
- 绿：`python3 check_orders.py` → `PASS: 7/7 ownership and caller checks`，退出码 0；`PYTHONPYCACHEPREFIX=/tmp/pycache python3 -m py_compile app/*.py check_orders.py` 通过（首次直接运行 `py_compile` 因沙箱无法写用户缓存目录失败，属环境限制，改写缓存目录后通过）。

## 独立审查

- 实例与轮次：独立子代理（未参与实现），只读，未修改文件；r=1/4。审查对象为冻结的工作区 diff（sha256 `e3e5a2016a89a948afd318c36e0650399305e2c19d11cd9e0449f7186fe159d0`，HEAD `bf39ef9`）。审查者自行核对 diff、调用方、契约与验证命令，不采信开发者自述。
- 发现：无 P0/P1/P2 确定缺陷。1 条 P3：越权返回 403、订单不存在返回 404，已认证用户可探测订单是否存在（不含内容）；1 条高影响待验证风险：`request["user_id"]` 的上游可信性未在夹具内证明。
- 核实：P3 成立，但不影响本任务验收，夹具文档已把 403 写成契约；按延期建议记录，不实施、不追加复审。待验证风险源自夹具没有 HTTP/鉴权层，属环境限制而非本次实现缺陷，按残留风险记录，未降级为确定缺陷。
- 审查者另行核对并排除：`get_order` 无遗留单参数调用；admin 导出仅在 `role == "admin"` 时绕过所有权；`docs/orders.md` 与实现一致；运行后未生成 `__pycache__`。
- 结论：`full` 工作流已执行——分流、冻结、独立审查、发现核实与交付齐全，审核轮次 1/4，未追加轮次。但高影响待验证风险未消除，按 [execution.md 完成边界](../../references/execution.md#完成边界)，整体交付状态为 **部分完成/待确认**，不称闭环完成。

## 结论与限制

- 本场景为鉴权高风险改动，进入 `full` 后由独立实例审查；审查发生在最终版本上，范围内无确认缺陷，不影响验收的 P3 未实施并已记录。工作流执行完整，但身份来源可信性未验证，因此交付状态为“部分完成/待确认”，不等于可安全发布。
- 残留风险：`request["user_id"]` 的来源依赖宿主或框架的鉴权层，夹具内无法验证（若上游可被客户端伪造，则本次修复可被绕过，潜在影响为 P1 级）；403 与 404 的差异披露订单存在性。该风险已有具体线索但关键条件未确认，属“潜在 P0/P1 的待验证风险”，不得因检查通过而降级或关闭。
- 未覆盖：B31–B33 仅有用例定义，本轮未执行；B34/B35 及审查成本对比未做；其他宿主、其他模型与真实 Token 成本未测量；检查脚本未覆盖 API 的 404 分支与缺失 `user_id` 分支。
- 本夹具是最小 Python 仓库，只证明该场景下的分流、调用方同步与独立审查工作流，不代表跨语言或全仓规模行为。可复现材料见 [tests/fixtures/b30](../fixtures/b30/)，含初始仓库、最终补丁、独立审查原文与运行脚本。
