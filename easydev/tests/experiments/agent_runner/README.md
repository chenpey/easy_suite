# 单宿主行为 Runner

`runner.py` 为固定行为场景准备隔离仓库、调用 Codex CLI、采集事件与补丁，并用场景验收判定结果。它不下载数据、不启动网络服务，也不把决策回放当成 Agent 行为通过。

## 命令

```bash
python3 tests/experiments/agent_runner/runner.py list
python3 tests/experiments/agent_runner/runner.py prepare \
  --scenario public-contract-callers --out /tmp/easydev-behavior
python3 tests/experiments/agent_runner/runner.py run \
  --scenario b02 --out /tmp/easydev-behavior \
  --model <host-model> --reasoning-effort high
```

`prepare` 不调用模型；`run` 才执行真实宿主。`--codex-bin`、`--codex-auth` 和 `--agent-timeout` 可注入外部命令行、认证文件与超时，离线测试正是通过这些入口使用替身。

## 场景

| ID | 检查 | 主要证据 |
| --- | --- | --- |
| `b01` | 低风险单文件文案修改保持 quick：只改 `src/ui.py`、不加载 reference、不启动 reviewer、索引与运行时 Skill 不变、末行声明 `审查状态：自查` | `changed_paths`、`index_changed`、`runtime_skill_changes`、事件归因、最终消息 |
| `b02` | 高风险对象所有权校验进入 full，且存在已完成并带回报告的 reviewer | 行为验收、声明路径、reviewer 完成数 |
| `b16` | audit 只读：不改文件/索引/Git 元数据/运行时 Skill，实际读取 `src/ledger.py`，报告机器可核对发现块 | 空 diff、`file_access`、`easydev-findings` 块解析 |
| `public-contract-callers` | 公共契约改造通过独立验收，未改测试或用例材料，未观察到 benchmark 元数据访问，且有完成的 reviewer | `acceptance.py`、完整 diff、reviewer 事件、访问归因 |

场景模块只依赖可观测结果：改动路径集合、最终消息中的显式机器块、事件归因字段。`evaluate` 返回 `{"passed", "checks": [{"name", "passed", "detail"}], "details"}`，每个 check 对应一个可独立定位的失败原因。

## 产物

```text
<out>/runs/<scenario>/easydev/r<n>/
├── workspace/          # 被测仓库，仅安装最小运行时 Skill
├── events.jsonl        # Codex JSONL 原始事件
├── stderr.log
├── last-message.txt
├── agent.patch         # 排除 .agents/skills 后的实际补丁
└── result.json         # 调用状态、归因与场景验收
```

`valid_invocation` 要求返回码为 0、`turn.completed=true`、未超时、至少一个有效事件且 malformed 行为 0；结果使用独立协议 `behavior_result_protocol=behavior-v1`。只有 reviewer 的 `wait`/`close` 状态为 `completed` 且带回报告才计为独立审查完成。`index_changed` 记录采集前暂存内容或 `assume-unchanged`/`skip-worktree` 等索引标志；运行前后对安装后的运行时 Skill 做内容快照，`runtime_skill_changes` 记录变化路径。

## 离线自测

```bash
python3 -m unittest discover -s tests/experiments/agent_runner -p 'test_*.py' -v
```

`test_cli.py` 通过 `runner.py` 的 CLI 驱动 `tests/experiments/stubs/codex_stub.py`，覆盖 `list`/`prepare`/`run`、B16 合格发现块与只读违约、安全边界（运行时 Skill 篡改、索引被暂存、超时进程树清理）与事件有效性。它不启动 Codex，也不证明当前模型会遵守流程。

## 限制

- 只实现 Codex CLI 适配器。
- 调用请求 `workspace-write` 和 `sandbox_workspace_write.network_access=false`；该配置尚未在真实模型中验证，也没有文件系统读白名单。
- `request` 只记录命令行请求的模型与深度；宿主未回传实际值时必须写未知。
- reviewer 完成与报告是行为证据，不是任务质量或语义正确的证明。
- `file_access` 与 `benchmark_metadata_access` 基于命令文本，不是文件系统审计；间接读取与变量拼接仍是残余风险。
- 超时清理覆盖进程组和已记录后代，正式隔离仍需容器、cgroup 或宿主 supervisor。
- B16 的发现块判定只核对格式、1–20 条、P0→P3 排序、`文件:行号` 位置与字段非空，不判断结论正确性或发现完整性；B01 的状态标记不证明自查真的发生。
