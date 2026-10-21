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
回归分母，避免把网络或旧依赖问题误算成 Agent 回归。即使测试文件里还有其他
可运行测试，回归分母也只包含官方任务 `PASS_TO_PASS` 列出的 nodeid。这不是官方
SWE-bench Docker harness 的完整替代，报告必须同时披露排除数量和原因。

## 前提

运行器不负责下载数据集、克隆仓库或安装依赖。需要预先准备：

1. Hugging Face 官方 `princeton-nlp/SWE-bench_Lite` 的 300 条元数据 JSON。
2. 每个任务的源码 tar 快照，文件名是 `<instance_id>.tar`。
3. 每个任务的 Python 虚拟环境，目录名是 `<instance_id>`。
4. 可执行的 Codex CLI，以及该 CLI 可用的 `~/.codex/auth.json`。

模板可以包含指向包内相对路径的软链与硬链，提取时会保留。绝对路径链接、
以及词法上或解析后逃出解包目标目录的链接（含 `..` 逃逸、经由已有包内软链的
逃逸、硬链指向归档外路径）会让提取中止。无论 Python 是否有 `data_filter`，
解包都按归档成员顺序逐个校验后立即提取，先前成员建立的链接已落盘，
归档内后建的链接无法绕过校验。这类模板应在打包阶段展开链接。

可以保留完整官方数据集，只用 `--tasks` 校准和运行需要评测的子集。实验目录仍保存
带哈希的完整数据集。校准时写入的 `manifest.json` 记录本次任务子集；`summarize`
按该清单与实际 run 的并集校验任务契约，事件归因按实际 run 校验任务契约。没有
manifest 时，结果读取按实际 run 任务选择，若尚无 run 则校验完整数据集，避免漏掉
缺失或不一致的 baseline。请求涉及的任务仍需存在对应 template、venv 和
`task-baselines/<instance_id>.json`。

实验默认使用隔离的临时 `CODEX_HOME` 和 `HOME`，因此不会加载用户级
EasyDev、插件或全局 `AGENTS.md`。只有 `easydev` 组会把本项目的最小运行
文件集安装到任务工作区的 `.agents/skills/easydev/`，并从提交补丁中排除。

如果宿主设置了 `CODEX_SANDBOX_NETWORK_DISABLED=1`，需要在能访问本机模型
代理的环境运行实验。否则 Codex CLI 可能在约 20 秒内以 `returncode=1` 退出，
产生空补丁和 `workspace routing discovery failed`。运行器会检查
`turn.completed`，不把这类基础设施失败计为模型失败，并在下次运行时自动重试。

任务提示要求 Agent 不联网，运行器还会请求 Codex CLI
`sandbox_workspace_write.network_access=false`。该请求尚未在真实模型中验证，
也没有文件系统读白名单；正式发表式评测仍应在强制断网和隔离基准材料的容器中运行。

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

只复制实验资产、不跑基线时使用 `setup`：它把数据集、任务模板和虚拟环境链接进实验目录，
不执行 pytest；需要判定 F2P/P2P 基线时仍要跑 `calibrate`。

```bash
python3 tests/experiments/swebench/run.py setup \
  --dataset /path/to/swebench-lite.json \
  --templates /path/to/templates \
  --venvs /path/to/venvs \
  --experiment /path/to/experiment
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
补丁采集使用 Agent 启动前保存的可信 `.git/config`，并禁用 `core.hooksPath`、
fsmonitor、系统/全局 Git 配置与 attributes，避免 Agent 植入的 hook 或 clean
filter 在宿主机执行或改写待评分补丁。

## 离线事件归因

已有运行目录可单独分析，不调用 Agent：

```bash
python3 tests/experiments/swebench/analyze_events.py \
  --experiment /path/to/experiment
```

分析器按 run 输出实际出现过的 `spawn_agent` reviewer 实例、已完成的 reviewer 与
报告、P0–P3、reference 文件访问、usage、缓存率与耗时，并单独列出“声明 quick 但
启动 reviewer”等路由偏差。只有状态为 `completed` 且带回报告的 reviewer 才计入
完成数；重复出现的同一报告快照只计一次。空白、非对象事件或 malformed 事件流会
被标记。当前 runner 只把带 `result_protocol=2`、零超时、非空事件和零 malformed
行的完整结果计入有效汇总。历史实验缺少当前协议，只作为事件归因和“历史存储
结果”展示，不把其中的 `resolved` 当作当前协议验收。分析器不会推断子代理完整
token，也不把 reviewer 报告当成独立验收。

初始路径只从最后一条 agent 消息之前提取，最终路径单独记录；模型自述与实际
`spawn_agent` 行为分开统计，初始 `quick` 到最终 `full` 也计为真实迁移。读取归因
按 shell 分段识别内容命令、搜索目录、glob 和 `git show/diff`，剥开
`time`/`nice` 等包装命令，并让 `--patch`/`-p` 等内容输出覆盖
`--stat`、`--name-only` 等摘要模式；Python 脚本参数、`-c` 中的显式文件路径和
`.` 递归搜索也会计入。不能证明文件被完整理解；`file_access` 与 benchmark 元数据
访问仍是命令文本信号，不是文件系统审计，间接读取或变量拼接仍是残余风险。

## 与行为 Runner 的边界

本目录继续负责 SWE-bench Lite 补丁级实验；B01/B02/B16 和
public-contract-callers 的流程行为验证使用
[`../agent_runner/`](../agent_runner/README.md)。SWE-bench prompt 禁止新增、删除或
修改测试，因此该实验不能用于评价 EasyDev 的 TDD 或测试补写收益。

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
