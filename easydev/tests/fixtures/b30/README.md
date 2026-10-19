# B30 可复现夹具

对应 [0.3.1 全链路记录](../../results/baseline-0.3.1.md)：鉴权高风险改动进入 `full`，修复前检查失败，修复后通过，独立 Reviewer 审查冻结变更。本夹具把那次实验的初始仓库、最终补丁、审查原文与运行方式固定下来，供独立复验。

## 目录

```text
b30/
├── initial/               初始仓库（含故意失败的 check_orders.py）
│   ├── app/{__init__,db,orders,api,admin}.py
│   ├── docs/orders.md
│   └── check_orders.py
├── solution.patch         初始状态 → 修复后实现的完整 diff
├── reviewer-report.md     独立 Reviewer 原始报告（未改写）
└── run.sh                 红 → 应用补丁 → 绿 的一键复验
```

## 运行

```bash
bash tests/fixtures/b30/run.sh
```

预期输出（顺序）：

1. 初始状态直接返回 `o1` 订单，证明缺少所有权校验；
2. `check_orders.py` 失败（红），退出码非 0；
3. `git apply solution.patch` 成功；
4. `check_orders.py` 输出 `PASS: 7/7 ownership and caller checks`（绿）。

只需要 `bash`、`git` 与 Python 3，不安装依赖。脚本在 `mktemp` 临时目录内执行，不改动工作区。

## 覆盖与限制

- 检查覆盖：本人可读、他人被拒、缺失订单返回 `None`、接口 200/403、admin 导出、非 admin 拒绝。
- 未覆盖：`request["user_id"]` 的上游可信性（夹具没有 HTTP/鉴权层，该项在记录中保持为待验证风险）；API 的 404 分支与缺失 `user_id` 分支。
- 修复前基线 `check_orders.py` 已按目标两参契约编写，初始失败原因是契约尚未实现（`TypeError`），不是越权读取的运行证据；越权由 `run.sh` 的第一步与静态实现共同证明。
- 本夹具仅覆盖单次 `full` 工作流与公共契约调用方适配，不代表其他语言或真实鉴权环境。
