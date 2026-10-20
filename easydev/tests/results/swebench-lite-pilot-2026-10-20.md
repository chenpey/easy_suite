# SWE-bench Lite 小样本 Agent 预实验

日期：2026-10-20。对象：EasyDev `0.3.10` 工作树。实验目录：
`/private/tmp/easydev-swebench-pilot/experiment-v2`。

> 这是本机 5 任务小样本预实验，不是官方 SWE-bench Verified 成绩，也不能
> 单独证明 EasyDev 的总体解决率、缺陷率或成本收益。

## 实验协议

- 数据集：SWE-bench Lite 官方元数据，SHA256
  `db15b7195d9cd229e80bf2f600ff55775ff204ba99f61bd4f83c1ad972437ccb`。
- 任务：`pallets__flask-4045`、`pallets__flask-5063`、
  `psf__requests-3362`、`pylint-dev__pylint-5859`、
  `pytest-dev__pytest-8906`。
- 模型：`opencode-go/deepseek-v4.1-flash`，推理深度 `low`。
- 对照组：`baseline` 不加载开发流程；`checklist` 加载通用工程检查清单；
  `easydev` 安装并调用 EasyDev。
- 规模：5 任务 × 3 组 × 3 次重复，共 45 次 Agent 运行。
- 有效性：45/45 次均为 `agent_returncode=0` 且 `turn.completed=true`；
  基础设施失败和超时均为 0。
- 判定：全部 `FAIL_TO_PASS` 通过，且环境基线可通过的
  `PASS_TO_PASS` 无回归，才记为 `resolved`。
- 补丁：只允许产品源码改动；所有测试文件改动从提交补丁中剔除；隐藏测试后置
  应用，避免 Agent 通过改测试获得通过。
- 环境：本机 Python 虚拟环境与 pytest，不是官方 SWE-bench Docker harness。
  环境本身无法通过的 `PASS_TO_PASS` 已从回归分母排除。
- 网络：提示词禁止联网，但没有操作系统级强制隔离。这是协议限制，不是已证明
  的无联网条件。
- token：统计现有 Agent 事件暴露的 usage；EasyDev 子代理或供应商侧隐藏计费
  可能未被完整计入。

实验前已运行官方 gold patch 校准，5 个任务均可使目标测试通过。重新运行
`bash tests/fixtures/b30/run.sh` 退出 0：红阶段恰好 3 条 `TypeError`，绿阶段
`PASS: 7/7` 与 `PASS: 38/38`，九类负向伪修复全部被拒绝，且未生成
`__pycache__`/`.pyc`。这证明 B30 固定补丁验收能拒绝已知捷径，但不等于
SWE-bench Agent 行为通过。

## 主结果

| Arm | runs | resolved | resolved rate | F2P pass | P2P regression | mean wall (s) | mean input tokens | mean tool calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 15 | 7 | 46.7% | 46.7% | 0.0% | 92.4 | 500121 | 28.1 |
| checklist | 15 | 6 | 40.0% | 40.0% | 0.0% | 110.7 | 616178 | 32.8 |
| easydev | 15 | 7 | 46.7% | 46.7% | 0.0% | 220.3 | 1080618 | 40.8 |

## 成本

| Arm | median wall (s) | median input tokens | median output tokens | input tokens / resolved | wall seconds / resolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 79.1 | 398636 | 11481 | 1071687 | 198.0 |
| checklist | 100.6 | 543886 | 14595 | 1540445 | 276.8 |
| easydev | 174.3 | 879320 | 15489 | 2315610 | 472.0 |

EasyDev 相对 baseline：

- 平均输入 token：`1080618 / 500121 = 2.16x`。
- 平均耗时：`220.3 / 92.4 = 2.38x`。
- 平均工具调用：`40.8 / 28.1 = 1.45x`。
- 每解决一题的输入 token：`2.16x`。
- 每解决一题的耗时：`2.38x`。

## 配对比较

- `checklist - baseline`：解决率风险差 `-6.7%`，任务级 bootstrap
  95% CI `[-20.0%, +0.0%]`；任务胜/负/平 `0/1/4`。
- `easydev - baseline`：解决率风险差 `0.0%`，任务级 bootstrap
  95% CI `[-20.0%, +20.0%]`；任务胜/负/平 `1/1/3`。

5 个任务下区间非常宽，任何正负点估计都不足以支持总体结论。

## 分任务

| Task | baseline | checklist | easydev |
| --- | ---: | ---: | ---: |
| pallets__flask-4045 | 0/3 | 0/3 | 0/3 |
| pallets__flask-5063 | 1/3 | 0/3 | 0/3 |
| psf__requests-3362 | 0/3 | 0/3 | 1/3 |
| pylint-dev__pylint-5859 | 3/3 | 3/3 | 3/3 |
| pytest-dev__pytest-8906 | 3/3 | 3/3 | 3/3 |

EasyDev 多解决一次 requests，同时少解决一次 Flask；两个变化抵消，整体解决率
与 baseline 持平。这说明结果更接近任务间的差异探索，没有证据表明存在稳定的
普遍增益。

## 已实测结论与未证明收益

已实测：

- 在本样本、本模型和本宿主上，未观察到 EasyDev 相对 baseline 的解决率收益。
- EasyDev 的 token、耗时和工具调用成本均更高。
- 三组均未出现可用 `PASS_TO_PASS` 回归，但 baseline 也没有回归，因此不能由
  此声称 EasyDev 降低了回归率。
- 测试文件剔除和隐藏测试后置使“改测试骗过评测”的路径不进入 `resolved`；
  B30 进一步证明固定补丁验收可拒绝九类伪修复。
- 45 次 Agent 调用本身均完整结束，未把沙箱启动失败计为模型失败。

尚不能证明：

- 更大任务集上的总体解决率提升。
- P0/P1 缺陷、生产事故或合并后回归的降低。
- 人工审查时间、返工成本或总拥有成本的降低。
- 跨模型、跨宿主、跨语言和跨仓库类型的泛化。
- 网络被硬隔离下的效果，以及子代理 token 的完整成本。

## 用流行测试集形成可发表证据

### 1. 主测试集

- `SWE-bench Verified`：人工验证的 Python 仓库级修复集，最适合作为主指标。
- `SWE-bench Lite`：成本较低，适合预实验、功效模拟和回归筛查；本报告仅使用
  其中 5 题，不能替代完整 Lite。
- `SWE-bench Pro`：用于更困难、污染控制更强的确认性评测，检验结论是否能外推。
- `Terminal-Bench`、Aider Polyglot 或 LiveCodeBench：作为终端操作、多语言和
  非仓库型编码任务的补充，不与 SWE-bench 分数混为一个指标。

HumanEval、MBPP 一类函数级题目已高度饱和，不足以证明仓库级开发流程的收益，
不应作为主证据。

### 2. 对照设计

至少保留 `baseline`、`checklist` 和 `easydev`，并把 EasyDev 的关键机制做消融：
测试验证、契约与调用方检查、独立审查、风险路由。每组的模型版本、推理深度、
工具集合、最大步数、时间和网络条件必须相同。

### 3. 样本与重复

建议分两阶段：

1. 先随机抽取约 50 个任务、每组重复 3 次，估计方差、运行成本和任务级不一致率。
2. 再冻结协议，在完整 SWE-bench Lite 或 Verified 上重复 5 次；不要在看到结果后
   选择性增加或删除任务。

具体样本量必须先做功效模拟，而不是承诺“跑 300 题一定够”。如果目标是证明
`+5` 个百分点且当前任务级风险差约 `0`，所需任务数通常远大于本实验。

### 4. 统计判定

- 先把同一任务的重复运行聚合为任务级通过率，再以任务为配对单位比较。
- 二元结果可报告风险差及任务级 cluster bootstrap 95% CI；对单次配对结果可用
  McNemar 检验。重复嵌套在任务内时，可用带任务随机效应的混合效应 logistic
  模型或 GEE。
- 预先规定最小有意义增益，例如 `+5` 个百分点，并要求 95% CI 下限高于该阈值；
  只用点估计为正不能证明收益。
- 同时报告成本、回归率、失败 F2P、补丁大小、测试修改尝试和人工审查耗时，避免
  以更高成本换取不可检测的微小提升。
- 多模型、多宿主使用分层分析；不同推理深度不得合并成同一主结果。

### 5. 防作弊与可复现

- 使用官方 SWE-bench Docker harness 或同等强制隔离容器，固定依赖和镜像摘要。
- 隐藏测试后置应用，拒绝测试文件改动、跳过标记、测试发现篡改和输出伪造。
- 强制断网，避免从公开 issue、PR 或网络答案获得提示。
- 保存数据集 SHA256、任务采样清单、Git commit、模型版本、提示词、随机种子、
  原始事件、补丁、逐测试状态和成本。
- 预注册主指标、排除规则、重复次数和停止条件；将 Lite 用于开发、Verified
  用于确认，避免在同一集合上调参后再次宣称独立验证。

只有上述确认性实验显示解决率在统计和经济上均有实际收益，才能把 EasyDev 的
预期收益从“流程假设”升级为“经验证的产品效果”。
