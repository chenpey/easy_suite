# JSONPlaceholder Demo

本示例使用 [JSONPlaceholder](https://jsonplaceholder.typicode.com/guide/) 展示 EasyTest 的 HTTP 请求、步骤关联、Mock、断言与报告生成，默认运行在严格离线模式。以下所有命令均在 `easytest/` 目录执行。

## 快速运行（离线 Mock）

```bash
uv sync --no-dev
uv run easytest run --root examples/jsonplaceholder
open examples/jsonplaceholder/artifacts/report.html
```

预期 3 个 Case、4 个步骤全部通过（`mocked: true`）：

| Case | 场景 |
| --- | --- |
| `jsonplaceholder.get_user` | 查询用户 1 |
| `jsonplaceholder.user_posts` | 查询用户并使用返回 ID 查询文章 |
| `jsonplaceholder.create_post` | 模拟创建文章并校验回显 |

## 真实接口

```bash
uv run easytest validate cases --root examples/jsonplaceholder --profile live
uv run easytest run --root examples/jsonplaceholder --profile live --report artifacts/live.html
```

## Mock 示例

```bash
uv run easytest run mock_cases --root examples/jsonplaceholder --profile offline-strict --report artifacts/mock.html
```

预期 4 个 Case、6 个步骤通过，覆盖 `inline`（Step 内联响应）、`overrides`（优先级覆盖）、`sequence`（503 恢复 200）与 `rejected`（429 业务拒绝）。

## 预期失败示例

```bash
uv run easytest run failure_cases/wrong_user_id.xlsx --root examples/jsonplaceholder --profile offline-strict --report artifacts/expected-failure.html
uv run easytest run failure_cases/mock_errors.xlsx --root examples/jsonplaceholder --profile offline-strict --report artifacts/mock-errors.html
```

用于观察断言失败、模拟超时/连接异常时的错误阶段、Excel 行号与失败报告。

## pytest 与用例编辑

```bash
uv run pytest -c examples/jsonplaceholder/pytest.ini examples/jsonplaceholder/test_cases.py --easytest-root examples/jsonplaceholder --profile offline-strict --easytest-report artifacts/pytest.html
uv run easytest edit examples/jsonplaceholder/cases/demo.xlsx --patch edit.json
uv run easytest compile examples/jsonplaceholder --check
```

更多说明见 [新业务接入指南](../../docs/新业务接入指南.md) 与 [AI 接入与执行指南](../../docs/AI接入与执行指南.md)。
