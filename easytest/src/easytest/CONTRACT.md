# EasyTest 0.4.0 安装包契约

本文是随 wheel 分发的最小稳定契约，不承担教程职责。业务项目未必拥有源码仓库
文档，`easytest init` 生成的 AI 指南因此引用本文件。运行时解析器和预检是最终
校验依据。

## 命令与结果

```bash
easytest list cases --root /业务目录
easytest validate cases --root /业务目录 --case-id user.get --profile live
easytest run cases --root /业务目录 --case-id user.get --profile live
easytest edit cases/demo.xlsx --patch edit.json --validate --root .
easytest compile cases --check
easytest snapshot check --root /业务目录
easytest snapshot maintain --root /业务目录 --keep-failed 1
```

`list/validate` 只读；`run` 在执行前编译 XLSX 并整批预检。`--case-id` 精确、
区分大小写且可重复，未知、禁用或空选择失败。

`list/validate/run/edit/snapshot` 的 stdout 使用统一封装：

```text
schema_version, command, status, data, errors, artifacts
```

成功状态为 `listed/valid/passed/edited/healthy/maintained`，失败或中断为
`failed/interrupted` 并返回
非零退出码。`run --result` 将同一 JSON 原子写入文件；日志和原始异常在 stderr。
`init/compile` 输出普通文本。CLI `run` 默认继续执行失败 Case 后的 Case；
`--fail-fast` 等价于 `--max-failures 1`，两个选项互斥，后者必须为正整数。
剩余 Case/Step 为 `not_run`，中断的当前 Case 为 `interrupted`。
pytest 使用自己的 `-x/--maxfail`；Notebook 每次独立调用，失败会抛出异常。

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

XLSX 必须包含 `cases` 和 `steps` 两张 sheet，可选 `data` sheet；所有 sheet
都不允许公式。

| Sheet | 必填列 | 可选列 |
| --- | --- | --- |
| `cases` | `case_id/case_name/case_type` | `enabled/tags/variables/mock_profile/snapshot_profile/data_set` |
| `steps` | `case_id/step_id/order/executor/operation` | `request/save_as/mock/snapshot/expect` |
| `data` | `data_set/data_id` | `enabled` 及任意业务列 |

`variables/request` 必须是 JSON object；其他 JSON 列允许对象、数组或标量。
Case type 为 `scenario/http/rpc`，executor 为
`scenario/http/rpc/database/ui`。ID 仅允许字母、数字及 `._-`，且不能为
`.` 或 `..`。Case ID 全局唯一；Step ID、正整数 order 和输出名在 Case 内唯一。

### 共享数据集

`cases.data_set` 引用同一工作簿 `data` 页中的数据集。`data_id` 在数据集内唯一，
`enabled` 省略时默认为 true；业务列名必须是 Python 风格标识符
（字母或下划线开头，后续可含数字）。编译 JSON 使用以下结构：

```json
{
  "data_sets": {
    "login_cases": [
      {
        "id": "wrong_password",
        "enabled": true,
        "values": {
          "username": "alice",
          "password": "wrong",
          "expected_status": 401
        },
        "source_row": 3
      }
    ]
  }
}
```

启用的 Case 会按其数据集中的启用行展开。逻辑 Case ID 保持不变，单行执行 ID
为 `<case_id>.<data_id>`。`--case-id <case_id>` 选择全部数据行，
`--case-id <case_id>.<data_id>` 只选择一行。引用不存在的数据集、重复
`data_id`、无启用行或非法业务列都会在编译/加载阶段失败。

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
匹配，最终工作簿通过契约校验后才替换并重新编译。`--validate --root ROOT`
使用项目配置对编辑后的工作簿内所有启用 Case 预检，可加 `--profile`、
`--execution-policy`；未指定 `--validate` 时不能指定后二者。
预检失败不替换 XLSX/JSON，不调用业务服务或 handler。整项目跨文件校验仍使用
`validate cases`；原子替换不等于 XLSX/JSON 的跨文件崩溃事务。
Python API 为 `edit_workbook(path, operations, *, validate=False, root=".",
profile=None, execution_policy=None)`；API 的 path 相对工作目录，CLI path 相对 `--root`。
Case 单元格错误附 sheet、行号、列头和原始/期望类型；文本 ID 不自动从数字或日期转换。

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
| `${data.username}` | 当前数据行字段 |
| `${steps.created.body.id}` | 前序步骤输出 |
| `${state.value}` | 当前 Case 状态 |
| `${BASE_URL}` | operation 中的环境变量 |
| `{id}` | HTTP URL 的 `request.path.id` |

完整模板保留原类型；结构值只能占据整个单元格。数据行之间分别创建
variables、steps、state、generate 和 run ID；任一行失败不会复用另一行的上下文。
报告会记录 `data_set/data_id/data_source_row` 以及脱敏后的 `data`。

## HTTP、数据库和 handler

HTTP request 支持：

```text
method, url, path, headers, params, data, json, retry, expected_status,
raise_for_status, timeout, trust_env, verify, cookies, files,
allow_redirects, cert, stream, max_response_bytes
```

`data` 是表单或原始体，`json` 是 JSON 请求体。`retry` 只接受配置对象，
不接受整数简写；POST 默认不重试。

`runtime.http.max_response_bytes` 默认 10485760（10 MiB），必须为正整数且不超过
67108864（64 MiB）；operation 可以降低上限，request 可以继续降低。无论 `stream`
真假均按块读取，重定向响应同样受限。计数针对解压后的字节，不依赖 Content-Length。
成功结果附 `response_bytes/sha256/hash_scope="complete"/truncated=false`。
超限抛出 `HTTP_RESPONSE_TOO_LARGE`，不重试、不执行断言或快照，也不保存步骤输出；
报告响应保留状态码、脱敏 headers/URL、`body=null`、`observed_bytes`、
`max_response_bytes`、`sha256`、`hash_scope="observed_prefix"` 与截断原因。
哈希仅对应已观察前缀，不能当完整响应校验和。限制的是读取体积，不是进程总内存。
大文件下载应由业务 handler 流式落盘，返回独立 `ExecutionResult.artifacts`；
内置 HTTP 不提供下载开关。

operation 的 `Authorization/Proxy-Authorization/Cookie/API-Key` 及含
`token/secret/password/apikey` 的 header 必须使用 `${ENV_NAME}`，支持前缀
`Bearer ` 或 `Basic `；显式 null 用于移除 header。Step 和 inject Mock 的敏感
header 只接受 `${variables.*}/${steps.*}/${state.*}` 引用，动态来源可信性由业务方负责。
该检查不证明任意 body/query/cookie-jar 中都没有凭据，配置不得保存真实密钥。

项目附加脱敏规则示例：

```json
{"redaction":{"secret_keys":["access_code"],"pii_keys":["customer_code"]},
 "http":{"max_response_bytes":10485760}}
```

写入 `runtime.json`；附加键不移除内置键，忽略键名大小写和分隔符并支持后缀匹配。
规则在 Runner 的报告、断言差异和事件中生效，执行结束恢复，项目间不共享。
URL 用户信息、敏感 query（含百分号编码的键）及 fragment 会脱敏。
原始 ExecutionResult、Notebook 交互输出、业务日志、快照基线及 artifact 文件仍可能
携带原始数据，需业务方管理；脱敏不能识别任意未知业务字段。

数据库 SQL 固定在 operation 中，request 只允许 `parameters` 字段；无参数 SQL
使用空 request。内置数据库写入同时受 operation `write`、连接 `read_only` 和
`allow_db_write` 控制。
`allow_db_write` 未配置时严格为 `false`，不会根据快照 `run_mode` 推断。

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

文件后端在 Case 成功后统一提交。SQLite 只将成功运行作为基线，启用 WAL、
30 秒 busy timeout 和跨进程写锁；不同 Case 可以并发执行。同一 Case 如果在运行
期间已有其他进程提交新基线，完成时返回 `SNAPSHOT_CONFLICT`，冲突内容不会成为基线。

SQLite 的 response/database payload 自适应使用 zlib level 6：压缩后更小时才压缩，
并限制解码后大小。截图不写入 SQLite BLOB，而是按 SHA-256 去重存放在
`runtime.snapshot_artifact_dir`（默认 `.easytest/snapshot-artifacts`）；数据库只存
相对路径、大小和哈希。截图 BLOB、无 codec 标记 payload 和其他 schema 版本均
直接拒绝，不做兼容转换。压缩和哈希不等于加密，快照目录仍按敏感业务数据保护。

相关 `runtime.json` 字段：

```json
{
  "snapshot_backend": "sqlite",
  "snapshot_database": ".easytest/snapshots.db",
  "snapshot_artifact_dir": ".easytest/snapshot-artifacts",
  "snapshot_history_keep": 10,
  "snapshot_max_bytes": 268435456
}
```

`snapshot_max_bytes` 默认 256 MiB，必须为正整数且最多 1 GiB，同时约束写入、
BLOB 解压和外部图片读取。`snapshot check` 校验 SQLite、codec、schema 和图片
大小/哈希。`snapshot maintain` 默认删除超过 24 小时的 `running`、每个 Case 只保留
最近一条 `failed/conflict`，删除孤立图片并 checkpoint WAL。可用
`--stale-after-hours/--keep-failed` 调整；`--compact` 额外执行 `VACUUM`，会申请
独占数据库访问，不能与测试任务同时运行。schema 必须与当前版本精确匹配；不匹配时
删除数据库及图片目录后重新建立基线。

两种后端都不回滚业务副作用。外部图片和 SQLite 元数据不是跨文件事务；进程在二者
之间被强制终止可能留下孤立图片，维护命令会回收，未完成运行不会成为可读基线。

## 错误契约

框架错误包含稳定 `code/field`，已知时附
`case_id/step_id/operation/source/source_row`。主要 code：

```text
UNKNOWN_FIELD, INVALID_TYPE, INVALID_VALUE, INVALID_IDENTIFIER,
UNKNOWN_OPERATION, EXECUTOR_MISMATCH, UNKNOWN_PROFILE, MOCK_MISS,
EMPTY_SELECTION, UNKNOWN_CASE_ID, UNKNOWN_DATA_SET, EMPTY_DATA_SET,
DUPLICATE_DATA_ID, ORPHAN_COMPILED_JSON,
COMPILED_JSON_MISSING, COMPILED_JSON_OUT_OF_DATE,
INVALID_EDIT, EDIT_CONFLICT, EXECUTION_POLICY_VIOLATION,
HTTP_SECRET_SOURCE, HTTP_RESPONSE_TOO_LARGE,
ASSERTION_FAILED, ASSERTION_PATH_MISSING, SNAPSHOT_MISMATCH, SNAPSHOT_CONFLICT,
SNAPSHOT_TOO_LARGE,
CLEANUP_FAILED, INTERRUPTED
```

任意业务异常在机器结果中只保留安全概述；原始消息、notes 和 traceback 在本地
stderr。敏感字段、长值和异常序列化失败会脱敏或截断。

## 公共 Python API 与边界

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

`CaseRunner.run()` 自动预检单个 Case。自行批量执行时先调用
`runner.preflight(cases)`。Notebook 的每次 `run_case/run_step` 都是独立 Case；
不同数据场景应显式设置稳定 ID。

Runner 顺序使用且不保证并发安全；pytest-xdist 不合并 EasyTest HTML 报告。
同一逻辑 Case 的数据行可复用 Runner 内部的 HTTP 连接池和数据库连接，行间会清理
HTTP Cookie 并结束未完成的数据库事务；不同 Case 或 Runner 不共享这些连接。
HTTP `stream=true` 仍在上限内读取完整响应。框架不提供业务事务回滚、全局取消、
恢复执行、浏览器自动化、OpenAPI 导入或分布式调度。
