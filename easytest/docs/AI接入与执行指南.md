# AI 接入与执行指南

适用版本：EasyTest `0.4.2`。本指南规定 AI 操作 EasyTest 项目的标准流程与交付规范，安装教程见 [新业务接入指南](新业务接入指南.md)，字段与错误契约见 `easytest/CONTRACT.md`。

## 1. 任务上下文确认

开始前明确以下上下文：

```text
业务项目根目录：
框架源码或固定版本 wheel：
接口契约与预期依据：
允许修改的文件、Case ID：
允许执行的环境、Profile、Case ID：
是否允许 HTTP/RPC/数据库写操作：
测试数据与回收方式：
报告要求：
```

## 2. 定位项目与只读发现

区分框架源码（`src/easytest/`、`tests/`）与业务项目（`cases/`、`config/`、`test_cases.py`），并核对当前 Python 解释器与版本：

```bash
python -c "import sys, easytest; print(sys.executable); print(easytest.__file__)"
easytest list cases --root .
```

`list` 为只读发现命令，返回启用 Case 与 operation 元数据，使用精确 `case_id` 定位目标。

## 3. 编辑用例

- 普通项目编辑 `cases/*.xlsx` 并保持同名 JSON 同步；多组输入写入 `data` 页，通过 `cases.data_set` 与 `${data.字段名}` 复用。
- 配置采用局部合并；凭据通过 `.env` 或 CI 密钥注入。
- 优先使用结构化补丁编辑：

```bash
easytest edit cases/demo.xlsx --patch edit.json --validate --root . --profile offline-strict
```

```json
{
  "operations": [
    {
      "entity": "step",
      "action": "update",
      "case_id": "user.get",
      "step_id": "get_user",
      "values": {
        "request": {"path": {"user_id": "${variables.user_id}"}},
        "expect": {"$.status_code": 200}
      }
    }
  ]
}
```

支持 `case/step/data` 的 `add/update/rename/delete`，校验通过后原子替换 XLSX 并更新同名 JSON。

## 4. 静态预检与执行

使用与目标运行一致的 Profile、快照模式与数据库权限执行预检与编译校验：

```bash
easytest validate cases/demo.xlsx --case-id user.get --profile live --run-mode read --no-allow-db-write
easytest compile cases --check
```

受信任执行环境可配置策略文件：

```bash
export EASYTEST_EXECUTION_POLICY=/trusted/easytest-policy.json
```

执行测试并输出机器可读结果：

```bash
easytest run cases/demo.xlsx \
  --case-id user.get \
  --profile live \
  --run-mode read \
  --no-allow-db-write \
  --fail-fast \
  --result artifacts/result.json
```

需要 PDF 报告时追加 `--pdf-report artifacts/report.pdf`。

## 5. 结果核对与失败处理

先检查进程退出码与顶层 `status`，再核对 `data.input_hash`、`data.summary`、`data.cases[].steps[]`（含 `mocked` 标记）、`errors[]` 与 `artifacts`。

| 阶段 | 处理方式 |
| --- | --- |
| `collection/preflight` | 修正来源、字段、引用或配置后重新预检 |
| `prepare` | 核对动态模板与前序步骤输出 |
| `execute` | 查询目标系统状态确认结果后再决定重试 |
| `assertion` | 对照业务契约修正实现或用例 |
| `snapshot` | 确认差异原因后再决定是否更新基线 |
| `cleanup/interrupt` | 核对已完成与待清理资源；业务清理使用 pytest fixture `try/finally` |

## 6. 交付清单

1. 修改的 XLSX、配置与 Case/Step ID，及同名 JSON 同步状态（`compile --check`）。
2. 执行使用的来源、Profile、运行模式、数据库权限与 `input_hash`。
3. 预检与执行命令、退出码及通过/失败/未执行统计（区分 Mock 与真实执行）。
4. 失败位置、副作用状态及生成的 HTML/JSON/PDF/JUnit 产物路径。
