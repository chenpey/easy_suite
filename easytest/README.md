# EasyTest

面向场景、HTTP、RPC、数据库和封装 UI 请求的 XLSX 表格驱动测试脚手架，
同时生成确定性 JSON 用于版本跟踪、代码审查和运行。

当前版本 `0.2.0`。升级前请读 [迁移说明](docs/0.2.0迁移说明.md)，
其中涉及 HTTP 编码、handler 返回值、Notebook 快照身份和孤立编译产物的变化。

## 普通测试用户从这里开始

首次接入公司业务，请按 [《新业务接入指南》](docs/新业务接入指南.md) 操作：
从独立项目初始化、真实接口配置和 Excel 用例，到报告、排错与 CI 接入。

使用 AI 助手接入或执行测试，请先提供 [《AI 接入与执行指南》](docs/AI接入与执行指南.md)：
包含任务上下文模板、Excel 编辑示例、只读预检、执行范围、报告读取和失败重试约定。
指南末尾记录当前能力边界与尚未实现的改进事项。

想先体验公开接口，可运行 [JSONPlaceholder Demo](examples/jsonplaceholder/README.md)：
无需账号，包含查询用户、步骤关联、模拟创建文章和独立的失败报告演示。
默认离线，添加 `--profile live` 即可调用公开服务。

日常只需编辑 Excel，然后运行 `easytest run`。由框架维护者配置接口和适配器，
使用者无需修改 Runner、Executor 或框架单测。

当前源码包尚未发布至 PyPI。先在本仓库 `easytest/` 目录执行：

```bash
uv sync
uv run easytest init ../my-tests
uv run easytest run --root ../my-tests
```

生成的 `my-tests/` 是独立业务测试项目，含一个可直接运行的离线 Excel、
配置、版本匹配的 `AI_GUIDE.md`、说明和 `test_cases.py`，不复制框架源码或框架单测。
AI 指南指向安装包内的 [CONTRACT.md](src/easytest/CONTRACT.md)，无需源码目录即可读取。
已有非空目录会拒绝覆盖。
Excel 的技术列已预填并隐藏，常用断言写成：

```json
{"$.status_code": 200, "$.body.ok": true}
```

项目内的 `README.md` 给出了安装本地框架包的方法。安装后在业务项目目录运行：

```bash
easytest run                      # 默认发现 cases/
easytest run cases/demo.xlsx      # 也接受 JSON 或目录
easytest list                     # 只读列出启用用例和全部 operation 名称
easytest validate --case-id http.demo
easytest run --case-id http.demo  # 精确选择；可重复 --case-id
easytest edit cases/demo.xlsx --patch edit.json
pytest                           # 业务项目自己的入口
```

运行前自动编译 XLSX，忽略 Excel 的 `~$` 临时文件，同名 JSON 不重复运行。
重复 Case ID、空目录、全部禁用用例会报错。失败信息附带 Case、Step、Operation
以及源 Excel 的 sheet 和行号，异常类型和原始调用栈继续保留。

## 网页报告与差异归类

`easytest run` 和业务项目的 `pytest` 默认生成 `artifacts/report.html`。
运行结束后用浏览器打开即可，无需启动服务或联网，也可作为 CI 构建产物下载。
每次覆盖该路径；需要保留多次报告时，为每次运行指定不同路径。

```bash
easytest run --report artifacts/regression.html
pytest --easytest-report artifacts/regression.html
open artifacts/regression.html   # macOS；其他系统直接双击 HTML
```

路径相对于业务项目根目录（CLI 的 `--root` / pytest 的 `--easytest-root`）。
关闭输出可用 `easytest run --no-report` 或 `pytest --no-easytest-report`。
CLI `run` / `validate` 成功、失败和可捕获中断均向 stdout 输出一个 JSON 对象；
事件、handler 的打印和报告路径输出到 stderr。
普通 Case 失败后会继续执行其他 Case，最后保留首个异常并以失败退出；
当前 Case 内的后续步骤显示为“未执行”。
CLI 捕获的 `SystemExit` 统一以退出码 1 结束，包括 `SystemExit(0)` 和
`SystemExit(None)`；JSON 仍标记为 `interrupted`。Python Runner 保留原始异常行为。

机器读取使用以下统一封装（`schema_version=1`）：

| 字段 | 含义 |
| --- | --- |
| `command` | `run`、`validate`、`list` 或 `edit` |
| `status` | `passed` / `valid` / `listed` / `edited` / `failed` / `interrupted` |
| `data` | run 报告、validate 摘要、list 元数据或 edit 产物信息 |
| `errors` | 稳定 code、field、类型、阶段和可用的 Case/Step/来源定位，不包含任意异常原文 |
| `artifacts` | `html`、`result` 的绝对路径；未生成时为 null |

```bash
easytest run --result artifacts/result.json
easytest run --no-report --result artifacts/result.json
```

`--result` 相对于 `--root`，原子替换目标文件，内容与 stdout 相同。即使用例失败，
仍会尝试写出结果；结果文件写入失败也会以非零退出码和 `status=failed` 结束。
启用 HTML 时，`--report` 与 `--result` 必须指向不同文件。CLI 会在初始化和执行前
解析路径（包括相对路径和符号链接）；目标冲突时只输出失败 JSON，不写入这两个文件。
使用 `--no-report` 时，结果文件可以占用默认 HTML 路径。
运行统计在 `data.summary`，步骤在 `data.cases[].steps[]`；预检摘要在
`data.case_count/step_count/deferred`。旧的 Case ID 顶层映射已由该协议替代。
命令行参数错误仍使用 argparse 的用法提示；强制终止进程无法保证最终结果输出。

报告提供：

- 总用例、通过率、失败/跳过/中断数、累计耗时与差异总数。
- 按状态、差异类别、关键词筛选，查看 Case、步骤、源文件和 Excel 行号。
- 展开查看脱敏后的请求/响应、字段路径、期望值与实际值。
- 按“差异类别 + 字段路径”汇总出现次数和受影响用例；数组下标统一为 `[*]`。
- 下载内嵌 JSON，方便继续统计；点击“导出 PDF”直接下载完整 PDF。

PDF 包含统计、全部用例、步骤和差异，不受网页筛选或折叠状态影响。
中文文本可搜索和复制，长内容自动分页，沿用网页中的脱敏和截断标记。
PDF 内嵌在 HTML 中，离线也能下载，无需打开系统打印窗口。

PDF 与 JSON 下载文件名使用导出时的本地日期和时间，精确到秒，例如：

```text
easytest_report_20260926161908.pdf
```

文件名格式为 `easytest_report_YYYYMMDDHHMMSS.pdf` / `.json`，分隔符统一使用下划线，
无需手工维护版本号。报告 ID 保留在 PDF 正文和 JSON 的 `report_id` 字段中，
网页顶部显示短 ID。

`validate.data.input_hash` 与 `run.data.input_hash` 是所选 Case、框架配置、运行设置
和执行策略的确定性 SHA-256；相同输入应得到相同值。它不包含环境变量值、业务
handler 源码或外部服务状态，不能单独证明两次真实请求完全相同。

自动分类采用确定性规则：

| 分类 | 示例 |
| --- | --- |
| 字段 / 元素新增、缺失 | 响应多了 `currency`，或缺少 `status` |
| 类型变化 | `true → 1`、`100 → "100"`；`1` 与 `1.0` 同属 JSON number |
| 数值、文本、其他值变化 | `100 → 120`、`ACTIVE → CLOSED`、`true → false` |
| 列表顺序变化 | 元素及重复次数一致，仅排列变化；已配置无序列表时仍按规则忽略 |
| 缺少基线 | `read` 模式未找到待比较的快照 |
| 图片 / 二进制变化 | 文件内容哈希不同；不进行像素差异分析 |
| 文件格式变化 | 文件后端 `write` 仍要求字节一致，JSON 内容相同但排版变化也会失败 |

分类描述数据变化，不推断业务根因，也不会自动忽略差异或更新基线。
普通断言、网络或配置错误按执行错误展示，不通过错误字符串伪造快照 diff。
所有差异参与计数；长值会标注截断，敏感字段及其子字段脱敏。
共享 HTML 不包含任意异常的原始消息或调用栈，详细错误继续查看本地终端。
普通断言错误还提供 `path/operator/reason/expected/actual`，值按路径及其父字段脱敏；
缺失路径使用 `ASSERTION_PATH_MISSING`，不匹配使用 `ASSERTION_FAILED`。

在框架仓库执行 `uv run python scripts/generate_report_demo.py`，
可生成 `artifacts/report-demo.html`：包含真实执行的通过、差异和断言失败示例，
方便体验分类与分组；示例使用独立临时项目，不修改已有基线。

pytest 每个测试显示一条记录，状态综合 setup/call/teardown；
`skip`/`xfail` 显示跳过，`pytest.raises` 捕获的预期失败保留步骤详情，
测试状态以 pytest 为准。默认只收集使用 `table_case` / `case_runner` 的测试；
显式指定 `--easytest-report` 时收集全部测试。当前支持顺序执行，
使用 pytest-xdist 的 `-n` 时不生成不完整的报告，并在终端提示。

通过率为通过数除以报告内全部用例数，包含跳过和未执行记录。
HTML 输出与快照存储独立，默认 `read` 仍不新增或清理 SQLite 历史。
报告统计的是本次运行；跨运行趋势不在当前页面中合并。

Notebook 可随时导出本 Session 已执行的所有尝试，包括失败：

```python
session.write_report("artifacts/manual.html")
```

程序化使用可读取 `runner.last_report` 或 `runner.case_reports`，也可自行导出：

```python
from easytest.reports.html import write_html
from easytest.reports.results import RunReport

write_html(RunReport(cases=runner.case_reports), "artifacts/report.html")
```

## 核心约束

- 默认以 XLSX 为人工维护的唯一权威源，同时提交确定性生成的同名 JSON；
  JSON 用于 Git diff、代码审查、AI 分析和运行时读取，不独立维护。
- 生成 JSON 记录 `source_mode=xlsx`、XLSX SHA-256 和编译器版本。
  `easytest compile cases --check` 只读检查所有配对产物，缺失或不一致即失败；
  提交前和 CI 应强制执行。`run` 自动编译，`list/validate` 不写文件。
- 删除/重命名 XLSX 时同步处理旧 JSON；孤立或过期产物明确失败。
- JSON-only 只面向没有表格维护需求的纯代码/机器生成项目，必须显式设置
  `source_mode: "json"`，且不能携带 XLSX 生成元数据；不作为普通业务项目的推荐路径。
- HTTP、RPC 与场景用例使用同一份 `cases` / `steps` 契约。
- SQL 固定在配置中并使用绑定参数，用例只能提供参数。
- 数据库密码、HTTP token、RPC 鉴权只从 `.env` 或进程环境读取。
- `.env` 保存在项目私有映射中，不修改进程环境；进程环境优先。
  修改 `.env` 后重建 Runner / NotebookSession 即可重新读取。
- HTTP 默认只重试 `GET`、`HEAD`、`OPTIONS`；`POST` 必须显式声明幂等。
- 数据库 operation 的 `write` 声明必须和实际 SQL 类型一致。
- 数据库写权限由 `allow_db_write` 控制；新项目默认关闭。旧项目未设置时保留
  `read` 禁写、`write/baseline` 允许的行为。替换快照仍需 `baseline` 和
  `CONFIRM_BASELINE=1` 双重确认。
- 自动化或 AI 执行真实服务时，可通过受信任的外部执行策略限制 Profile、Case、
  operation、executor 及 HTTP method/origin；策略不应存放在执行者可修改的位置。

## 核心能力与边界

- `DictObject`：递归属性访问，缺失字段默认抛出 `AttributeError`；也可显式
  设置缺失字段默认值。
- HTTP：连接/超时和指定状态码重试、指数退避、状态校验、Session 生命周期。
- Database：MySQL 只读重试和超时、结果序列化；SQLite WAL、busy timeout、
  文件写锁、只读连接和 `executemany`。
- Snapshot：字段级差异、路径忽略、金额/日期归一化、无序列表和可选 SQLite
  历史后端。
- Runtime：结构化脱敏事件、轮询、动态 ID 和 Notebook 表格展示。

浏览器 Cookie 读取只作为显式安装的内部认证插件提供，不会随核心依赖安装：

```bash
uv sync --extra browser-auth
```

```python
from easytest.transport.browser_auth import cookie_header

header = cookie_header("https://internal.example.com", names={"session"})
```

业务域流程和公司内部基础设施适配器不进入通用核心，应由使用方通过 handler
或显式 Executor 注入。
Executor 名称仍固定为五类，注入用于替换实现；新业务能力优先通过 scenario handler 封装。

常用 API 从顶层导入：

```python
from easytest import (
    Case, Step, ExecutionPolicy, ExecutionResult, CaseRunner, NotebookSession,
    edit_workbook, load_project_cases,
)

case = Case("manual.check", steps=(Step("ping", 1, "http", "http.ping"),))
```

`Case` 的 name 默认 ID、case_type 默认 scenario，其余字段有独立合理默认值；
执行仍要求至少一个有效步骤。可安装的独立业务 handler 项目见
[business_handler 示例](examples/business_handler/README.md)。

## 运行仓库示例

```bash
uv sync
uv run easytest run --root examples/jsonplaceholder
uv run easytest run mock_cases --root examples/jsonplaceholder
uv run pytest -c examples/jsonplaceholder/pytest.ini examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder
```

用户演示统一放在 [JSONPlaceholder Demo](examples/jsonplaceholder/README.md)，
默认选择 `offline-strict`，无需 `.env` 或外部服务。
框架根目录用于维护源码，执行业务用例时通过 `--root` 指定 Demo 或自己的业务项目。

框架回归使用 [tests/fixtures/project](tests/fixtures/project/README.md) 中的固定数据，
覆盖 HTTP、RPC、数据库、UI 和快照；`tests/conftest.py` 自动为表格测试选择该项目。
`uv run pytest` 默认只收集 `tests/`，业务项目的 `pytest` 只运行自己的用例。
维护框架时运行：

```bash
uv run pytest
uv run ruff check src tests scripts
```

只安装运行依赖可使用 `uv sync --no-dev`。开发环境默认安装固定版本的 Ruff 和
Notebook 执行验证工具；重新生成框架测试工作簿和截图时再显式安装 Pillow：

```bash
uv sync --extra examples
uv run python scripts/generate_test_fixtures.py
```

直接运行编译后的文件：

```bash
uv run easytest run cases/demo.json --root examples/jsonplaceholder
```

## 严格校验与执行前预检

接入或修改配置后，可以先做只读验证：

```bash
uv run easytest validate cases --root examples/jsonplaceholder
uv run easytest validate cases --root examples/jsonplaceholder --profile live
```

`validate` 在内存中读取 Excel，不生成或覆盖 JSON，不创建报告、快照数据库，
不访问业务服务，也不导入或调用业务 handler。目录中同名 XLSX 优先于 JSON；
显式指定 JSON 时验证该文件。成功输出的 `data` 包含用例数、步骤数和 `deferred`；
静态错误以非零退出码失败，并保留 Case / Step / Excel 行号。

受控环境可设置不可由命令行覆盖的策略：

```bash
export EASYTEST_EXECUTION_POLICY=/trusted/easytest-policy.json
uv run easytest validate cases --root examples/jsonplaceholder --profile live
uv run easytest run cases --root examples/jsonplaceholder --profile live
```

也可显式传 `--execution-policy /trusted/easytest-policy.json`。策略使用精确 allowlist：

```json
{
  "schema_version": 1,
  "allowed_profiles": ["live"],
  "allowed_case_ids": ["jsonplaceholder.get_user"],
  "allowed_operations": ["http.get_user"],
  "allowed_executors": ["http"],
  "allowed_http_methods": ["GET"],
  "allowed_http_origins": ["https://jsonplaceholder.typicode.com"]
}
```

字段缺失、动态且无法静态确认的 HTTP 目标、未授权目标或自定义 executor 都会在
请求发出前失败。受策略保护的 HTTP operation 还必须设置
`"allow_redirects": false`，防止重定向绕过 origin allowlist。确需自定义 executor 时必须显式设置
`"allow_custom_executors": true`，并把允许的 operation 视为已审计代码边界。

`list` 同样只读，无需解析运行凭据或导入业务包，输出启用用例和全部 operation 的
名称/executor，不输出认证、URL 或业务请求。`list/validate/run` 共用可重复的
`--case-id`：精确且区分大小写，重复 ID 去重，保留来源顺序；未知、禁用 ID 和空值失败。
来源结构与重复 ID 在筛选前校验；筛选后的集合才做运行预检。默认不传则选择全部启用用例。

CLI `run` 会在整批用例执行前预检；pytest 在 `-k` 等筛选完成后预检全部选中
的 `table_case`；`CaseRunner.run(case)` 和 Notebook 单次执行也会先检查全部步骤。
因此，后一 Case / Step 的未知 operation、参数拼写或变量引用错误会阻止前面的真实请求。
Python 自行循环多个 Case 时，先调用 `runner.preflight(cases)`，再逐个 `run`；
Notebook 可用 `session.validate("cases")` 检查来源。

检查范围包括：

- Case / Step / Excel 列名、字段类型、唯一 ID、顺序和输出别名；拒绝未支持字段。
- 断言必须包含 `equals`、`contains` 或 `in`；`equal`、空 `checks` 等不能静默通过。
- operation 与 executor 的对应关系、有效 Mock/Profile、变量与先前步骤输出引用。
- 内置 HTTP 的顶层传输参数、URL、路径参数、超时、重试和有效配置所需的环境变量；
  `json`、`params` 等内部业务字段保持自由，`jsno` 等顶层拼写会报错。
- 数据库语句、绑定参数、连接及写权限；快照规则、静态基线和基线更新确认；
  handler 引用语法、模块位置和可静态识别的缺失符号。

离线 Mock 不要求真实连接的凭据；它仍检查 HTTP 配置结构。需要验证真实环境配置时
使用 `--profile live`，并确认 Case / Step 没有显式 Mock。步骤覆盖掉的 HTTP 配置
不再要求其原有环境变量。

`status: "valid"` 表示静态预检通过，不代表业务测试通过。先前步骤响应里的字段、
`state`、动态 URL / 规则、handler 依赖及内部行为、自定义执行器、运行后截图等
会列在 `deferred` 中，并在执行时继续检查。HTTP 动态参数会在该请求发出前重新校验。
SQLite 存在尚未落盘的 WAL 时，其基线检查也会延期，避免只读验证写入共享内存文件。
预检不能回滚已发生的业务动作，也不保证动态失败时整个 Case 可安全重跑。

## Notebook 手动测试

推荐使用 **Visual Studio Code** 运行 Notebook。先在项目根目录安装包含
Jupyter kernel 的可选依赖：

```bash
uv sync --extra notebook
```

然后：

1. 使用 VS Code 打开项目目录：`code .`
2. 安装 Microsoft 官方的 **Python** 和 **Jupyter** 扩展。
3. 打开 [`notebooks/manual_test.ipynb`](notebooks/manual_test.ipynb)。
4. 点击右上角 **Select Kernel**，选择项目中的 `.venv/bin/python`。
5. 按顺序执行单元格。

也可使用其他原生支持 `.ipynb` 且允许选择 Python 虚拟环境的编辑器或 IDE，
但推荐 VS Code 作为默认运行环境。

此 Notebook 复用 `tests/fixtures/project/` 的固定测试数据，默认严格离线，
无需准备 `.env`，适合验证全部适配器和截图能力。
手动测试自己的业务时，将 Session 根目录指向自己的业务项目。

Notebook 支持：

- 编译并查看 XLSX 用例。
- 运行完整场景。
- 单步调用 HTTP、RPC、数据库、UI 和场景 operation。
- 直接展示响应、数据库结果和页面截图。

单步调用默认由 `mock` 参数决定是否走预设 mock。传入 `mock=False` 时调用
真实适配器还需要选择允许真实执行的 Profile。三个入口使用相同配置解析：

```bash
uv run easytest run --root examples/jsonplaceholder --profile offline-strict
uv run pytest -c examples/jsonplaceholder/pytest.ini examples/jsonplaceholder/test_cases.py \
  --easytest-root examples/jsonplaceholder --profile offline-strict
```

```python
from easytest.notebook import NotebookSession

with NotebookSession("examples/jsonplaceholder", profile="offline-strict") as session:
    result = session.run_case("cases/demo.xlsx", case_id="jsonplaceholder.user_posts")
```

真实请求使用 `profile="live"`；数据库密码和 RPC 鉴权仍从 `.env` 或进程环境读取。
Notebook 中每次 `run_case` / `run_step` 都是独立 Case。
调用之间不延续 state、步骤输出或默认 HTTP Session；需要关联时放进同一 Case。
`run_step` 默认 case_id 为 `notebook.{executor}.{operation}`，step_id 为 `manual`。
同一 operation 不同数据场景请设稳定的 `case_id` / `step_id`，例如：

```python
session.run_step(
    executor="http", operation="http.get_user", case_id="manual.user_existing",
    step_id="get", request={"path": {"user_id": 1001}},
)
```

## 配置按需添加

| 文件 | 何时需要 |
| --- | --- |
| `config/operations.json` | 必需：维护接口、SQL 或 handler |
| `config/runtime.json` | 可选：默认 Profile、快照后端、数据库连接、观测和写权限 |
| `config/profiles.json` | 可选：切换离线/真实等运行预设 |
| `config/mock_profiles.json` | 使用 Mock preset 或 Mock Profile 时 |
| `config/snapshots.json` | 使用快照规则时 |

不使用某项能力就不需要其配置文件；显式引用不存在的配置会报错。
`profiles.json` 仅支持 `mock_profile`、`fail_on_mock_miss`、`allow_db_write`，
以及 `runtime.run_mode`、`runtime.observability.emit_stdout/max_event_length`。
未知字段、错误类型和未知引用均会报错，`false` 是有效覆盖值。

`runtime.default_profile` 只在未显式选择 Profile 时使用。`run_mode` 优先级：
API/CLI 参数 > Profile > `RUN_MODE` > runtime 文件 > `read`。
Profile 只覆盖显式提供的观测字段，数据库权限为 API/CLI > Profile > runtime。

Mock 选择顺序：Step > Case 的 Mock Profile > 运行 Profile 的默认 Mock Profile。
选定一个 Mock Profile 后不会混合其他 Profile；Step 的 `mock=false` 禁用回退。
严格模式在 Mock 没有返回结果时阻止所有真实 Executor，包含无 Mock、`false`
和 `inject`。严格模式是 Runner 的调用门禁，不是操作系统网络沙箱。

## 结构化编辑 XLSX

AI 或脚本优先使用 `easytest edit`，不要直接修改生成的 JSON。补丁可一次提交多个
操作，最终工作簿整体有效后才替换原文件，并自动重编译同名 JSON：

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

也可重复使用 `--operation '{...}'`。`entity` 为 `case/step`，`action` 为
`add/update/rename/delete`；更新不存在的 ID 和新增已有 ID 都会失败。Case 重命名
会同步更新 steps 引用。新增 Case 及其 Step 应放在同一补丁中，避免中间无步骤状态。

## XLSX 契约

每个工作簿必须包含 `cases` 和 `steps` 两张 sheet，不允许公式单元格。

`cases` 必填列：

| 列 | 含义 |
| --- | --- |
| `case_id` | 全局唯一 ID，仅允许字母、数字、`.`、`_`、`-` |
| `case_name` | 用例名称 |
| `case_type` | `scenario`、`http` 或 `rpc` |

常用可选列：`enabled`、`tags`、`variables`、`mock_profile`、
`snapshot_profile`。`variables` 是 JSON object。

`steps` 必填列：

| 列 | 含义 |
| --- | --- |
| `case_id` | 所属用例 |
| `step_id` | 用例内唯一 ID |
| `order` | 正整数执行顺序 |
| `executor` | `scenario/http/rpc/database/ui` |
| `operation` | `config/operations.json` 中的操作名 |

可选列 `request`、`mock`、`snapshot`、`expect` 均填写 JSON；
`save_as` 可给步骤输出命名。模板支持：

```text
${variables.user_id}
${steps.profile.body.id}
${state.user.id}
```

脚本 [`scripts/generate_test_fixtures.py`](scripts/generate_test_fixtures.py) 生成
`tests/fixtures/project/` 下的框架测试 XLSX、确定性 JSON 和截图资源；
业务 Demo 的用例直接维护各自的 Excel。

## 操作与适配器

`config/operations.json` 只保存非敏感元数据。

- HTTP：配置 method、URL、headers、timeout、expected_status 和 retry。
- RPC：配置 endpoint、环境变量鉴权和 `module:function` handler。
- Database：配置 connection、参数化 statement、`write` 标记；批量写入可设置
  `execute_many: true`。
- UI：配置一个封装 UI 请求的 handler。
- Scenario：可使用内置 `set/get/wait`，或配置业务 handler。

Scenario 的 set/get 共用路径语法，`value` 与 `$.value` 指向同一字段。
set 支持嵌套对象字段，不支持根对象替换或数组下标写入；这些写法会在预检中拒绝。
get 可读取数组下标，例如 `$.items[0].value`。

RPC handler 签名：

```python
def call_rpc(*, request, endpoint, auth, context):
    return {"code": "SUCCESS"}
```

UI/场景 handler 签名：

```python
from pathlib import Path
from easytest import ExecutionResult

def call_ui(*, request, context):
    return ExecutionResult(
        "ui", "ui.open_page", {"visible": True},
        artifacts={"screenshot": Path("/absolute/path/page.png")},
    )
```

普通返回值完整保留，即使业务字典含 `output` 字段也不会拆包。
只有显式 `ExecutionResult` 承载 artifacts / metadata 等框架信息。
也可以在创建 `CaseRunner` 时按 operation 名注入 handler，避免在框架中
硬编码业务 SDK。

HTTP 的 `data` 发送表单/原始体，`json` 发送 JSON；Python 客户端和
`send_http` 使用 `json_body` 参数。`files` 与 `data` 可混合传 multipart 字段。
断言递归区分布尔和数字，`true != 1`、`false != 0`；`1 == 1.0`，
不套用快照的 null 字符串或日期归一化。

SQLite 普通相对文件名（含连接和文件锁）基于业务项目 root 解析。
`:memory:` 与显式 `uri=true` 的 `file:` URI 保留 SQLite 特殊语义；
相对 URI 路径仍按进程目录解析，跨目录调用应使用绝对 URI。

HTTP 重试示例：

```json
{
  "method": "GET",
  "retry": {
    "retries": 2,
    "backoff_seconds": 0.2,
    "jitter_seconds": 0.05,
    "status_codes": [429, 502, 503, 504]
  },
  "expected_status": [200, 404]
}
```

`POST` 默认不会重试。只有接口具备幂等键或天然幂等语义时，才可在
`retry.methods` 中显式加入 `POST`。

## Mock

`config/mock_profiles.json` 提供 preset 和按 operation 绑定的 profile。
步骤 `mock` 可以覆盖 profile：

```json
{"preset": "rpc_rejected"}
```

内置类型：

- `response`：直接返回响应。
- `sequence`：按调用次数返回序列。
- `inject`：修改请求后继续调用真实执行器。
- `timeout`、`exception`：模拟传输失败。
- `service_rejected`：模拟服务拒绝。
- `state`：更新场景状态并返回结果。

## Snapshot

`config/snapshots.json` 集中定义选择、路径/字段忽略、金额与日期归一化、
无序列表和正则替换规则。JSON 快照不一致时会报告字段路径，而不是只报告文件
哈希。
支持三类快照：

- `response`：HTTP/RPC/UI 响应。
- `database`：数据库查询结果。
- `screenshot`：handler 或 mock 返回的页面截图 artifact。

运行模式：

| 模式 | 行为 | SQLite 历史 |
| --- | --- | --- |
| `read`（默认） | 只比对已有快照，缺失或不匹配则失败 | 不新增、不清理 |
| `write` | 创建缺失快照，已有快照按比较规则验证，差异则失败 | 保存本次结果，成功版本可作为后续比对参考 |
| `baseline` | 明确更新基线，必须设置 `CONFIRM_BASELINE=1` | 保存新版本，成功后成为最新基线 |

更新基线示例（使用框架固定测试数据；业务测试需替换用例路径和 `--root`）：

```bash
CONFIRM_BASELINE=1 uv run easytest run cases/scenario/account_flow.xlsx \
  --root tests/fixtures/project --profile offline-strict --run-mode baseline
```

默认使用文件快照。需要保留 `write` / `baseline` 的写入历史时，可在
`config/runtime.json` 中启用 SQLite 后端：

```json
{
  "snapshot_backend": "sqlite",
  "snapshot_database": ".easytest/snapshots.db",
  "snapshot_history_keep": 20
}
```

`snapshot_history_keep` 是每个 Case 下、每项快照保留的成功版本数，包含当前基线：

- 正整数 N：保留最近 N 个成功版本；`1` 表示只保留当前版本。
- 省略或 `null`：不限制，兼容旧项目；不接受 `0`、负数、小数、字符串或布尔值。
- 在 `write` / `baseline` 成功收尾时，完成标记和历史清理在同一事务中提交；
  清理失败会回滚。调小 N 后，下次成功写入时生效，`read` 不会触发清理。
- 失败及进行中的记录不计入 N，也不由此配置删除；部分步骤更新不会删除其他
  快照仍在使用的基线。已无快照内容的成功运行记录会一并清理。
- 仅对 SQLite 有效；文件后端仍保存当前文件，不维护多版本历史。

默认 `read` 回归不会不断产生历史记录。SQLite 删除后的空间可供后续写入复用，
数据库文件大小不一定立即缩小。

SQLite 后端使用 WAL、busy timeout、文件锁和完整性检查；失败执行不会成为后续
比对基线。Case 执行和自建资源清理都成功后才标为完成。文件后端也先暂存本 Case
的变更，仅在全部步骤及资源清理成功后统一替换；普通失败会丢弃暂存内容，提交阶段
失败会尝试恢复原文件。进程被强制终止时不承诺跨多个文件的文件系统事务。

需要在比对快照时造数，可显式使用：

```bash
uv run easytest run --profile live --run-mode read --allow-db-write
```

也可通过 `CaseRunner(..., allow_db_write=True)` 或
`NotebookSession(..., allow_db_write=True)` 设置。`--no-allow-db-write` 显式关闭。
即使允许写入，数据库连接的 `read_only` 和 operation 的 `write` 声明仍有效。
快照 `write/baseline` 不会覆写新项目的 `allow_db_write=false`。

## 运行时变量与事件

每次 case 运行会生成一次并在所有步骤中保持稳定：

```text
${generate.uuid}
${generate.timestamp}
${generate.timestamp_ms}
${generate.request_id}
${generate.order_id}
```

`CaseRunner.last_events` 保存 `case.start`、`step.start`、`step.done/error` 和
`case.done/error` 结构化事件。凭据按字段名脱敏，异常事件只保存安全错误结构；
常见短用户标识只保留不可逆 SHA-256 摘要，复杂或超长标识直接屏蔽。
设置 `runtime.observability.emit_stdout=true` 可输出 NDJSON 事件；
CLI 将这些事件转至 stderr，Python / Notebook 直接调用仍输出到 stdout。
脱敏默认最多读取每层 50 项、6 层和合计 3000 个节点，超长文本（超过 1000 字符）
整体省略；超长 JSON 字符串不解析，循环引用只输出安全标记。

普通脱敏、序列化或日志输出故障不改变测试结果；脱敏失败只输出安全标记。
执行错误优先保留，后续清理和快照收尾错误仅追加不含敏感消息的异常类型。

## 维护边界

保持一个顺序使用的 `CaseRunner` 和固定的 Mock → 执行 → 断言 → 快照 → 保存结果
流程，不提供插件调度、动态注册或整步重试。Runner 不保证并发安全。

默认 HTTP Session 在同一 Case 的步骤间复用，Case 结束后关闭，跨 Case 隔离。
外借 Client/Session 不会被关闭、清空或擅改 `trust_env`；显式配置冲突会报错，
正常请求仍可能更新 Cookie。调用方负责共享资源的隔离。注入的 Executor
继续由 `Runner.close()` 调用其 `close()`，同一对象的多个别名只尝试一次。
每个 HTTP Response 在内容读取或状态检查结束后关闭，包括失败路径。
`stream=true` 仍会在返回执行结果前读取完整 JSON/text，不提供有界内存下载。

## 目录

```text
examples/jsonplaceholder/       用户 Demo：Excel、配置、Mock 与 pytest 入口
notebooks/                     交互式手动测试入口
scripts/                       报告演示、框架测试数据生成
src/easytest/
  cases/                       编译、加载与契约校验
  examples/                    可安装的离线示例 handler
  executors/                   HTTP/RPC/Database/Scenario/UI 执行器
  notebook/                    Notebook API 与展示
  reports/                     运行统计、差异分组与离线 HTML 报告
  runtime/                     编排、数据结构、Mock、轮询与可观测性
  snapshots/                   快照管理、存储与结构化比较
  transport/                   HTTP client 与可选浏览器认证
  cli.py                       命令行入口
  config.py                    配置加载与安全校验
  models.py                    公共运行时模型
  pytest_plugin.py             pytest 插件入口
  starter.py                   生成最小业务项目
tests/                         框架测试和统一表格用例入口
  fixtures/project/            测试专用的用例、配置、快照基线与截图
```
