# 维护材料总览

`tests/` 只用于维护 EasyDev 本身，不是普通编码任务的运行依赖。这里的检查都不启动真实模型：外部边界（Codex CLI、pytest 子进程、网络、时钟）由 `tests/experiments/stubs/` 中的替身替代，断言落在 CLI 的退出码、stdout/stderr 和产物文件上。

## 运行

在本目录的上级（`easydev/`）执行：

```bash
bash tests/cases/public-contract-callers/run.sh
python3 -m unittest discover -s tests/experiments/agent_runner -p 'test_*.py' -v
python3 -m unittest discover -s tests/experiments/swebench -p 'test_*.py' -v
```

三项互不依赖，可以并行执行；固定补丁复验内部按“红 → 参考补丁 → 绿 → 独立验收 → 伪修复拒绝”的顺序串行，因为后一步依赖前一步的仓库状态。本机全量耗时目标 < 120s。

## 覆盖什么

- **固定补丁复验** (`tests/cases/public-contract-callers/`)：初始仓库的红测、参考补丁后的 403 与契约检查、独立验收，以及 11 类伪修复被拒绝；不依赖被测仓库自带的 `check_orders.py`。
- **行为 runner CLI** (`tests/experiments/agent_runner/test_cli.py`)：`list` / `prepare` / `run` 的退出码与产物；B01 路由/状态标记/访问/ignored 文件/Git 配置负例、运行时 Skill 篡改、普通/回退暂存与 assume-unchanged、缺 `turn.completed`、畸形事件、非零退出码、超时后进程组清理、捕获不执行 hook/filter；B02 高风险 full、quick/候选档位、未完成 reviewer、所有权校验、`sitecustomize` 不执行；B16 合格发现块与围栏/位置/排序/数量/读取负例；public-contract-callers 的独立验收、保留文件与 benchmark 元数据负例。
- **SWE-bench runner CLI** (`tests/experiments/swebench/test_cli.py`)：`setup` / `run` / `summarize` / `calibrate`；结果读取器对身份、事件计数、协议版本与 F2P/P2P 矛盾的拒绝；manifest 选择与报告计数；模板解包逃逸与合法链接/延迟目录属性；保护模式的收紧权限、损坏/软链记录、父子顺序、失败结束与换 cwd 恢复；补丁采集不执行 Agent hook/filter；P2P 回归与每 arm 报告。
- **事件归因 CLI** (`tests/experiments/swebench/test_analyze_cli.py`)：声明路径、reviewer 完成与报告、P0–P3、文件/模块访问、usage/缓存率/耗时、零发现声明、畸形行容错、`--output` 与 stdout 一致。

## 未覆盖什么

- `analyze_events` 只读 `result.json` 的 usage，事件流 `turn.completed` 的 usage 不聚合，token 0 无法区分“未知”与真实零；这是当前实现的已知限制，测试只固定行为，不宣称“缺失即未知”（见 `tests/experiments/swebench/README.md`）。
- 保护模式的 P2 边缘未逐项迁移：相对 `--protect-paths` 的记录内容、指向实验目录的软链别名、记录落点包含判断（均由 `run.py` 现有实现约束，但当前没有 CLI 回归输入）。
- PID 身份复用、`setsid()` 脱离会话或忽略 SIGTERM 的后代清理、双 fork 被 init 收养等超时清理边界；普通子进程与默认 SIGTERM 响应已覆盖。

- 真实 Codex CLI 与真实模型行为：所有检查都使用替身，只验证验收机制本身，不验证模型是否遵守 EasyDev 流程，也不产生可引用的模型成绩。
- 真实 pytest / SWE-bench 依赖环境：`pytest_stub.py` 只按计划输出状态与 JUnit XML，不执行测试。
- 网络隔离、容器级进程隔离：runner 只请求 Codex CLI 关闭网络；超时清理覆盖进程组与已记录后代，仍不能替代 cgroup、容器或宿主 supervisor。
- Linux CI 上尚未在本机验证的差异（如 `/proc` 进程枚举）由 CI 运行结果补充；本机验证记录只代表 macOS。

## 目录

```text
tests/
├── README.md
├── behavior.md
├── cases/
│   ├── README.md
│   └── public-contract-callers/
│       ├── .gitattributes
│       ├── README.md
│       ├── acceptance.py
│       ├── initial/
│       │   ├── app/{__init__,admin,api,db,orders}.py
│       │   ├── check_orders.py
│       │   ├── docs/orders.md
│       │   └── probe.py
│       ├── run.sh
│       ├── solution.patch
│       └── verify.py
└── experiments/
    ├── README.md
    ├── process_control.py
    ├── review-ablation/
    │   └── README.md
    ├── stubs/
    │   ├── codex_stub.py
    │   └── pytest_stub.py
    ├── agent_runner/
    │   ├── README.md
    │   ├── runner.py
    │   ├── adapters/{__init__,codex_cli}.py
    │   ├── scenarios/{__init__,common,b01,b02,b16,public_contract_callers}.py
    │   └── test_cli.py
    └── swebench/
        ├── README.md
        ├── analyze_events.py
        ├── protocol.py
        ├── run.py
        ├── test_analyze_cli.py
        └── test_cli.py
```

`tests/experiments/review-ablation/README.md` 是四臂消融协议文档，不含测试断言或夹具，因此不随本次测试材料重建删除。
