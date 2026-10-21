# public-contract-callers

公共契约变更与调用方适配用例：订单读取函数增加当前用户参数和所有权校验，仓库内已有两个调用方。它验证“识别公共契约、适配调用方、独立验收”这条链路，不是模型行为成绩。

## 材料

```text
public-contract-callers/
├── initial/           # Agent 可见的初始仓库
│   ├── app/{__init__,db,orders,api,admin}.py
│   ├── check_orders.py   # 仓库自带的目标契约检查（初始失败）
│   ├── docs/orders.md    # 现有契约与调用方说明
│   └── probe.py          # 打印实际 status 数字
├── solution.patch     # 评测方参考补丁（同时更新检查脚本与契约文档）
├── .gitattributes     # 让补丁文件保留 diff 上下文的行尾空格
├── acceptance.py      # 独立验收 CLI，不依赖 check_orders.py
├── verify.py          # 固定补丁复验编排
├── run.sh             # 薄封装：exec python3 verify.py
└── README.md
```

材料隔离：`initial/` 与用户请求给执行者；`solution.patch`、`acceptance.py`、`verify.py` 和本 README 属于评测私有材料，Agent 与独立审查者都不能读取。历史审查记录已随重构清空，当前无审查历史。

## 运行

```bash
bash tests/cases/public-contract-callers/run.sh
```

`verify.py` 在 `tempfile.mkdtemp()` 中按固定顺序执行：

1. 初始 `probe.py` 期望 `200`（越权可读）。
2. `check_orders.py` 失败，且失败原因恰为 3 条 `TypeError`。
3. `git apply solution.patch`。
4. `probe.py` 期望 `403`。
5. `check_orders.py` 通过（7/7）。
6. `acceptance.py` 通过。
7. 11 类伪修复分别被 `acceptance.py` 拒绝：忽略身份、返回订单标量、变形金额泄露、响应文本泄露、异常文本泄露、越权异常带订单数据、把 user_id 当 admin、硬编码 `u1`、硬编码固定归属映射、空身份绕过、导出缺少角色校验。

`acceptance.py` 的检查项是数据表（label/调用/期望/是否扫描订单值），新增一个变体只增加一行；`verify.py` 的 `PSEUDO_FIXES` 同样表驱动。
8. 临时目录没有 `__pycache__` 或 `.pyc`。

任一步不符则非 0 退出并打印具体步骤。复验不依赖 `mktemp` 命令，可在精简环境运行。

## 独立验收覆盖

`acceptance.py` 只通过 `app` 的公共接口断言：

- 本人读取自己的订单成功；他人读取抛 `PermissionError` 且异常文本不含订单值。
- 缺失订单返回 `None`；`handle_show_order` 对缺失订单返回 404。
- 缺失/`None`/空身份不返回订单；返回空结构或 4xx 状态可以接受。
- 越权时 `handle_show_order` 只返回 `{"status": 403}`，不含订单内容。
- admin 导出仍校验角色；缺失/`None`/非 admin 角色被拒绝。
- 运行时新增订单与归属变更同样受约束，固定映射或硬编码实现会被拒绝。

## 覆盖范围与未覆盖条件

覆盖：参考补丁的红绿、独立验收的通过/拒绝、伪修复召回、字节码产物副作用。

未覆盖：真实 Agent 是否遵守材料隔离与修改边界；真实模型行为由 `tests/experiments/agent_runner/` 的 `public-contract-callers` 场景在具隔离能力的环境中执行，当前 CI 只运行固定补丁复验和替身驱动的验收机制检查，不启动模型。
