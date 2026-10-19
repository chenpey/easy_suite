# ChatGPT 第四轮 Review 处理记录

日期：2026-10-19。对象：EasyDev v0.3.2（提交 `1e6733b`）。来源：ChatGPT 共享会话《EasyDev v0.3.2 第四轮 Review》（`https://chatgpt.com/s/t_6ad5dba16ee48191b89a22be3bf484ee`）。本轮产出 v0.3.3。

处理原则：继续执行“规则冻结”，不修改 `SKILL.md` 与 `orchestration.md` 的规则文本；只加固测试可靠性、补 CI 与补跑 B33。

## 逐条处理

| Review 项 | 判断 | 处理与证据 |
| --- | --- | --- |
| P2-1 B30 的 Red 阶段不校验失败原因（三） | 成立。原脚本接受任意非零退出，无法区分契约未实现、导入错误或环境故障。 | [run.sh](../fixtures/b30/run.sh) 现在先执行 `probe.py 200` 证明越权读取返回 200，再要求 `check_orders.py` 恰好因 3 条 `TypeError` 失败，其他原因直接判夹具异常；打补丁后要求 `probe.py 403`。补丁后另跑独立验收。 |
| P2-2 固定补丁复验与 Agent 行为评测未解耦（三） | 成立。原 `solution.patch` 同时改动生产代码、调用方与测试断言，被测 Agent 可以定义验收标准。 | 新增 [acceptance.py](../fixtures/b30/acceptance.py)，断言集不在被测仓库内、不依赖 `check_orders.py`；夹具 README 区分三种用途：历史补丁复验、Agent 任务执行评测（只给 `initial/` 与需求）、独立验收（评测工作区外的断言）。没建 Eval Harness。 |
| CI 不运行 B30 夹具（四） | 成立，属作用范围缺口而非错误。 | 新增 `.github/workflows/easydev-fixture.yml`：仅在 `easydev/**` 变更时执行 `bash easydev/tests/fixtures/b30/run.sh`。真实 Agent 行为测试（B29–B33）仍不进入 CI。 |
| P1 实测 B33（六） | 已完成，分两部分。 | B33a：真实 `full`，首轮独立审查零发现，按停止条件直接交付、不追加轮次。B33b：给定一条可延期 P3 的决策回放，判定“未实施建议”，保持 r=1/4、不进入 r=2。见 [B33 记录](b33-convergence-0.3.3.md)。真实链路中“reviewer 恰好只报一条 P3”仍未构造。 |
| P1 开展小规模成本与质量对照（六） | 未执行。 | 未采集成功率、Token、耗时与返工率，不虚构数据。建议按 review 的 8 任务 × 3 变体 × 3 重复单独执行，固定宿主与模型并使用外部验收。 |
| 增加“调查后应走 full”的 B32 对照（五） | 未执行。 | 保留为验证欠账，未扩写用例。 |
| 规则冻结、不再扩规则（七） | 遵守。 | 本轮未改分流、审查、完成边界的规则文本，未新增路径或角色。 |

## 本轮验证

- `bash tests/fixtures/b30/run.sh`：`probe.py 200` → 红（3 条 `TypeError`）→ 应用补丁 → `probe.py 403` → `PASS: 7/7` → `PASS: 8/8 independent acceptance checks`，退出 0。
- 负向验证：对未修复的 `initial/` 直接运行 `acceptance.py` 失败，且单独捕获“他人读取返回 200”的越权行为。
- B33a：独立审查实际运行检查与 10,000 个随机整数的性质验证，零发现。
- `node scripts/version.mjs check`；`node --test` 11/11；`git diff --check`；Markdown 本地链接检查。

## 未覆盖与限制

- B33b 是决策回放，不是真实审查运行；不能据此声称 reviewer 只报 P3 的真实链路已验证。
- 成本/质量对照、B32 的 full 对照未做；B01–B28 未重跑。
- 执行均为单宿主（DeepSeek Harness）、最小夹具；子代理实际模型与深度未由工具返回。
