# B30 可复现夹具

对应 [0.3.1 全链路记录](../../results/baseline-0.3.1.md)：鉴权高风险改动进入 `full`，修复前检查失败，修复后通过，独立 Reviewer 审查冻结变更。本夹具把那次实验的初始仓库、最终补丁、审查原文与运行方式固定下来，供独立复验。

## 目录

```text
b30/
├── initial/               初始仓库
│   ├── app/{__init__,db,orders,api,admin}.py
│   ├── docs/orders.md
│   ├── check_orders.py    目标契约检查（初始必然失败）
│   └── probe.py           接口探针：初始期望 200，修复后期望 403
├── solution.patch         初始状态 → 修复后实现的完整 diff
├── acceptance.py          独立验收脚本（不依赖被测仓库的 check_orders.py）
├── reviewer-report.md     独立 Reviewer 原始报告（未改写）
└── run.sh                 红 → 应用补丁 → 绿 → 独立验收 → 负向拒绝伪修复 的一键复验
```

## 运行

```bash
bash tests/fixtures/b30/run.sh
```

预期输出（顺序）：

1. `probe.py 200`：他人读取返回 200，证明缺少所有权校验；
2. `check_orders.py` 失败，失败行必须恰好 3 条且全部为 `TypeError`（契约未实现），其他原因或额外失败判为夹具异常；
3. `git apply solution.patch` 成功；
4. `probe.py 403`：修复后他人读取返回 403；
5. `check_orders.py` 输出 `PASS: 7/7`；
6. `acceptance.py` 输出 `PASS: <N>/<N> independent acceptance checks`（当前 38 条）；
7. 负向变体：省略身份、缺失身份返回标量、缺失身份返回变形嵌套字段、缺失身份把订单值写进错误文本、把 `user_id` 当 admin 角色、硬编码 `u1` 所有权、硬编码固定订单映射、缺少角色校验、空字符串身份绕过九类伪修复，均被独立验收拒绝（非零退出并命中对应失败标签）。

只需要 `bash`、`git` 与 Python 3，不安装依赖。脚本在 `mktemp` 临时目录内执行，不改动工作区。

## 三种用途

| 用途 | 使用材料 | 说明 |
| --- | --- | --- |
| 历史补丁复验 | `initial/` + `solution.patch` + `run.sh` | 重现 0.3.1 记录中的红绿过程 |
| Agent 任务执行评测 | 只提供 `initial/` 与原始需求 | 不要把 `solution.patch` 暴露给被测 Agent |
| 独立验收 | `acceptance.py`（放在 Agent 不可修改的位置） | 防止被测 Agent 自己定义验收标准 |

## 覆盖与限制

- 检查覆盖：本人可读、他人被拒、第二个用户读取自己的订单、跨订单越权、缺失订单返回 `None`、缺失/空身份不返回订单（仅允许报错、None、空容器或 4xx 错误文本；标量、部分字段、嵌套容器、变形字段及错误文本内嵌已知订单值均拒绝）、`user_id="admin"` 不获得订单所有权、接口 200/403/404、缺失 `request` 身份不返回订单（缺失键允许报错）、admin 导出（含非本人订单与缺失/空角色）、非 admin 拒绝；另用运行时生成的订单、`o1`/`o2` 实际所有者变更与动态归属变更确认实现读取实际 `owner_id`，而不是写死固定订单映射或使用导入时快照。
- 未覆盖：`request["user_id"]` 的上游可信性（夹具没有 HTTP/鉴权层，该项在记录中保持为待验证风险）；真实鉴权中间件与并发请求。
- 修复前基线 `check_orders.py` 已按目标两参契约编写，初始失败原因是契约尚未实现（`TypeError`），不是越权读取的运行证据；越权由 `probe.py 200` 与静态实现共同证明。
- `run.sh` 只证明固定补丁能通过断言、九类伪修复会被拒绝；独立 Reviewer 是否实际运行、Agent 是否遵守流程，需要另看执行记录，不能由本脚本推导。
- `run.sh` 提交夹具时显式使用 `-c commit.gpgsign=false`，不继承安装者全局的提交签名配置；签名启用且签名程序不可用时仍可复验。
- `acceptance.py` 设置 `sys.dont_write_bytecode = True`，`run.sh` 使用 `python3 -B` 与 `PYTHONDONTWRITEBYTECODE=1`，运行后不生成 `__pycache__`/`.pyc`，不污染被测工作区。
- 本夹具仅覆盖单次 `full` 工作流与公共契约调用方适配，不代表其他语言或真实鉴权环境。
