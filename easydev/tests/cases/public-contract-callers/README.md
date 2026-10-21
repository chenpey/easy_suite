# 公共契约与调用方用例

本用例验证公共读取函数的契约变更、对象级所有权校验和仓库内调用方适配。它包含初始仓库、参考补丁、独立验收脚本、历史审查报告和一键复验脚本。

## 目录

```text
public-contract-callers/
├── initial/               被测初始仓库
│   ├── app/
│   ├── docs/orders.md
│   ├── check_orders.py    目标契约检查，初始状态应失败
│   └── probe.py           接口探针，修复前 200、修复后 403
├── solution.patch         初始状态到参考实现的完整 diff
├── acceptance.py          独立验收脚本，不依赖被测仓库的自带检查
├── reviewer-report.md     历史独立审查原始报告
└── run.sh                 红测、参考补丁、绿测和负向伪修复复验
```

## 运行

在 EasyDev 目录执行：

```bash
bash tests/cases/public-contract-callers/run.sh
```

脚本使用 `mktemp` 创建临时工作区，只依赖 `bash`、`git` 和 Python 3。预期流程：

1. 初始接口允许他人读取，`probe.py` 输出 `200`。
2. 初始契约检查因目标两参签名尚未实现而失败，失败行必须恰好为 3 条 `TypeError`。
3. `git apply solution.patch` 成功。
4. 修复后接口返回 `403`。
5. 仓库契约检查输出 `PASS: 7/7`。
6. 独立验收输出 `PASS: 38/38 independent acceptance checks`。
7. 十一类伪修复分别被独立验收拒绝。
8. 临时工作区不生成 `__pycache__` 或 `.pyc`。

## 材料隔离

| 用途 | Agent 可见材料 | 私有材料 |
| --- | --- | --- |
| Agent 行为评测 | `initial/` 和用户请求 | `solution.patch`、`acceptance.py`、`reviewer-report.md` |
| 固定补丁复验 | `initial/`、`solution.patch`、`acceptance.py`、`run.sh` | 无 |
| CI | `run.sh` 及其依赖文件 | 无 |

被测 Agent 只能修改 `app/`，不能修改测试、探针、文档或读取私有材料。正式评测应把私有材料放在 Agent 无法访问的位置；仅靠提示词和命令文本检测不构成文件系统隔离。

## 覆盖范围

- 本人读取、他人被拒、第二个用户读取自己的订单和跨订单越权。
- 缺失订单返回 `None`，缺失、空或伪造身份不返回订单内容。
- `get_order` 抛出 `PermissionError`，订单详情接口返回 200、403 和 404。
- admin 导出不受所有权限制，但必须继续校验 admin 角色。
- 运行时生成订单、固定订单归属变更和动态归属变更，防止硬编码映射或导入时快照。
- 标量、部分字段、嵌套容器、返回错误文本和越权异常对象中的订单值泄露。

未覆盖 `request["user_id"]` 的上游可信性、真实鉴权中间件和并发请求。夹具没有 HTTP 或数据库层，因此身份绑定只能作为待验证风险记录。

## 复验边界

`run.sh` 证明固定补丁能通过断言、十一类伪修复会被拒绝，不证明真实 Agent 会遵守流程。Agent 是否选择 `full`、是否完成独立审查以及是否读取私有材料，需要由行为 runner 的事件、diff 和隐藏验收共同判断。

`reviewer-report.md` 是历史审查证据，不因当前目录或场景 ID 调整而重新解释原结论。
