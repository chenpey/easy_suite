# SWE-bench Lite 小样本 Agent 实验

这个目录保存 EasyDev 的小样本对照实验运行器。它使用 SWE-bench Lite 的
官方任务元数据、base commit、测试补丁、FAIL_TO_PASS 与 PASS_TO_PASS，
但不在本仓库内分发上游源码或测试补丁。

## 实验问题

在模型、宿主、任务、推理深度和工具预算相同的条件下，比较：

- `baseline`：不加载开发流程。
- `checklist`：加载一份通用工程检查清单。
- `easydev`：在项目中安装 EasyDev，并要求使用 `easydev auto`。

主指标是官方任务定义的局部复现结果：

```text
resolved = 全部 FAIL_TO_PASS 通过
           且全部环境基线可通过的 PASS_TO_PASS 仍通过
```

辅助指标包括测试通过率、回归率、耗时、输入/输出 token、工具调用数和失败
原因。`PASS_TO_PASS` 先在本机环境跑基线；环境本身无法通过的测试不进入
回归分母，避免把网络或旧依赖问题误算成 Agent 回归。这不是官方 SWE-bench
Docker harness 的完整替代，报告必须同时披露排除数量和原因。

## 前提

运行器不负责下载数据集、克隆仓库或安装依赖。需要预先准备：

1. Hugging Face 官方 `princeton-nlp/SWE-bench_Lite` 的 300 条元数据 JSON。
2. 每个任务的源码 tar 快照，文件名是 `<instance_id>.tar`。
3. 每个任务的 Python 虚拟环境，目录名是 `<instance_id>`。
4. 可执行的 Codex CLI，以及该 CLI 可用的 `~/.codex/auth.json`。

实验默认使用隔离的临时 `CODEX_HOME` 和 `HOME`，因此不会加载用户级
EasyDev、插件或全局 `AGENTS.md`。只有 `easydev` 组会把本项目的最小运行
文件集安装到任务工作区的 `.agents/skills/easydev/`，并从提交补丁中排除。

如果宿主设置了 `CODEX_SANDBOX_NETWORK_DISABLED=1`，需要在能访问本机模型
代理的环境运行实验。否则 Codex CLI 可能在约 20 秒内以 `returncode=1` 退出，
产生空补丁和 `workspace routing discovery failed`。运行器会检查
`turn.completed`，不把这类基础设施失败计为模型失败，并在下次运行时自动重试。

任务提示要求 Agent 不联网，但当前运行器没有做操作系统级网络隔离。正式
发表式评测应在强制断网的容器中运行，避免把“提示层禁止”误写成“物理隔离”。

## 运行

先校准环境。该步骤不启动 Agent，只验证：

- 测试补丁可以应用；
- 官方 gold patch 能让全部 `FAIL_TO_PASS` 通过；
- 基线可通过的 `PASS_TO_PASS` 在 gold patch 后仍然通过。

```bash
python3 tests/experiments/swebench/run.py calibrate \
  --dataset /path/to/swebench-lite.json \
  --templates /path/to/templates \
  --venvs /path/to/venvs \
  --out /path/to/experiment
```

执行小样本实验。若本机代理端口被宿主沙箱隔离，应在沙箱外运行：

```bash
python3 tests/experiments/swebench/run.py run \
  --experiment /path/to/experiment \
  --repeats 3 \
  --concurrency 2
```

汇总：

```bash
python3 tests/experiments/swebench/run.py summarize \
  --experiment /path/to/experiment
```

`run` 可重复执行；已经完成的 run 会跳过，便于分批补足重复次数。
判定为无效的 Agent 调用不会写入有效结果，也会在下次运行时自动重试。

## 目录产物

```text
<experiment>/
├── manifest.json
├── task-baselines/<instance_id>.json
├── gold/<instance_id>/...
├── runs/<instance_id>/<arm>/r<repeat>/...
├── results.jsonl
├── summary.json
└── report.md
```

每个 run 保存 Agent 事件、stdout/stderr、最终消息、补丁、测试输出和逐测试
状态。报告必须区分“本地小样本预实验”与“官方 SWE-bench Verified 成绩”。
本次 5 任务小样本结果见
[SWE-bench Lite 预实验记录](../../results/swebench-lite-pilot-2026-10-20.md)。
