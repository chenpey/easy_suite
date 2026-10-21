# 最小真实行为 Runner

该目录提供单宿主、多个固定场景的行为回归入口。它复用 SWE-bench 运行器的事件解析、
隔离工作区和补丁归因方式，但不下载数据集、不启动网络服务，也不把决策回放当成
Agent 行为通过。

只有当 reviewer 的 `wait`/`close` 状态为 `completed` 且带回报告时，才记为完成；
仅有 `spawn_agent`、仍在运行或空报告都不算独立审查完成。事件存在 malformed 行或
没有有效事件时，整个调用标为无效，不进入场景通过。

## 首批场景

| 用例 | 检查 | 主要证据 |
| --- | --- | --- |
| B01 | 低风险单文件修改不误入 full，不启动 reviewer，quick 不加载 reference | 产品 diff、事件、最终说明 |
| B02 | 高风险鉴权改动进入 full，并存在已完成 reviewer | 行为验收、事件中的 reviewer 状态与报告 |
| B16 | audit 只读、检查索引、实际读取资金路径，并按严重度报告 | 空 diff、索引状态、文件访问、最终报告 |
| public-contract-callers | 公共契约改造通过独立验收，未改测试或用例材料，且可见命令中未读取已知 benchmark 元数据 | `acceptance.py`、完整 diff、reviewer 事件、访问归因 |

## 使用

列出场景：

```bash
python3 tests/experiments/agent_runner/runner.py list
```

只准备隔离用例，不调用模型：

```bash
python3 tests/experiments/agent_runner/runner.py prepare \
  --scenario public-contract-callers \
  --out /tmp/easydev-behavior
```

运行真实 Codex CLI。模型参数可省略，由宿主默认值决定；模型和推理深度未由工具返回时，
报告应写未知：

```bash
python3 tests/experiments/agent_runner/runner.py run \
  --scenario b02 \
  --out /tmp/easydev-behavior \
  --model <host-model> \
  --reasoning-effort high
```

每个 run 保存：

```text
<out>/runs/<scenario>/easydev/r<n>/
├── workspace/          # 被测仓库，仅安装最小运行时 Skill
├── events.jsonl        # Codex JSONL 原始事件
├── stderr.log
├── last-message.txt
├── agent.patch         # 排除 .agents/skills 后的实际补丁
└── result.json         # 调用状态、归因与场景验收
```

`result.json` 的 `valid_invocation` 要求返回码为 0、`turn.completed=true`、
未超时、至少一个有效事件且 malformed 行为 0；结果带独立标识
`behavior_result_protocol=behavior-v1`，不复用 SWE-bench 的 `result_protocol=2`。
JSON 不是对象、缺少事件类型、`item`/`agents_states` 形状错误或
`receiver_thread_ids` 不是字符串数组的事件都按 malformed 处理，缺少当前协议或
字段的旧结果不会被当作有效结果。行为 runner 的计数直接取自当次
`events.jsonl` 解析，不提供跨进程恢复；SWE-bench runner 从磁盘复用结果时，
另行要求存储计数与事件流一致，并拒绝无效 usage、测试状态、墙钟时间或与
F2P/P2P 测试结果不一致的 `resolved`。
`usage`、`wall_seconds` 和工具调用来自宿主事件，不来自模型自述。`index_changed` 记录采集前暂存内容或
`assume-unchanged`/`skip-worktree` 等索引标志是否变化，B16 要求它为假；采集时会
清除这些标志以捕获隐藏改动，并保留相应证据。运行前后会对安装后的运行时 Skill
计算内容快照，`result.json` 保存 `runtime_skill_changes` 路径列表而非快照正文；
`agent.patch` 排除 `.agents/skills/` 不代表允许篡改该目录。
Git diff 捕获会暂时使用 Agent 运行前的可信 `.git/config`，禁用 hooks 和 fsmonitor，并将系统/全局
Git 配置与 attributes 指向空配置，避免 Agent 配置的 filter 在采集时执行；随后还会检查 `.git` 控制元数据是否改变，
并拒绝 diff 捕获后仍留有未记录的工作区改动。
B16 还会对排除 `.git` 后的全工作区做前后指纹，因此 `.pytest_cache`、
`__pycache__` 等 Git ignored 路径的变化同样会使只读检查失败。
B01/B02/public-contract-callers 的验收子进程使用 `python -S -B`，工作区的 `sitecustomize.py`
不能在验收导入阶段执行；捕获 diff 之外的全工作区变化也会使检查失败。

## 离线自测

```bash
python3 -m unittest discover \
  -s tests/experiments/agent_runner \
  -p 'test_*.py' -v
```

自测会准备 B01/B02/B16 的测试仓库，并用 public-contract-callers 已保存的 `solution.patch` 验证独立验收入口；
它不启动 Codex，也不证明当前模型会遵守流程。

## 限制

- 当前只实现 Codex CLI 适配器，其他宿主需按同一接口单独实现。
- 调用请求 Codex CLI 使用 `workspace-write` 并设置
  `sandbox_workspace_write.network_access=false`；该配置尚未在真实模型中验证，
  也没有文件系统读白名单。正式评测仍应在强制断网和隔离外部文件的容器中运行。
- `request` 只记录命令行请求的模型与深度；宿主未回传实际值时必须写未知，不能用
  请求值代替实际模型。
- reviewer 完成、报告内容与文件访问都是行为证据，不是任务质量或语义正确的证明；
  public-contract-callers 的独立验收仍是唯一隐藏验收入口。
- `file_access` 与 `benchmark_metadata_access` 基于已完成命令的 shell 分段和已知
  路径标记，不是文件系统审计；`git diff --stat`/`--name-only` 等摘要不计为内容
  读取，`--patch`/`-p` 等内容输出优先；`time`/`nice` 包装命令、Python 脚本参数、
  Python `-c` 显式路径和 `.` 递归搜索可识别。已知 benchmark 材料包括
  `solution.patch`、`acceptance.py`、`dataset.json`、`manifest.json`、
  `results.jsonl`、`summary.json`、`result.json`、`report.md`、`agent.patch`、
  `task-baselines`、`gold/`、`runs/`、JUnit/pytest 产物与 `.pytest_cache/`。
  失败命令中的访问尝试仍会记录；`cd`/`pushd`/`popd` 的已知目录上下文会延续到后续分段。
  间接读取、变量拼接或未命中的路径仍是残余风险；public-contract-callers 的通过
  结论只能写成“可见命令中未观察到已知 benchmark 元数据路径”。
- 超时清理会轮询记录后代 PID，并保留根进程身份；发根进程组或 PID 信号前复核身份，
  覆盖仍在进程树中或已记录的 `setsid()` 后代，降低 PID 复用导致误杀的风险；
  进程在两次采样之间完成双 fork 并被 init 收养时，普通用户态代码无法凭 PID 树
  可靠追踪，正式隔离仍需 cgroup、容器或宿主 supervisor。
- 事件存在不代表审查质量；需要结合 reviewer 报告、隐藏验收和成本记录判断。
- 场景检查是行为回归门槛，不是官方的 SWE-bench 或 Agent 通用排行榜成绩。
