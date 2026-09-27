# EasyTest 0.2.0 安装包契约

本文是随 wheel 分发的最小稳定契约，不承担教程职责。业务项目未必拥有源码仓库
文档，`easytest init` 生成的 AI 指南因此引用本文件。运行时解析器和预检是最终
校验依据。

## 命令与结果

```bash
easytest list cases --root /业务目录
easytest validate cases --root /业务目录 --case-id user.get --profile live
easytest run cases --root /业务目录 --case-id user.get --profile live
easytest edit cases/demo.xlsx --patch edit.json
easytest compile cases --check
```

`list/validate` 只读；`run` 在执行前编译 XLSX 并整批预检。`--case-id` 精确、
区分大小写且可重复，未知、禁用或空选择失败。

`list/validate/run/edit` 的 stdout 使用统一封装：

```text
schema_version, command, status, data, errors, artifacts
```

成功状态为 `listed/valid/passed/edited`，失败或中断为 `failed/interrupted` 并返回
非零退出码。`run --result` 将同一 JSON 原子写入文件；日志和原始异常在 stderr。

`validate.data` 包含 `case_count/step_count/deferred/input_hash`；
`run.data` 包含 `summary/cases/input_hash`。哈希覆盖 Case、配置、运行设置和策略，
不覆盖环境变量值、handler 源码或外部状态。

## 来源与字段

普通项目只维护 XLSX，并提交同名 JSON。生成 JSON 固定包含：

- `source_mode: "xlsx"`
- 同目录 XLSX 文件名 `source`
- `source_sha256`
- `compiler_version`

直接加载 JSON 时会核对 XLSX、哈希和编译器版本。JSON-only 项目必须设置
`source_mode: "json"`，且不能包含上述生成元数据。

XLSX 必须包含 `cases` 和 `steps` 两张 sheet，不允许公式。

| Sheet | 必填列 | 可选列 |
| --- | --- | --- |
| `cases` | `case_id/case_name/case_type` | `enabled/tags/variables/mock_profile/snapshot_profile` |
| `steps` | `case_id/step_id/order/executor/operation` | `request/save_as/mock/snapshot/expect` |

`variables/request` 必须是 JSON object；其他 JSON 列允许对象、数组或标量。
Case type 为 `scenario/http/rpc`，executor 为
`scenario/http/rpc/database/ui`。ID 仅允许字母、数字及 `._-`，且不能为
`.` 或 `..`。Case ID 全局唯一；Step ID、正整数 order 和输出名在 Case 内唯一。

结构化编辑补丁：

```json
{"operations":[
  {"entity":"case","action":"update","case_id":"user.get",
   "values":{"variables":{"user_id":1001}}},
  {"entity":"step","action":"rename","case_id":"user.get",
   "step_id":"get","new_id":"get_user"}
]}
```

`entity` 为 `case/step`，`action` 为 `add/update/rename/delete`。操作按 ID 严格
匹配，最终工作簿通过完整校验后才替换并重新编译。

## 断言和模板

断言可以是路径映射：

```json
{"$.status_code":200,"$.body.ok":true}
```

也可以使用 `checks`，操作符仅支持 `equals/contains/in`。缺失路径失败；布尔与
数字严格区分，`1` 与 `1.0` 视为相同 JSON number。

模板：

| 写法 | 来源 |
| --- | --- |
| `${variables.id}` | 当前 Case 变量 |
| `${steps.created.body.id}` | 前序步骤输出 |
| `${state.value}` | 当前 Case 状态 |
| `${BASE_URL}` | operation 中的环境变量 |
| `{id}` | HTTP URL 的 `request.path.id` |

完整模板保留原类型；结构值只能占据整个单元格。

## HTTP、数据库和 handler

HTTP request 支持：

```text
method, url, path, headers, params, data, json, retry, expected_status,
raise_for_status, timeout, trust_env, verify, cookies, files,
allow_redirects, cert, stream
```

`data` 是表单或原始体，`json` 是 JSON 请求体。POST 默认不重试。

数据库 SQL 固定在 operation 中，用例只提供绑定参数。内置数据库写入同时受
operation `write`、连接 `read_only` 和 `allow_db_write` 控制。

RPC handler 签名为 `(*, request, endpoint, auth, context)`；
Scenario/UI handler 为 `(*, request, context)`。普通返回值完整保留，需要
artifact 或 metadata 时返回 `ExecutionResult`。

## 执行策略

`run/validate/pytest/NotebookSession` 可接收执行策略。可信宿主应设置绝对路径：

```bash
export EASYTEST_EXECUTION_POLICY=/trusted/easytest-policy.json
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

所有 allowlist 精确匹配，单独的 `"*"` 表示明确放开该维度。Live HTTP 必须声明
method/origin，并设置 `allow_redirects=false`。动态且无法静态确认的 HTTP 目标
拒绝执行。自定义 executor 默认拒绝；允许时设置 `allow_custom_executors=true`，
并将获准 operation 视为受信任代码。

策略是应用层门禁，不替代操作系统网络沙箱。

## Mock 与快照

Mock 优先级为 Step > Case Mock Profile > 运行 Profile。支持 `response`、
`sequence`、`inject`、`timeout`、`exception`、`service_rejected` 和 `state`。
`offline-strict` 阻止未获得 Mock 结果的真实 Executor 调用。

快照模式：

- `read`：只读取并比较。
- `write`：创建缺失快照，已有内容不同则失败。
- `baseline`：替换快照，必须设置 `CONFIRM_BASELINE=1`。

文件后端在 Case 成功后统一提交；SQLite 只将成功运行作为基线。两者都不回滚业务
副作用，强制终止时不保证跨文件事务。

## 错误契约

框架错误包含稳定 `code/field`，已知时附
`case_id/step_id/operation/source/source_row`。主要 code：

```text
UNKNOWN_FIELD, INVALID_TYPE, INVALID_VALUE, INVALID_IDENTIFIER,
UNKNOWN_OPERATION, EXECUTOR_MISMATCH, UNKNOWN_PROFILE, MOCK_MISS,
EMPTY_SELECTION, UNKNOWN_CASE_ID, ORPHAN_COMPILED_JSON,
COMPILED_JSON_MISSING, COMPILED_JSON_OUT_OF_DATE,
INVALID_EDIT, EDIT_CONFLICT, EXECUTION_POLICY_VIOLATION,
ASSERTION_FAILED, ASSERTION_PATH_MISSING, SNAPSHOT_MISMATCH,
CLEANUP_FAILED, INTERRUPTED
```

任意业务异常在机器结果中只保留安全概述；原始消息、notes 和 traceback 在本地
stderr。敏感字段、长值和异常序列化失败会脱敏或截断。

## 公共 Python API 与边界

```python
from easytest import (
    Case,
    CaseRunner,
    ExecutionPolicy,
    ExecutionResult,
    NotebookSession,
    Step,
    edit_workbook,
    load_project_cases,
)
```

`CaseRunner.run()` 自动预检单个 Case。自行批量执行时先调用
`runner.preflight(cases)`。Notebook 的每次 `run_case/run_step` 都是独立 Case；
不同数据场景应显式设置稳定 ID。

Runner 顺序使用且不保证并发安全；pytest-xdist 不合并 EasyTest HTML 报告。
数据库每步独立连接提交，HTTP `stream=true` 仍读取完整响应。框架不提供业务事务
回滚、全局取消、恢复执行、浏览器自动化、OpenAPI 导入或分布式调度。
