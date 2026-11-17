# EasyTest 0.4.2 安装包契约

本文档定义随 EasyTest wheel 分发的稳定 CLI、XLSX/JSON 字段、执行策略、错误码与公共 Python API 契约。

## 命令与结果

```bash
easytest list cases --root /业务目录
easytest validate cases --root /业务目录 --case-id user.get --profile live
easytest run cases --root /业务目录 --case-id user.get --profile live
easytest run cases --root /业务目录 --pdf-report artifacts/report.pdf
easytest edit cases/demo.xlsx --patch edit.json --validate --root .
easytest compile cases --check
easytest snapshot check --root /业务目录
easytest snapshot maintain --root /业务目录 --keep-failed 1
```

- `list/validate` 为只读命令；`run` 在执行前编译并整批预检。`--case-id` 精确匹配且可重复指定；`--fail-fast` 与 `--max-failures N` 控制失败提前停止，剩余项标为 `not_run`。
- `list/validate/run/edit/snapshot` 的 stdout 输出统一 JSON 封装：`schema_version, command, status, data, errors, artifacts`。成功状态为 `listed/valid/passed/edited/healthy/maintained`，失败或中断返回 `failed/interrupted` 与非零退出码。`run --result PATH` 将该 JSON 原子写入文件，日志写入 stderr。
- `run` 默认生成独立 HTML 报告；传入 `--pdf-report PATH` 时同时生成 PDF 并在 `artifacts.pdf` 返回路径。

## 来源与字段

业务项目维护 XLSX 并提交同名编译 JSON（包含 `source_mode: "xlsx"`、`source`、`source_sha256`、`compiler_version`、`compiled_sha256`）。`run/list/validate/pytest` 自动校验并复用有效 JSON，`compile --check` 校验一致性；纯 JSON 项目声明 `source_mode: "json"`。

XLSX 包含必填 sheet `cases`、`steps` 与可选 sheet `data`（所有单元格使用纯值，无公式）：

| Sheet | 必填列 | 可选列 |
| --- | --- | --- |
| `cases` | `case_id/case_name/case_type` | `enabled/tags/variables/mock_profile/snapshot_profile/data_set` |
| `steps` | `case_id/step_id/order/executor/operation` | `request/save_as/mock/snapshot/expect` |
| `data` | `data_set/data_id` | `enabled` 及任意业务列 |

- `variables/request` 为 JSON object；Case type 支持 `scenario/http/rpc`，executor 支持 `scenario/http/rpc/database/ui`。ID 使用字母、数字及 `._-`。
- **共享数据集**：`cases.data_set` 引用同工作簿 `data` 页的数据集；启用的数据行展开为 `<case_id>.<data_id>`，各自拥有独立的 `variables`、`steps`、`state`、`generate` 与 `run_id`。
- **结构化编辑**：`easytest edit`（及 Python API `edit_workbook`）支持 `case/step/data` 的 `add/update/rename/delete`；`--validate` 在落盘前按项目配置预检工作簿，通过后原子更新 XLSX 与 JSON。

## 断言和模板

- 断言支持路径映射（`{"$.status_code": 200}`）与 `checks`（`equals/contains/in`），严格区分布尔与数字。
- 模板变量：`${variables.id}`、`${data.username}`、`${steps.created.body.id}`、`${state.value}`、`${BASE_URL}`（operation 环境变量）、`{id}`（HTTP 路径参数）。完整单元格引用保留原 JSON 类型。

## HTTP、数据库和 handler

- **HTTP request 字段**：`method, url, path, headers, params, data, json, retry, expected_status, raise_for_status, timeout, trust_env, verify, cookies, files, allow_redirects, cert, stream, max_response_bytes`。
- **响应体保护**：`runtime.http.max_response_bytes` 默认 10 MiB（最高 64 MiB），按解压后字节计数并计算完整 `sha256`；超限返回 `HTTP_RESPONSE_TOO_LARGE`。
- **凭据与脱敏**：operation 中的敏感 header 使用 `${ENV_NAME}` 引用；Step 与 inject Mock 引用 `${variables.*}/${steps.*}/${state.*}`。`runtime.json` 的 `redaction.secret_keys / pii_keys` 可扩展报告与事件脱敏键。
- **Database**：SQL 固定在 operation 中，request 仅使用 `parameters`；写入由 operation `write`、连接 `read_only` 与 `allow_db_write` 共同控制。
- **Handler 签名**：RPC 为 `(*, request, endpoint, auth, context)`；Scenario/UI 为 `(*, request, context)`。

## 执行策略

通过 `EASYTEST_EXECUTION_POLICY` 指定绝对路径策略 JSON，限定允许的 Profile、Case、operation、executor 及 HTTP method/origin（live HTTP 需声明 method/origin 且 `allow_redirects=false`；自定义 executor 需显式设置 `allow_custom_executors=true`）：

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

## Mock 与快照

- **Mock**：优先级 `Step > Case Mock Profile > 运行 Profile`，支持 `response/sequence/inject/timeout/exception/service_rejected/state`。
- **快照模式**：`read`（比对）、`write`（创建缺失基线）、`baseline`（需 `CONFIRM_BASELINE=1` 更新）。
- **SQLite 快照后端**：启用 WAL 与跨进程写锁，不同 Case 可并发执行，同 Case 并发更新返回 `SNAPSHOT_CONFLICT`。使用 zlib level 6 自适应压缩文本 payload；截图按 SHA-256 去重保存在 `runtime.snapshot_artifact_dir`（默认 `.easytest/snapshot-artifacts`），上限由 `snapshot_max_bytes`（默认 256 MiB，最大 1 GiB）控制。

## 错误契约

主要错误码：

```text
UNKNOWN_FIELD, INVALID_TYPE, INVALID_VALUE, INVALID_IDENTIFIER,
UNKNOWN_OPERATION, EXECUTOR_MISMATCH, UNKNOWN_PROFILE, MOCK_MISS,
EMPTY_SELECTION, UNKNOWN_CASE_ID, UNKNOWN_DATA_SET, EMPTY_DATA_SET,
DUPLICATE_DATA_ID, ORPHAN_COMPILED_JSON,
COMPILED_JSON_MISSING, COMPILED_JSON_OUT_OF_DATE,
INVALID_EDIT, EDIT_CONFLICT, EXECUTION_POLICY_VIOLATION,
HTTP_SECRET_SOURCE, HTTP_RESPONSE_TOO_LARGE,
ASSERTION_FAILED, ASSERTION_PATH_MISSING, SNAPSHOT_MISMATCH, SNAPSHOT_CONFLICT,
SNAPSHOT_TOO_LARGE, CLEANUP_FAILED, INTERRUPTED
```

## 公共 Python API

```python
from easytest import (
    Case,
    CaseRunner,
    DataRow,
    ExecutionPolicy,
    ExecutionResult,
    NotebookSession,
    Step,
    edit_workbook,
    load_project_cases,
)
```

`CaseRunner.run()` 自动预检单个 Case；批量执行前调用 `runner.preflight(cases)`。
