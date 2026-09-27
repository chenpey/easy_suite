# JSONPlaceholder Demo

本示例使用 [JSONPlaceholder](https://jsonplaceholder.typicode.com/guide/) 展示
EasyTest 的 HTTP、步骤关联、Mock、断言和报告。默认严格离线，无需账号。

以下命令均在仓库 `easytest/` 目录执行。

## 快速运行

```bash
uv sync --no-dev
uv run easytest run --root examples/jsonplaceholder
open examples/jsonplaceholder/artifacts/report.html
```

预期 3 个 Case、4 个步骤通过，步骤均为 `mocked: true`。

| Case | 场景 |
| --- | --- |
| `jsonplaceholder.get_user` | 查询用户 1 |
| `jsonplaceholder.user_posts` | 查询用户后使用返回 ID 查询文章 |
| `jsonplaceholder.create_post` | 模拟创建文章并校验回显 |

创建接口返回的 `id=101` 不会持久化。本 Demo 不为 POST 配置重试。

## 真实接口

先只读预检，再执行：

```bash
uv run easytest validate cases --root examples/jsonplaceholder --profile live
uv run easytest run --root examples/jsonplaceholder --profile live \
  --report artifacts/live.html
```

正常情况下发送 4 次请求，其中一次为 JSONPlaceholder 的模拟 POST；所有步骤应为
`mocked: false`。`--run-mode read` 只控制快照，不能阻止 POST。公开服务异常或
网络不可达会使命令失败。

## Mock 示例

```bash
uv run easytest run mock_cases \
  --root examples/jsonplaceholder \
  --profile offline-strict \
  --report artifacts/mock.html
```

预期 4 个 Case、6 个步骤通过：

| 后缀 | 覆盖内容 |
| --- | --- |
| `inline` | Step 内联响应 |
| `overrides` | Case Profile 与 Step preset 优先级 |
| `sequence` | 503 后恢复为 200 |
| `rejected` | 429 业务拒绝响应 |

Mock 优先级为 Step > Case Mock Profile > 运行 Profile。`sequence` 计数只在当前
Case 内共享。模拟响应是执行器输出，因此 HTTP 示例包含 `status_code` 和 `body`。

## 预期失败

断言失败：

```bash
uv run easytest run failure_cases/wrong_user_id.xlsx \
  --root examples/jsonplaceholder \
  --profile offline-strict \
  --report artifacts/expected-failure.html
```

模拟超时和连接异常：

```bash
uv run easytest run failure_cases/mock_errors.xlsx \
  --root examples/jsonplaceholder \
  --profile offline-strict \
  --report artifacts/mock-errors.html
```

两条命令都应以非零状态退出，用于观察错误阶段、Excel 行号和失败报告。

## pytest

```bash
uv run pytest -c examples/jsonplaceholder/pytest.ini \
  examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder \
  --profile offline-strict \
  --easytest-report artifacts/pytest.html
```

默认发现 `cases/`，预期 `3 passed`。运行 Mock 用例时追加
`--case-source mock_cases`，预期 `4 passed`。

## 修改示例

```text
jsonplaceholder/
├── cases/            默认成功用例
├── mock_cases/       显式 Mock 成功用例
├── failure_cases/    预期失败用例
├── config/           operation、Profile、Mock 和 runtime
├── test_cases.py
└── pytest.ini
```

XLSX 是唯一用例源，同名 JSON 是提交到 Git 的编译产物。AI 或脚本优先使用：

```bash
uv run easytest edit examples/jsonplaceholder/cases/demo.xlsx --patch edit.json
uv run easytest compile examples/jsonplaceholder --check
```

完整业务接入见 [新业务接入指南](../../docs/新业务接入指南.md)，AI 操作规程见
[AI 接入与执行指南](../../docs/AI接入与执行指南.md)。
