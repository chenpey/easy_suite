# EasyTest

EasyTest 是面向场景、HTTP、RPC、数据库和封装 UI 请求的 XLSX 表格驱动测试框架。
人工维护 XLSX，框架生成确定性 JSON，用于执行、Git diff、代码审查和 AI 分析。

当前版本：`0.4.1`，支持 Python 3.12 和 3.13。

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
easytest run --pdf-report artifacts/report.pdf
easytest edit cases/demo.xlsx --patch edit.json --validate --root .
easytest run --fail-fast --result artifacts/result.json
easytest compile cases --check
pytest
```

`init` 只写入新目录或空目录。生成项目默认使用 `offline-strict`，无需真实服务。
TRAE CN、VS Code/Cursor、PyCharm 和 Notebook 的解释器选择方法见
[新业务接入指南：在编辑器中选择正确解释器](docs/新业务接入指南.md#21-在编辑器中选择正确解释器)。

## 用例与执行

普通项目只维护 XLSX，并提交框架生成的同名 JSON：

- `run` 优先复用来源哈希、正文校验和与编译器版本均匹配的同名 JSON，否则自动编译 XLSX。
- `list`、`validate` 同样复用有效 JSON；失效时只在内存解析 XLSX，不写入文件。
- `compile --check` 检查 JSON 是否缺失、手改或过期。
- JSON-only 仅用于无人工表格维护需求的项目，必须显式声明 `source_mode: "json"`。

`--case-id` 精确匹配且可重复使用。整批预检通过后才执行第一步，静态检查覆盖
字段、ID、模板、断言、operation、HTTP、数据库、Mock、快照和 handler 引用。

AI 和脚本修改用例时使用结构化补丁：

```bash
easytest edit cases/demo.xlsx --patch edit.json --validate --root . --profile offline-strict
```

补丁支持 `case/step/data` 的 `add/update/rename/delete`。数据行使用
`data_set + data_id` 严格定位；`rename` 修改 `data_id`。最终工作簿有效后才替换
XLSX 并更新 JSON。`--validate` 额外使用项目配置与策略预检该工作簿中的启用 Case，
失败时保留原 XLSX/JSON；默认只校验工作簿契约。
跨文件重复 ID 及完整运行选择仍需执行 `validate cases`。
格式见 [安装包契约](src/easytest/CONTRACT.md#来源与字段)。

## 数据驱动

同一流程需要覆盖多组输入时，在工作簿增加 `data` 页，并在 `cases.data_set`
引用数据集。`data` 页固定列为 `data_set/data_id/enabled`，其余列均为业务字段：

| data_set | data_id | enabled | username | password | expected_status |
| --- | --- | --- | --- | --- | --- |
| login_cases | valid | true | alice | correct | 200 |
| login_cases | wrong_password | true | alice | wrong | 401 |
| login_cases | empty_phone | true | bob | correct | 400 |

步骤的 `request/mock/expect/snapshot` 都可使用 `${data.username}`、
`${data.expected_status}` 等引用。完整单元格引用保留数字、布尔和空值类型。
框架会把每个启用数据行作为独立执行实例，分别初始化变量、步骤输出和状态；
报告显示数据集、`data_id`、Excel 行号及脱敏后的本次数据。

`--case-id login.case` 选择该 Case 的全部启用数据行；
`--case-id login.case.wrong_password` 只选择一个执行实例。`easytest init`
生成的 `sample.login` 是默认禁用的完整示例，启用后可直接观察三行展开结果。

## 报告与机器结果

`run` 和 pytest 默认生成包含脱敏 JSON 的自包含 `artifacts/report.html`，不调用
PDF 渲染。需要 PDF 时显式使用 `run --pdf-report artifacts/report.pdf`；
Notebook 使用 `session.write_pdf_report()`。
CLI 的 `list/validate/run/edit/snapshot` 使用统一封装：

```text
schema_version, command, status, data, errors, artifacts
```

`run --result` 将 stdout 的同一 JSON 原子写入文件；日志和事件写入 stderr。
`validate.data.input_hash` 与 `run.data.input_hash` 可用于核对所选 Case、配置、
运行设置和执行策略。该哈希不包含环境变量值、handler 源码或外部服务状态。
CLI 默认在普通 Case 失败后继续；`--fail-fast` 或 `--max-failures N` 停止后续 Case，
剩余项标为 `not_run`。已发生的业务写入不回滚；pytest 使用自身的 `-x/--maxfail`。

## 配置按需添加

| 文件 | 用途 |
| --- | --- |
| `config/operations.json` | 必需；HTTP、SQL 或 handler 定义 |
| `config/runtime.json` | 默认 Profile、快照后端、数据库和观测设置 |
| `config/profiles.json` | 离线、测试环境等运行预设 |
| `config/mock_profiles.json` | Mock preset 和 Profile |
| `config/snapshots.json` | 快照规则 |

配置凭据使用业务项目 `.env` 或进程环境。敏感 HTTP header 在 operation 中必须使用
环境引用；步骤中可引用当前 Case 的动态值，其来源仍需业务方管理。
`runtime.redaction.secret_keys/pii_keys` 可扩展报告和事件脱敏键，不能保证识别任意字段。
数据库写权限由 `allow_db_write` 独立控制。
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

- HTTP：method、URL、headers、timeout、expected status、安全重试和响应大小保护。
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

### 浏览器 Cookie

需要读取本机 Chrome 或 Edge Cookie 时安装可选依赖：

```bash
uv sync --extra browser-auth
```

```python
from easytest.transport.browser_auth import get_cookies, list_browser_profiles

profiles = list_browser_profiles("chrome")
cookies = get_cookies(
    "https://service.example.com/private",
    browser="chrome",
    profile=profiles[0],
)
```

读取会按目标 URL 过滤 domain、path、Secure、有效期和 partitioned Cookie，并从
浏览器数据库的一致性快照中解密。省略 `browser` 时使用随包配置的 `chrome`；
不会从当前目录或父目录隐式读取 `config/common.json`。

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

文件后端在 Case 成功后统一提交。SQLite 后端压缩 JSON 等文本 payload，图片使用
`snapshot_artifact_dir` 下的内容寻址文件，库内只保存路径、大小和 SHA-256。
同一 Case 的并发更新发生版本竞争时返回 `SNAPSHOT_CONFLICT`，不会静默覆盖基线。

SQLite 快照维护：

```bash
easytest snapshot check --root .
easytest snapshot maintain --root . --keep-failed 1
easytest snapshot maintain --root . --keep-failed 1 --compact
```

`maintain` 清理超过 24 小时的中断运行、超额失败记录和孤立图片，并执行 WAL
checkpoint；`--compact` 额外执行阻塞性的 `VACUUM`，只能在没有测试任务写入时运行。
两种后端都不能回滚已经提交的业务数据。

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
uv sync --extra browser-auth --extra notebook --extra examples
uv run pytest
uv run ruff check src tests scripts
uv run easytest compile examples --check
uv run easytest compile tests/fixtures/project/cases --check
uv build --wheel --offline
uv run python scripts/verify_wheel.py
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
- SQLite 快照存储允许多进程写不同 Case；同一 Case 的并发基线更新仅允许一个完成。
- 数据库每步独立连接并提交，不提供连接池。
- HTTP 默认限制解压后响应体为 10 MiB，超限显式失败；operation/request 只能降低
  项目上限，项目最多配置 64 MiB。`stream` 不能绕过上限，不用于大文件下载。
- 不提供业务事务回滚、全局取消、恢复执行或分布式调度。
- 不内置 OpenAPI 导入、浏览器自动化、MCP 或业务 SDK。
- 真实业务接入、独立 AI 首次接入、性能规模和 xdist 聚合仍未验收；单测与离线
  示例不代表生产验收。Case/Step 只浅层冻结，Runner 不跨线程共享。
