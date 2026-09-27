# EasyTest 0.2.0 安装包契约

本文是随 wheel 分发的最小稳定契约，不承担教程职责。业务项目通常只安装 wheel，
未必同时拥有源码仓库中的 README 和指南；`easytest init` 生成的 AI 指南因此引用
本文件。运行时解析器和预检仍是最终校验依据。

## 发现、预检和执行

```bash
easytest list cases --root /业务目录
easytest validate cases --root /业务目录 --case-id user.get --profile live
easytest run cases --root /业务目录 --case-id user.get --profile live --result artifacts/result.json
easytest edit cases/demo.xlsx --patch edit.json
```

`list`、`validate` 不生成编译 JSON、存储或报告，不导入/调用 handler；
`list` 不解析运行凭据，不做业务执行预检，仅返回启用用例及全部 operation 的名称和 executor。
它不返回请求、变量、连接、认证或 handler 配置。
`--case-id` 精确、区分大小写、可重复传入；去重后按来源顺序运行，无通配符。
未知、禁用 ID 或空选择失败。来源的格式、重复 ID 在选择前校验，
运行预检只检查选中的 Case；选中的整批预检通过才执行第一步。

`list/validate/run/edit` 的 stdout 均为 `schema_version=1` 的 JSON：
`command`、`status`、`data`、`errors`、`artifacts`。
成功状态分别为 `listed`、`valid`、`passed`、`edited`，失败/中断为
`failed`/`interrupted` 并非零退出。
`list.data` 包含 `case_count`、`step_count`、`cases`、`operations`；
用例含 `id/name/source/tags/steps`，步骤含 `id/order/executor/operation/source_row`。
`validate.data` 包含 `case_count/step_count/deferred/input_hash`；`valid` 不代表业务通过。
`run.data` 包含 `summary/cases/input_hash`；逐步骤查看 `status` 和 `mocked`。
哈希覆盖 Case、框架配置、运行设置和执行策略，不覆盖环境变量值、handler 源码或外部状态。
只有 `run` 支持 `--result`，文件与 stdout 同内容。
日志、任意异常原文及调用栈在本地 stderr。argparse 参数错误仍输出用法提示。

## 来源与字段

默认契约是：**人工只维护 XLSX，同时提交同名 JSON 到版本库**。
XLSX 提供表格编辑体验，JSON 是确定性编译产物，用于 Git diff、代码审查、
AI 分析和运行时读取。不得独立编辑两份内容。

```bash
easytest compile cases/demo.xlsx
easytest compile cases --check
```

普通 compile 写入同名 JSON；`--check` 不写文件，只要任一 JSON 缺失或与当前
编译结果不一致就失败，适合 pre-commit 和 CI。生成 JSON 固定包含：

- `source_mode: "xlsx"`：声明它是编译产物。
- `source`：同目录 XLSX 文件名。
- `source_sha256`：原 XLSX 文件字节的 SHA-256。
- `compiler_version`：生成它的 EasyTest 版本。

直接加载生成 JSON 时会检查 XLSX 存在、哈希和编译器版本。目录加载同名 XLSX
优先，`run` 会自动重新编译；`list/validate` 只在内存读取 XLSX，不写 JSON。
删除或重命名 XLSX 时同步处理同名 JSON，否则报 `ORPHAN_COMPILED_JSON`。
提交前及 CI 必须执行 `compile --check`，它也能发现手工修改 JSON 的情况。

JSON-only 仅用于没有人工表格维护需求的纯代码/机器生成项目，是显式高级模式。
它必须填写 `source_mode: "json"`，且不能包含 `source/source_sha256/compiler_version`。
仅删除生成 JSON 的 `source` 不会自动改变权威来源。

最小 JSON-only 用例：

```json
{
  "schema_version": 1,
  "source_mode": "json",
  "cases": [{
    "id": "user.get",
    "type": "http",
    "steps": [{
      "id": "get",
      "order": 1,
      "executor": "http",
      "operation": "http.get_user",
      "request": {"path": {"user_id": 1001}},
      "expect": {"$.status_code": 200}
    }]
  }]
}
```

Case 可选 `name/enabled/tags/variables/mock_profile/snapshot_profile`；
Step 可选 `request/save_as/mock/snapshot/expect/source_row`。
ID 仅字母数字及 `._-`，不得为 `.`/`..`；全局 Case ID 唯一。
Case type 为 `scenario/http/rpc`；executor 为 `scenario/http/rpc/database/ui`。
Step 的 ID、正整数 order、输出名（save_as 或 id）在 Case 内唯一。
每个 Case 至少一步。未知框架字段报错，业务请求内部字段自由。

XLSX 使用 `cases/steps` 两张 sheet：
cases 必填 `case_id/case_name/case_type`，steps 必填
`case_id/step_id/order/executor/operation`，其他列沿用上面可选字段（不填写 source_row）。
`request/variables` 为 JSON 对象；`expect/mock/snapshot` 填 JSON；不支持公式。

结构化编辑使用 JSON 操作批次：

```json
{"operations":[
  {"entity":"case","action":"update","case_id":"user.get",
   "values":{"variables":{"user_id":1001}}},
  {"entity":"step","action":"rename","case_id":"user.get",
   "step_id":"get","new_id":"get_user"}
]}
```

`entity` 为 `case/step`，`action` 为 `add/update/rename/delete`。查找严格按 ID；
不会把更新错误静默变成新增。Case 重命名同步 steps 引用。补丁最终通过完整 XLSX
契约后才替换源文件，并自动更新同名 JSON。

## 断言和模板

断言写路径映射，或 `{"checks":[{"path":"$.body.ok","equals":true}]}`。
支持 `equals/contains/in`；布尔与数字递归区分，1 和 1.0 同属 number，
不进行 null 字符串、日期等快照归一化。缺失路径失败。
模板 `${variables.id}`、`${steps.created.body.id}`、`${state.value}`
读取当前 Case，完整占位符保留类型。operation 中 `${BASE_URL}` 读取项目环境，
URL `{id}` 读取 `request.path.id`。

错误带稳定 `code`，框架校验错误有 `field`，已知时附
`case_id/step_id/operation/source/source_row`。常用 code：
`UNKNOWN_FIELD/INVALID_TYPE/INVALID_VALUE/INVALID_IDENTIFIER/UNKNOWN_OPERATION/EXECUTOR_MISMATCH`、
`UNKNOWN_PROFILE/UNKNOWN_MOCK_PROFILE/UNKNOWN_MOCK_PRESET/UNKNOWN_SNAPSHOT_RULE/UNKNOWN_CONNECTION`、
`MISSING_CONFIGURATION/INVALID_JSON/MISSING_ENVIRONMENT_VARIABLE/MOCK_MISS`、
`EMPTY_SELECTION/UNKNOWN_CASE_ID/ORPHAN_COMPILED_JSON`、
`COMPILED_JSON_MISSING/COMPILED_JSON_OUT_OF_DATE/JSON_SOURCE_MODE_REQUIRED/INVALID_SOURCE_METADATA/INVALID_OUTPUT_PATH`、
`INVALID_EDIT/EDIT_CONFLICT/EXECUTION_POLICY_VIOLATION`。
其他框架校验使用 `INVALID_CONTRACT/INVALID_CONFIGURATION`，收尾使用 `CLEANUP_FAILED`。
字段定位可能是配置字段、契约路径或检查范围，不保证都是 JSONPath。
断言有 `ASSERTION_FAILED/ASSERTION_PATH_MISSING`、
`path/operator/reason/expected/actual`；值按 path 的所有父字段脱敏。
任意业务异常为 `EXECUTION_FAILED`，不输出任意异常原文/notes/traceback。
快照为 `SNAPSHOT_MISMATCH`，中断为 `INTERRUPTED`。

## HTTP、数据库和 handler

HTTP request 支持 `method/url/path/headers/params/data/json/retry/expected_status/raise_for_status`、
`timeout/trust_env/verify/cookies/files/allow_redirects/cert/stream`。
`data` 沿用 requests 的表单/原始体语义，`json` 发送 JSON；
Python `HttpClient.request` 和 `send_http` 的 JSON 参数名是 `json_body`。
multipart 同时使用 `data` 和 `files`；文件对象由调用方管理。
POST 默认不重试；默认 HTTP Session 在 Case 内共享、结束后关闭。

真实自动化可对 `run/validate/pytest/NotebookSession` 提供执行策略。命令行使用
`--execution-policy`；受信任宿主应设置绝对路径环境变量
`EASYTEST_EXECUTION_POLICY`，该值不能被命令行覆盖。策略格式：

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

所有 allowlist 均精确匹配；单独的 `"*"` 表示明确放开该维度。Live HTTP 必须声明
method 和 origin，并在 operation 中设置 `"allow_redirects": false`，防止重定向
绕过 origin 限制。动态且预检时无法确定的目标拒绝执行。自定义 executor 默认
拒绝，确需使用时增加 `"allow_custom_executors": true`，其内部副作用由获准
operation 自身承担。

SQLite 普通相对文件名基于项目 root；`:memory:` 和显式 `uri=true` 的 `file:`
URI 保留 SQLite 语义，URI 中的相对路径仍按进程目录解析。连接与文件锁使用同一目标。
数据库每步独立连接/提交；SQL 配置固定，request 只提供绑定参数。
写权限独立由 `allow_db_write` 决定。

RPC handler 签名 `(*, request, endpoint, auth, context)`；
Scenario/UI handler 签名 `(*, request, context)`。
配置 `handler: "installed_package.module:function"`，业务包须安装在当前 Python 环境。
普通返回值（含 `output` 的字典也一样）完整保留为输出。
需要框架 metadata/artifacts 时显式返回 `ExecutionResult`：

```python
from pathlib import Path
from easytest import ExecutionResult

def open_page(*, request, context):
    return ExecutionResult(
        "ui", "ui.open_page", {"visible": True},
        artifacts={"screenshot": Path("/业务实际截图/page.png")},
    )
```

通过 `scenario_handlers/rpc_handlers/ui_handlers` 可按 operation 注入 callable。
Executor 注入替换固定五类的实现，不支持任意新 executor 名称。

## 公共 Python API 与边界

```python
from easytest import (
    Case, Step, ExecutionPolicy, ExecutionResult, CaseRunner, NotebookSession,
    edit_workbook, load_project_cases,
)

cases = load_project_cases("cases", root="/业务目录", write_compiled=False, case_ids=["user.get"])
with CaseRunner("/业务目录", profile="live") as runner:
    runner.preflight(cases)
    for case in cases:
        runner.run(case)
```

可直接构造 `Case("check", steps=(Step("get", 1, "http", "http.get_user"),))`；
name 默认 ID，case_type 默认 scenario，enabled 默认 true，snapshot_profile 默认 default。
Notebook `run_step` 默认身份 `notebook.{executor}.{operation}`，step_id 默认 manual。
同一 operation 不同场景应显式设稳定 `case_id/step_id`；每次单步调用独立，
不延续上一调用的 state、输出或默认 HTTP Session。需要串联则放同一 Case。

步骤失败会停止当前 Case 后续步骤，普通 CLI 失败仍继续其他 Case。
清理使用业务 `try/finally` 或 pytest yield fixture，不能只依赖最后一个清理步骤。
关闭连接不回滚已提交的业务数据。`read` 只是快照模式，不阻止 HTTP/RPC 写操作。
strict Mock 是执行器调用门禁，不是网络沙箱。文件快照在 Case 成功后统一提交；
SQLite 成功运行才成为基线。强制终止不提供跨文件事务保证。
