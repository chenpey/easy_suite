# JSONPlaceholder Demo

使用 [JSONPlaceholder](https://jsonplaceholder.typicode.com/guide/) 的公开接口，
演示 EasyTest 的 Excel 用例、路径参数、步骤关联、POST JSON、断言与 HTML 报告。
无需注册账号或配置 Token；默认使用离线 Mock，添加 `--profile live` 才访问公开服务。
希望学习显式 Mock 配置，可直接运行下方的 [Mock 示例](#mock-示例全离线)。

## 快速运行

以下命令均在仓库的 `easytest/` 目录（包含 `pyproject.toml`）执行：

```bash
uv sync --no-dev
uv run easytest run --root examples/jsonplaceholder
open examples/jsonplaceholder/artifacts/report.html
```

预期 **3 条用例、4 个步骤全部通过**，终端摘要中所有步骤均为 `mocked: true`。
报告可以离线打开；`open` 为 macOS 命令，其他系统直接双击 HTML。
首次安装依赖需要网络，安装完成后这组用例不需要网络。

## 用例内容

| 用例 ID | 请求 | 校验内容 |
| --- | --- | --- |
| `jsonplaceholder.get_user` | `GET /users/1` | 状态码 200、用户 ID、存在 name 和 username 字段 |
| `jsonplaceholder.user_posts` | `GET /users/1` → `GET /posts?userId=1` | 用第一步返回的用户 ID 查询文章，并校验第一篇文章属于该用户 |
| `jsonplaceholder.create_post` | `POST /posts` | 状态码 201、返回 ID 101、回显 title / body / userId |

每条用例独立运行，不依赖其他用例的执行顺序。
文章列表检查第一项，不表示验证了列表中所有文章。
离线响应只保留演示需要的数据；离线通过表示用例能在这些 Mock 响应上执行，
真实接口行为需通过 live 运行验证。

JSONPlaceholder 的写操作只模拟成功，**不会持久化数据**。
创建返回的 `id=101` 不能用于随后 GET 验证，也不需要清理。
本 Demo 不为 POST 配置重试。

## 运行真实接口

先做只读预检，不发送请求，也不生成编译 JSON 或报告：

```bash
uv run easytest validate cases --root examples/jsonplaceholder --profile live
```

通过后运行同一组 Excel 用例：

```bash
uv run easytest run --root examples/jsonplaceholder --profile live --report artifacts/live.html
open examples/jsonplaceholder/artifacts/live.html
```

该命令正常执行时共发送 4 次请求，其中 1 次为模拟创建文章的 POST。
`cases/demo.xlsx` 中没有固定 Mock，因此所有步骤摘要应为 `mocked: false`。
`validate` 输出中的 `data.deferred` 表示前序响应等动态数据需在执行时检查。
`--run-mode read` 仅控制快照，不能阻止 HTTP POST。

公开服务受网络和可用性影响，网络错误会按失败退出；请查看终端错误与报告中的
失败阶段。离线运行可单独验证框架和用例配置，不能替代真实接口验证。

## Mock 示例（全离线）

`mock_cases/demo.xlsx` 提供 **4 条用例、6 个步骤**，全部使用模拟响应：

```bash
uv run easytest validate mock_cases --root examples/jsonplaceholder --profile offline-strict
uv run easytest run mock_cases --root examples/jsonplaceholder --profile offline-strict --report artifacts/mock.html
open examples/jsonplaceholder/artifacts/mock.html
```

预期全部通过，所有步骤均为 `mocked: true`。这些用例需显式选择 `mock_cases`；
原来的默认 `cases/` 仍为三条公开接口用例。

| 用例 ID 后缀（前缀为 `jsonplaceholder.mock.`） | 演示方式 | 预期结果 |
| --- | --- | --- |
| `inline` | Step 的 `mock` 单元格直接填写 `response`，响应引用用例变量 | 返回自定义用户 7，校验名称 `Mock Demo User` |
| `overrides` | Case 指定 `missing_user`；第二步用 Step 预设 `user_found` 覆盖 | 第一步返回 404，第二步返回用户 1 |
| `sequence` | 两个步骤引用同一 `user_recovers` 预设 | 依次收到 503、200，分别校验 |
| `rejected` | 引用 `service_rejected` 类型的 `rate_limited` 预设 | 返回 429 和 `RATE_LIMITED`，符合预期所以通过 |

这些故障响应是本地构造的示例，不表示 JSONPlaceholder 承诺返回相同错误格式。

打开 Excel，在 `steps.mock` 单元格中填写 JSON。例如内联响应：

```json
{
  "kind": "response",
  "response": {
    "status_code": 200,
    "body": {"id": "${variables.user_id}", "name": "Mock Demo User"}
  }
}
```

重复使用的响应定义在 `config/mock_profiles.json` 的 `presets` 中，
Excel 只需引用名称：

```json
{"preset": "user_found"}
```

Mock 选择顺序为 **Step 的 `mock` → Case 的 `mock_profile` → 运行 Profile**。
`mock` 留空才会继承；JSON 布尔值 `false` 会禁用回退，严格离线模式此时会阻止真实执行。
`cases.mock_profile` 填写的是 `mock_profiles.json` 中的配置名，例如 `missing_user`，
不是命令行的 `offline-strict`。原默认用例使用运行 Profile 的 `offline` Mock，
因此两组用例一起展示了三层配置方式。

`sequence` 在同一 Case、同一 operation 的连续 Mock 调用间共享计数，新 Case 重新计数。
本例在 Excel 明确写了两个步骤，**不涉及自动重试**。
预设配置 `repeat_last: false`，第三次读取会报序列耗尽。

模拟响应直接返回执行器输出，应包含 `status_code` 和 `body`。
它不经过真实 HTTP 执行器的 `expected_status` 检查，因此每个步骤都在 `expect` 中
校验状态码；404 / 503 / 429 步骤也同步填写了相应 `request.expected_status`。
`service_rejected` 返回拒绝响应，本身不会抛异常。

这些用例显式指定了 Step 或 Case Mock，即使选择 `--profile live` 也仍使用 Mock；
真实接口验证请运行原来的 `cases/`。

### 模拟超时与连接异常

`failure_cases/mock_errors.xlsx` 包含两条故意失败的用例：

| 用例 ID 后缀 | Step Mock 预设 | 结果 |
| --- | --- | --- |
| `timeout` | `request_timeout`：`kind=timeout`、`delay_seconds=0` | 立即抛出 `TimeoutError` |
| `connection_error` | `connection_error`：`kind=exception`、`exception=ConnectionError` | 抛出 `ConnectionError` |

```bash
uv run easytest run failure_cases/mock_errors.xlsx \
  --root examples/jsonplaceholder --profile offline-strict \
  --report artifacts/mock-errors.html
```

命令应以非零退出码结束，报告列出 **2 条失败用例**，阶段均为 `execute`，
并标明错误类型和 Excel 行号。CLI 完成两条用例后抛出首个异常。
单独打开报告：

```bash
open examples/jsonplaceholder/artifacts/mock-errors.html
```

这两种 Mock 在产生响应前抛异常，当前报告中失败步骤的 `mocked` 标记可能仍为
`false`；它不表示已发出请求。这组示例使用严格离线模式，不执行真实 HTTP。

## pytest 与 CI

CLI 可直接保存与 stdout 相同的 JSON 结果：

```bash
uv run easytest run --root examples/jsonplaceholder --result artifacts/result.json
```

`schema_version=1` 的封装同时用于成功与失败：顶层 `status` 表示运行状态，
`data.summary` 保存统计，`data.cases[].steps[]` 包含步骤的 `mocked`、状态和错误。
事件输出到 stderr，stdout 保持一个 JSON 对象；失败仍以非零退出码结束。

从 `easytest/` 目录执行：

```bash
uv run pytest -c examples/jsonplaceholder/pytest.ini examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder --profile offline-strict \
  --easytest-report artifacts/pytest.html \
  --junitxml=examples/jsonplaceholder/artifacts/junit.xml
```

预期 `3 passed`；HTML 用于查看请求、响应和步骤，JUnit XML 可交给 CI 统计。
如需真实请求，将 `--profile offline-strict` 改为 `--profile live`。
pytest 默认只发现 `cases/`。运行 Mock 成功用例时，显式指定来源：

```bash
uv run pytest -c examples/jsonplaceholder/pytest.ini examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder --case-source mock_cases --profile offline-strict \
  --easytest-report artifacts/mock-pytest.html
```

预期 `4 passed`。故意失败用例均在 `failure_cases/`，不会被上述两条 pytest 命令选中。

## 演示一次断言失败

`failure_cases/wrong_user_id.xlsx` 查询用户 1，却故意期望 `$.body.id` 为 999。
它位于默认 `cases/` 之外，需显式选择：

```bash
uv run easytest run failure_cases/wrong_user_id.xlsx \
  --root examples/jsonplaceholder --profile offline-strict \
  --report artifacts/expected-failure.html
```

此命令**应该以非零退出码结束**，终端包含 `expected 999, got 1`。
随后单独打开报告：

```bash
open examples/jsonplaceholder/artifacts/expected-failure.html
```

报告应显示 1 条失败用例，步骤阶段为 `assertion`，
来源为 `wrong_user_id.xlsx` 的 `steps` 第 2 行。
具体断言错误查看本地终端；共享报告不包含任意异常原文。
它演示普通断言失败，不会生成快照差异。

## 修改 Demo

```text
jsonplaceholder/
├── cases/
│   ├── demo.xlsx                 日常维护的三条成功用例
│   └── demo.json                 自动编译结果
├── mock_cases/
│   ├── demo.xlsx                 四条显式 Mock 成功用例
│   └── demo.json                 自动编译结果
├── failure_cases/
│   ├── wrong_user_id.xlsx        故意错误的断言
│   ├── wrong_user_id.json        自动编译结果
│   ├── mock_errors.xlsx          Mock 超时、连接异常
│   └── mock_errors.json          自动编译结果
├── config/
│   ├── operations.json          三个公开 HTTP 接口
│   ├── runtime.json             默认离线、关闭数据库写入
│   ├── profiles.json            offline-strict / live
│   └── mock_profiles.json       离线响应、可复用预设与 Case Mock 配置
├── test_cases.py                 pytest 入口
├── pytest.ini
└── README.md
```

编辑 `cases/demo.xlsx` 的 `cases` 与 `steps` 工作表。`variables`、`request`、
`expect` 单元格均为 JSON，表头批注说明了各列用途。
XLSX 是唯一用例源，运行时自动生成同名 JSON；不要只修改生成的 JSON。
XLSX 和 JSON 一起提交，JSON 用于 Git diff、代码审查和 AI 分析。
AI 或脚本修改时优先使用结构化补丁；手工编辑后再更新产物并做只读检查：

```bash
uv run easytest edit examples/jsonplaceholder/cases/demo.xlsx --patch edit.json
uv run easytest compile examples/jsonplaceholder/cases/demo.xlsx
uv run easytest compile examples/jsonplaceholder --check
```

生成 JSON 记录对应 XLSX 的 SHA-256 和编译器版本；`--check` 不写文件，
任一配对 JSON 缺失、被手改或过期都会失败。

步骤关联用例的第一步设置 `save_as=user`，第二步的请求为：

```json
{"params": {"userId": "${steps.user.body.id}"}}
```

对应断言：

```json
{
  "$.status_code": 200,
  "$.body[0].userId": "${steps.user.body.id}"
}
```

POST 用例通过 `${variables.title}`、`${variables.post_body}`、
`${variables.user_id}` 填充请求体与预期值。改变查询用户时，需要同步维护离线响应；
Mock 配置不承担真实服务的数据校验。

也可把此目录复制为独立业务项目，在新目录安装本地框架后直接运行：

```bash
uv venv --python 3.12
uv pip install /本机/easy_suite/easytest
source .venv/bin/activate
easytest run
pytest
```

进一步接入自己的业务，请参阅 [新业务接入指南](../../docs/新业务接入指南.md)；
使用 AI 编辑和执行用例，请参阅 [AI 接入与执行指南](../../docs/AI接入与执行指南.md)。
