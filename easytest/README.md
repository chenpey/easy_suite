# EasyTest

EasyTest 是面向场景、HTTP、RPC、数据库和封装 UI 请求的 XLSX 表格驱动测试框架。
人工维护 XLSX，框架生成确定性 JSON，用于执行、Git diff、代码审查和 AI 分析。

当前版本：`0.2.0`。支持 Python 3.12 和 3.13。

## 文档入口

- [新业务接入指南](docs/新业务接入指南.md)：从初始化项目到真实接口、Mock、快照和 CI。
- [AI 接入与执行指南](docs/AI接入与执行指南.md)：AI 修改、预检、授权、执行和结果分析规程。
- [安装包契约](src/easytest/CONTRACT.md)：随 wheel 分发的版本化字段与 API 契约。
- [JSONPlaceholder Demo](examples/jsonplaceholder/README.md)：默认离线、可切换公开接口。
- [业务 handler 示例](examples/business_handler/README.md)：独立安装业务适配器。

## 快速开始

在本目录安装并初始化一个独立业务项目：

```bash
uv sync
uv run easytest init ../my-tests
uv run easytest run --root ../my-tests
```

生成的业务项目包含 Excel 用例、配置、pytest 入口、README 和 AI 指南。
已有非空目录会拒绝覆盖。

常用命令：

```bash
easytest list
easytest validate --case-id http.demo
easytest run --case-id http.demo
easytest run --result artifacts/result.json
easytest edit cases/demo.xlsx --patch edit.json
easytest compile cases --check
pytest
```

`--case-id` 精确匹配、可重复使用。未知或禁用 ID、空选择、重复 Case ID 都会失败。

## 用例来源

普通项目只维护 XLSX，并提交框架生成的同名 JSON：

- XLSX 是人工维护的唯一权威源。
- JSON 是确定性编译产物，不应手工修改。
- `run` 自动编译 XLSX。
- `list` 和 `validate` 只在内存读取，不写文件。
- `compile --check` 检查 JSON 缺失、手改、版本或哈希过期。
- 删除或重命名 XLSX 时必须同步处理旧 JSON。

JSON-only 仅用于纯代码或机器生成项目，必须显式设置
`source_mode: "json"`，且不能携带 XLSX 生成元数据。

## 结构化编辑 XLSX

AI 和脚本优先使用 `easytest edit`，避免直接操作单元格或误改生成的 JSON。

```json
{
  "operations": [
    {
      "entity": "case",
      "action": "update",
      "case_id": "user.get",
      "values": {"variables": {"user_id": 1001}}
    },
    {
      "entity": "step",
      "action": "update",
      "case_id": "user.get",
      "step_id": "get_user",
      "values": {"request": {"path": {"user_id": "${variables.user_id}"}}}
    }
  ]
}
```

```bash
easytest edit cases/demo.xlsx --patch edit.json
```

补丁支持 `case/step` 的 `add/update/rename/delete`：

- 查找严格按 ID，不会把错误的更新目标静默新增。
- Case 重命名会同步更新 steps 引用。
- 多个关联修改在一个批次中校验。
- 完整工作簿有效且原文件未被并发修改后才替换。
- 成功后自动更新同名 JSON。

也可重复使用 `--operation '{...}'` 直接传入操作。

## 严格校验与执行前预检

```bash
easytest list cases --root /业务目录
easytest validate cases --root /业务目录 --case-id user.get --profile live
easytest run cases --root /业务目录 --case-id user.get --profile live
```

`validate` 不访问业务服务、不导入 handler、不创建报告或快照，也不生成 JSON。
整批预检通过后，`run` 才执行第一步。检查范围包括：

- Case、Step、Excel 列、字段类型、唯一 ID、顺序和输出别名。
- 断言操作符、模板引用、operation 与 executor 对应关系。
- HTTP 参数、URL、路径参数、超时、重试和环境变量。
- 数据库 SQL 类型、绑定参数、连接和写权限。
- Mock、快照规则、静态基线和 handler 引用。

动态步骤输出、状态、handler 内部行为和运行后产物会列入 `data.deferred`，
并在执行时继续校验。

## 配置按需添加

| 文件 | 用途 |
| --- | --- |
| `config/operations.json` | 必需；HTTP、SQL 或 handler 定义 |
| `config/runtime.json` | 默认 Profile、快照后端、数据库和观测设置 |
| `config/profiles.json` | 离线、测试环境等运行预设 |
| `config/mock_profiles.json` | Mock preset 和 Profile |
| `config/snapshots.json` | 快照规则 |

凭据只从业务项目 `.env` 或进程环境读取。项目 `.env` 使用私有映射，不修改
`os.environ`；进程环境优先。SQL 固定在 operation 中，用例只提供绑定参数。

数据库写权限由 `allow_db_write` 独立控制。`run_mode=read` 只表示读取快照，
不能阻止 HTTP POST、RPC 或 handler 产生业务写入。

### 执行策略

可信宿主可设置不可由命令行覆盖的策略：

```bash
export EASYTEST_EXECUTION_POLICY=/trusted/easytest-policy.json
easytest run cases --root /业务目录 --profile live
```

```json
{
  "schema_version": 1,
  "allowed_profiles": ["live"],
  "allowed_case_ids": ["user.get"],
  "allowed_operations": ["http.get_user"],
  "allowed_executors": ["http"],
  "allowed_http_methods": ["GET"],
  "allowed_http_origins": ["https://qa.example.com"]
}
```

也可显式使用 `--execution-policy`。所有 allowlist 精确匹配；单独的 `"*"`
表示明确放开该维度。受策略保护的 HTTP operation 必须设置
`allow_redirects=false`，防止重定向绕过 origin 限制。自定义 executor 默认拒绝。

执行策略是应用层门禁，不替代操作系统网络沙箱；获准的 handler 仍属于受信任代码。

## XLSX 契约

工作簿必须包含 `cases` 和 `steps` 两张 sheet，不允许公式单元格。

`cases` 必填：

| 列 | 含义 |
| --- | --- |
| `case_id` | 全局唯一 ID，仅允许字母、数字、`.`、`_`、`-` |
| `case_name` | 用例名称 |
| `case_type` | `scenario`、`http` 或 `rpc` |

`steps` 必填：

| 列 | 含义 |
| --- | --- |
| `case_id` | 所属 Case |
| `step_id` | Case 内唯一 ID |
| `order` | 唯一正整数 |
| `executor` | `scenario/http/rpc/database/ui` |
| `operation` | `operations.json` 中的操作名 |

`variables` 和 `request` 填 JSON object；`expect/mock/snapshot` 填 JSON。
模板支持 `${variables.id}`、`${steps.created.body.id}` 和 `${state.value}`。
完整字段契约以随包 [CONTRACT.md](src/easytest/CONTRACT.md) 为准。

## 操作与适配器

- HTTP：method、URL、headers、timeout、expected status 和安全重试。
- Database：MySQL/SQLite、绑定参数、读写声明和独立写权限。
- Scenario：内置 `set/get/wait` 或业务 handler。
- RPC/UI：由业务安装包提供 handler。

RPC handler：

```python
def call_rpc(*, request, endpoint, auth, context):
    return {"code": "SUCCESS"}
```

Scenario/UI handler：

```python
def call_business(*, request, context):
    return {"ok": True}
```

普通返回值完整保留。需要 artifact 或 metadata 时返回 `ExecutionResult`。
业务 SDK 和内部基础设施适配器不进入通用核心。

## Mock

Mock 优先级为 Step > Case Mock Profile > 运行 Profile 默认 Mock Profile。
内置类型包括：

- `response`
- `sequence`
- `inject`
- `timeout`
- `exception`
- `service_rejected`
- `state`

`offline-strict` 会阻止任何未得到 Mock 结果的真实 Executor 调用，但它不是网络沙箱。

## Snapshot

支持 response、database 和 screenshot 快照，以及字段忽略、金额/日期归一化、
无序列表和正则替换。

| 模式 | 行为 |
| --- | --- |
| `read` | 只比对已有基线 |
| `write` | 创建缺失基线；已有内容不同则失败 |
| `baseline` | 更新基线；必须设置 `CONFIRM_BASELINE=1` |

文件后端先暂存本 Case 的变更，仅在步骤和资源清理全部成功后统一替换；提交失败会
尝试恢复原文件。SQLite 后端保留成功运行历史，失败运行不会成为基线。强制终止
进程时不承诺跨文件事务。

## 报告与机器结果

`run` 和 pytest 默认生成自包含的 `artifacts/report.html`，内嵌完整 PDF 和脱敏
JSON。可通过 `--no-report` 关闭，或用 `--report` 指定路径。

CLI 的 `list/validate/run/edit` 使用统一 JSON 封装：

```text
schema_version, command, status, data, errors, artifacts
```

`run --result` 将 stdout 的同一 JSON 原子写入文件。日志和事件写入 stderr。
`validate.data.input_hash` 与 `run.data.input_hash` 覆盖所选 Case、框架配置、
运行设置和执行策略；不包含环境变量值、handler 源码或外部状态。

## Notebook 手动测试

推荐使用 VS Code，并安装 notebook 可选依赖：

```bash
uv sync --extra notebook
```

```python
from easytest.notebook import NotebookSession

with NotebookSession("examples/jsonplaceholder", profile="offline-strict") as session:
    result = session.run_case(
        "cases/demo.xlsx",
        case_id="jsonplaceholder.user_posts",
    )
```

每次 `run_case` / `run_step` 都是独立 Case，不延续上次调用的 state、步骤输出或
默认 HTTP Session。同一 operation 的不同数据场景应显式设置稳定的
`case_id/step_id`。

## 运行仓库示例

```bash
uv run easytest run --root examples/jsonplaceholder
uv run easytest run mock_cases --root examples/jsonplaceholder
uv run pytest -c examples/jsonplaceholder/pytest.ini \
  examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder
```

默认 Profile 为 `offline-strict`，无需账号或外部服务。真实公开接口演示见
[Demo 文档](examples/jsonplaceholder/README.md)。

## 开发验证

```bash
uv sync
uv run pytest
uv run ruff check src tests scripts
uv build --wheel --offline
```

测试数据位于 `tests/fixtures/project/`。重新生成固定工作簿和截图时执行：

```bash
uv sync --extra examples
uv run python scripts/generate_test_fixtures.py
```

## 维护边界

- Runner 顺序执行，不保证并发安全。
- pytest-xdist 暂不合并 EasyTest HTML 报告。
- 数据库每步独立连接并提交，不提供连接池。
- `stream=true` 仍会读取完整响应，不用于大文件流式下载。
- 不提供业务事务回滚、全局取消、恢复执行或分布式调度。
- 不内置 OpenAPI 导入、浏览器自动化、MCP 或业务 SDK。
