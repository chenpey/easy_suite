# EasyTest

EasyTest 是面向场景、HTTP、RPC、数据库和封装 UI 请求的 XLSX 表格驱动测试框架。
人工维护 XLSX，框架生成确定性 JSON，用于执行、Git diff、代码审查和 AI 分析。

当前版本：`0.2.0`，支持 Python 3.12 和 3.13。

## 文档入口

- [新业务接入指南](docs/新业务接入指南.md)：面向业务测试人员的完整教程。
- [AI 接入与执行指南](docs/AI接入与执行指南.md)：AI 操作、安全与交付规程。
- [安装包契约](src/easytest/CONTRACT.md)：随 wheel 分发的字段、命令与 API 契约。
- [JSONPlaceholder Demo](examples/jsonplaceholder/README.md)：公开 API 的离线和真实示例。
- [业务 handler 示例](examples/business_handler/README.md)：独立安装业务适配器。

## 快速开始

在本目录创建独立业务项目：

```bash
uv sync
uv run easytest init ../my-tests
uv run easytest run --root ../my-tests
```

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

`init` 只写入新目录或空目录。生成项目默认使用 `offline-strict`，无需真实服务。

## 用例与执行

普通项目只维护 XLSX，并提交框架生成的同名 JSON：

- `run` 自动编译 XLSX。
- `list`、`validate` 只读，不生成 JSON、报告或快照。
- `compile --check` 检查 JSON 是否缺失、手改或过期。
- JSON-only 仅用于无人工表格维护需求的项目，必须显式声明 `source_mode: "json"`。

`--case-id` 精确匹配且可重复使用。整批预检通过后才执行第一步，静态检查覆盖
字段、ID、模板、断言、operation、HTTP、数据库、Mock、快照和 handler 引用。

AI 和脚本修改用例时使用结构化补丁：

```bash
easytest edit cases/demo.xlsx --patch edit.json
```

补丁支持 `case/step` 的 `add/update/rename/delete`，按 ID 严格查找，最终工作簿
有效后才替换 XLSX 并更新 JSON。格式见 [安装包契约](src/easytest/CONTRACT.md#来源与字段)。

## 报告与机器结果

`run` 和 pytest 默认生成自包含的 `artifacts/report.html`，内嵌 PDF 和脱敏 JSON。
CLI 的 `list/validate/run/edit` 使用统一封装：

```text
schema_version, command, status, data, errors, artifacts
```

`run --result` 将 stdout 的同一 JSON 原子写入文件；日志和事件写入 stderr。
`validate.data.input_hash` 与 `run.data.input_hash` 可用于核对所选 Case、配置、
运行设置和执行策略。该哈希不包含环境变量值、handler 源码或外部服务状态。

## 配置按需添加

| 文件 | 用途 |
| --- | --- |
| `config/operations.json` | 必需；HTTP、SQL 或 handler 定义 |
| `config/runtime.json` | 默认 Profile、快照后端、数据库和观测设置 |
| `config/profiles.json` | 离线、测试环境等运行预设 |
| `config/mock_profiles.json` | Mock preset 和 Profile |
| `config/snapshots.json` | 快照规则 |

凭据只从业务项目 `.env` 或进程环境读取。数据库写权限由 `allow_db_write` 独立控制。
`run_mode=read` 只表示读取快照，不能阻止 HTTP、RPC 或 handler 产生业务写入。

### 执行策略

可信宿主可通过绝对路径环境变量强制执行 allowlist：

```bash
export EASYTEST_EXECUTION_POLICY=/trusted/easytest-policy.json
easytest run cases --root /业务目录 --profile live
```

策略限制 Profile、Case、operation、executor 及 HTTP method/origin。命令行不能覆盖
环境变量指定的策略。策略格式和边界见 [安装包契约](src/easytest/CONTRACT.md#执行策略)。

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

普通返回值完整保留；需要 artifact 或 metadata 时返回 `ExecutionResult`。

## Mock

Mock 优先级为 Step > Case Mock Profile > 运行 Profile 默认 Mock Profile。
支持 `response`、`sequence`、`inject`、`timeout`、`exception`、
`service_rejected` 和 `state`。

`offline-strict` 阻止未获得 Mock 结果的真实 Executor 调用，但不是网络沙箱。

## Snapshot

支持 response、database 和 screenshot 快照，以及字段忽略、金额/日期归一化、
无序列表和正则替换。

| 模式 | 行为 |
| --- | --- |
| `read` | 只比对已有基线 |
| `write` | 创建缺失基线；已有内容不同则失败 |
| `baseline` | 更新基线；必须设置 `CONFIRM_BASELINE=1` |

文件后端在 Case 成功后统一提交；SQLite 后端只将成功运行作为基线。两者都不能
回滚已经提交的业务数据，强制终止时也不保证跨文件事务。

## Notebook 手动测试

推荐使用 VS Code，并安装 Notebook 依赖：

```bash
uv sync --extra notebook
```

```python
from easytest.notebook import NotebookSession

with NotebookSession("examples/jsonplaceholder", profile="offline-strict") as session:
    result = session.run_case("cases/demo.xlsx", case_id="jsonplaceholder.user_posts")
```

每次 `run_case` / `run_step` 都是独立 Case。同一 operation 的不同数据场景应显式
设置稳定的 `case_id/step_id`。

## 开发验证

```bash
uv sync
uv run pytest
uv run ruff check src tests scripts
uv build --wheel --offline
```

仓库示例：

```bash
uv run easytest run --root examples/jsonplaceholder
uv run easytest run mock_cases --root examples/jsonplaceholder
uv run pytest -c examples/jsonplaceholder/pytest.ini \
  examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder
```

框架 fixture 位于 `tests/fixtures/project/`；生成脚本位于 `scripts/`。

## 维护边界

- Runner 顺序执行，不保证并发安全。
- pytest-xdist 暂不合并 EasyTest HTML 报告。
- 数据库每步独立连接并提交，不提供连接池。
- `stream=true` 仍会读取完整响应，不用于大文件下载。
- 不提供业务事务回滚、全局取消、恢复执行或分布式调度。
- 不内置 OpenAPI 导入、浏览器自动化、MCP 或业务 SDK。
