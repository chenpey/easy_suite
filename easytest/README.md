# EasyTest

EasyTest 是面向场景、HTTP、RPC、数据库和封装 UI 请求的 XLSX 表格驱动测试框架。人工维护 XLSX 用例，框架编译为确定性 JSON 用于执行、Git diff、代码审查和 AI 分析。

当前版本：`0.4.2`，支持 Python 3.12 和 3.13。

## 文档入口

- [新业务接入指南](docs/新业务接入指南.md)：面向业务测试人员的完整教程。
- [AI 接入与执行指南](docs/AI接入与执行指南.md)：AI 操作流程与交付规范。
- [安装包契约](src/easytest/CONTRACT.md)：随 wheel 分发的字段、命令与 API 契约。
- [JSONPlaceholder Demo](examples/jsonplaceholder/README.md)：公开 API 的离线和真实示例。
- [业务 handler 示例](examples/business_handler/README.md)：独立安装业务适配器。

## 快速开始

```bash
uv sync
uv run easytest init ../my-tests        # 初始化独立项目（默认 offline-strict）
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
easytest compile cases --check
pytest
```

IDE / Notebook 解释器配置见 [新业务接入指南：选择正确解释器](docs/新业务接入指南.md#21-在编辑器中选择正确解释器)。

## 用例与执行

- **XLSX 权威源**：业务项目维护 `cases/*.xlsx` 并提交同名编译 JSON；`run`、`list`、`validate` 优先复用哈希与编译器版本匹配的 JSON，`compile --check` 校验同步状态；纯 JSON 项目声明 `source_mode: "json"`。
- **结构化编辑**：通过 `easytest edit cases/demo.xlsx --patch edit.json --validate --root .` 支持 `case/step/data` 的 `add/update/rename/delete`，校验通过后原子替换 XLSX 并更新同名 JSON。
- **数据驱动**：在 `data` 页定义 `data_set/data_id/enabled` 及业务列，步骤和断言中通过 `${data.字段名}` 引用；完整单元格引用保留数字、布尔和空值类型。支持 `--case-id <case_id>`（全量启用行）或 `--case-id <case_id>.<data_id>`（单行）。
- **整批静态预检**：执行前校验字段、ID、模板、断言、operation、HTTP、数据库、Mock、快照和 handler 引用；`--fail-fast` 或 `--max-failures N` 可在失败时提前结束。

## 报告与配置

- **报告输出**：默认生成自包含 `artifacts/report.html`；显式传入 `--pdf-report artifacts/report.pdf`（或 Notebook 中 `session.write_pdf_report()`）导出 PDF。CLI stdout 与 `--result` 输出统一 JSON 封装（`schema_version, command, status, data, errors, artifacts`），`input_hash` 用于核对框架输入。
- **按需配置文件**：
  - `config/operations.json`（必需）：HTTP、SQL 或 handler 定义
  - `config/runtime.json`：默认 Profile、快照后端、数据库、HTTP 上限与脱敏键
  - `config/profiles.json`：离线、测试环境等运行预设
  - `config/mock_profiles.json`：Mock preset 与 Profile
  - `config/snapshots.json`：快照规则
- **安全与执行策略**：敏感配置使用 `.env` 或进程环境引用；可信宿主通过 `EASYTEST_EXECUTION_POLICY=/trusted/easytest-policy.json` 强制限定允许的 Profile、Case、operation、executor 及 HTTP method/origin。

## 操作与适配器

- **HTTP**：支持 method、URL、headers、timeout、expected_status、安全重试与响应体上限保护（默认 10 MiB，最高 64 MiB）。
- **Database**：支持 MySQL/SQLite、参数化 SQL、读写声明与 `allow_db_write` 独立写权限控制。
- **Scenario / RPC / UI**：内置 `set/get/wait` 或通过业务安装包提供自定义 handler；普通 dict 返回值完整保留，需要 artifact 或 metadata 时返回 `ExecutionResult`。

```python
def call_rpc(*, request, endpoint, auth, context):
    return {"code": "SUCCESS"}

def call_business(*, request, context):
    return {"ok": True}
```

- **浏览器 Cookie**：安装 `uv sync --extra browser-auth` 后可通过 `get_cookies` / `list_browser_profiles` 从本机 Chrome 或 Edge 读取指定 URL 的 Cookie。

## Mock 与快照

- **Mock**：优先级为 Step > Case Mock Profile > 运行 Profile，支持 `response`、`sequence`、`inject`、`timeout`、`exception`、`service_rejected` 和 `state`；`offline-strict` 模式下仅执行有 Mock 的步骤。
- **Snapshot**：支持 response、database 和 screenshot 快照，提供 `read`（比对）、`write`（补齐缺失基线）与 `baseline`（需 `CONFIRM_BASELINE=1` 更新基线）三种模式。SQLite 后端支持跨进程并发写不同 Case 及版本冲突检测（`SNAPSHOT_CONFLICT`），维护命令为 `easytest snapshot check` 与 `easytest snapshot maintain`。

## Notebook 手动测试

安装 `uv sync --extra notebook` 后在 VS Code / Jupyter 中交互调试：

```python
from easytest.notebook import NotebookSession

with NotebookSession("examples/jsonplaceholder", profile="offline-strict") as session:
    result = session.run_case("cases/demo.xlsx", case_id="jsonplaceholder.user_posts")
```

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

运行仓库示例：

```bash
uv run easytest run --root examples/jsonplaceholder
uv run easytest run mock_cases --root examples/jsonplaceholder
uv run pytest -c examples/jsonplaceholder/pytest.ini examples/jsonplaceholder/test_cases.py --easytest-root examples/jsonplaceholder
```
