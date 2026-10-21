# SWE-bench Lite 小样本实验

本目录保存 EasyDev 的小样本对照实验运行器。它使用 SWE-bench Lite 的任务元数据、base commit、测试补丁、FAIL_TO_PASS 与 PASS_TO_PASS，但不在本仓库内分发上游源码或测试补丁。

## 判定

```text
resolved = 全部 FAIL_TO_PASS 通过
           且环境基线可通过的 PASS_TO_PASS 无回归
```

`PASS_TO_PASS` 先在本机环境跑基线；环境本身无法通过的测试不进入回归分母。这不是官方 SWE-bench Docker harness 的完整替代，报告必须披露排除数量与原因。

## 前提

运行器不负责下载数据集、克隆仓库或安装依赖。需要预先准备：

1. 官方 `princeton-nlp/SWE-bench_Lite` 元数据 JSON。
2. 每个任务的源码 tar 快照 `<instance_id>.tar`。
3. 每个任务的 Python 虚拟环境目录 `<instance_id>`。
4. 可执行的 Codex CLI 与该 CLI 可用的 `~/.codex/auth.json`。

模板可以包含指向包内相对路径的软链与硬链，提取时会保留。绝对路径链接、词法上或解析后逃出解包目标目录的链接（含 `..` 逃逸、经由已有包内软链的逃逸、硬链指向归档外路径）会让提取中止；归档成员按顺序逐个校验后立即提取，先前成员建立的链接已落盘，后续成员无法绕过。只读目录（`0555`/`0500`）在全部成员写入后才应用权限，因此不会挡住目录内的文件。

## 命令

```bash
# 校准：只验证测试补丁可应用、gold patch 使 F2P 通过且 baseline P2P 无回归
python3 tests/experiments/swebench/run.py calibrate \
  --dataset /path/to/swebench-lite.json \
  --templates /path/to/templates \
  --venvs /path/to/venvs \
  --out /path/to/experiment

# 只复制/链接实验资产，不跑 pytest
python3 tests/experiments/swebench/run.py setup \
  --dataset /path/to/swebench-lite.json \
  --templates /path/to/templates \
  --venvs /path/to/venvs \
  --experiment /path/to/experiment

# 运行小样本实验；已完成的 run 会跳过
python3 tests/experiments/swebench/run.py run \
  --experiment /path/to/experiment --repeats 3 --concurrency 2

# 汇总
python3 tests/experiments/swebench/run.py summarize \
  --experiment /path/to/experiment
```

`run` 默认保护 `dataset.json`、`task-baselines/`、`gold/`，可用 `--protect-paths` 追加；保护期间这些路径 mode 为 0，运行结束恢复。被中断的运行会在下次启动时按 `protected-modes.json` 先恢复 mode；指向实验目录或其祖先的保护会被拒绝，避免把记录本身锁死。

## 事件归因

已有运行目录可单独分析，不调用 Agent：

```bash
python3 tests/experiments/swebench/analyze_events.py \
  --experiment /path/to/experiment
```

分析器分别记录模型声明的初始/最终路径、实际 `spawn_agent` reviewer、已完成 reviewer 与报告、P0–P3、reference 文件访问、usage、缓存率与耗时，并单列“声明 quick 但启动 reviewer”等路由偏差。只有状态为 `completed` 且带回报告的 reviewer 才计入完成数；malformed 事件行计入统计但不会中断解析。分析器不会推断子代理完整 token，也不把 reviewer 报告当成独立验收。

### 已知限制：usage 来源与“未知 / 零”不可区分

`analyze_events` 目前只读 `result.json` 的 usage（含嵌套的 `agent.usage`），**不聚合事件流 `turn.completed` 里的 usage**。因此：

- 只有事件 usage、没有 result usage 时，token 计数输出 0，缓存率为 `None`；
- 只有 result usage 时按 result 汇总；
- 两者都缺失时输出 0 与 `None`；
- 真实的零 token 也输出 0，无法与“未知”区分。

这是当前实现的 characterization，不是“缺失即未知”的满足证明；要满足该语义需要产品侧修改分析器（本次不改被测系统）。离线测试 `test_usage_source_matrix_documents_known_limit` 固定了这四组输入的实际行为。

## 离线自测

```bash
python3 -m unittest discover -s tests/experiments/swebench -p 'test_*.py' -v
```

- `test_cli.py` 驱动 `setup`/`run`/`summarize`/`calibrate`，用 `tests/experiments/stubs/codex_stub.py` 与 `pytest_stub.py` 替代外部进程，覆盖结果读取器拒绝（身份、事件计数、协议、F2P/P2P 矛盾）、manifest 选择与报告计数、模板逃逸与合法链接/延迟目录属性、保护模式恢复细节、采集不执行 Agent hook/filter、无效调用、P2P 回归与报告。
- `test_analyze_cli.py` 驱动 `analyze_events.py`，覆盖路由否定/候选档位、reviewer 完成条件、访问与元数据归因、current-protocol 契约、behavior 协议、嵌套 usage、零发现声明、畸形结构、usage 来源矩阵与 `--output`。

两组检查不启动真实 Codex，也不执行真实 pytest，因此不能替代真实实验。

## 产物

```text
<experiment>/
├── manifest.json
├── protected-modes.json        # 仅在运行中或中断后存在
├── task-baselines/<instance_id>.json
├── gold/<instance_id>/...
├── runs/<instance_id>/<arm>/r<repeat>/
│   ├── events.jsonl
│   ├── stdout.log / stderr.log / last-message.txt
│   ├── agent.patch
│   ├── result.json 或 invalid-result.json
│   └── grade/{junit.xml,pytest.stdout.log,pytest.stderr.log}
├── results.jsonl
├── summary.json
└── report.md
```

## 限制

- 本目录只做补丁级小样本实验，不是官方成绩；报告必须区分本地预实验与官方 Verified。
- 请求关闭网络不等于已经具备强制隔离；正式评测仍应在断网、隔离基准材料的容器中运行。
- patch 采集使用运行前保存的可信 `.git/config`，并禁用 hooks、fsmonitor、系统/全局 Git 配置与 attributes。
