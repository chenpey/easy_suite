# ChatGPT 第三轮 Review 处理记录

日期：2026-10-19。对象：EasyDev v0.3.1（提交 `a5871be`）。来源：ChatGPT 共享会话《EasyDev v0.3.1 第三轮 Review》（`https://chatgpt.com/s/t_6ad5d85c22e48191bef0aa4d807f2a23`）。本轮产出 v0.3.2。

处理原则：按 review 的“规则冻结、集中评测”建议，本轮不修改 `SKILL.md` 与 `orchestration.md` 的规则文本，只修评测结论、夹具与验收条件，并补做已定义用例的实测。

## 逐条处理

| Review 项 | 判断 | 处理与证据 |
| --- | --- | --- |
| P1 `full` 闭环完成状态与自身规则冲突（三） | 成立。记录写了“闭环完成”，同时保留了潜在 P1 的待验证风险，与 [execution.md 完成边界](../../references/execution.md#完成边界) 冲突。 | 采纳方案 B：[baseline-0.3.1.md](baseline-0.3.1.md) 改为“`full` 工作流已执行；身份来源可信性未验证；整体交付状态为部分完成/待确认”，并注明该风险属“潜在 P0/P1 的待验证风险”，不因检查通过而降级。未新增完成状态规则。 |
| P2 B30 不是可独立复现的完整夹具（三） | 成立。原记录只有 4 个源文件与输出，缺 `check_orders.py`、初始 `docs/orders.md`、完整补丁和审查原文。 | 新增 [tests/fixtures/b30](../fixtures/b30/)：`initial/`（完整初始仓库，含故意失败的检查）、`solution.patch`（完整 diff）、`reviewer-report.md`（审查原文）、`run.sh`（红→绿一键复验）、`README.md`（预期输出与限制）。`bash tests/fixtures/b30/run.sh` 实测退出 0：初始返回他人订单、检查失败，打补丁后 `PASS: 7/7`。 |
| P2 B30 验收条件过宽（三） | 成立。“同步适配调用方或明确标注破坏性变更”允许只披露风险、不适配调用方，比用户需求宽松。 | [behavior.md B30](../behavior.md) 改为：必须适配仓库内受影响的调用方并验证原有调用路径；无法确认的外部调用方明确记录兼容性风险；未经用户授权的破坏性变更不能仅靠披露风险判定验收完成。 |
| 第二步：运行 B29a/B29b、B31–B33（五） | 部分完成。 | B29a、B29b、B31、B32 已实际执行，见 [0.3.2 路由与负向激活记录](routing-0.3.2.md)。B33 需要构造一次只产生可延期 P3 的完整送审，本轮未执行，保留为验证欠账。 |
| 第三步：小规模成本与质量对照（五） | 未实施。 | 未做“不加载 Skill / v0.3.0 / v0.3.1”对照，也未采集 Token、耗时、成功率；无计量条件下不宣称成本收益。建议固定宿主与模型、选 6–10 个代表性任务后再做，避免单次结果被当作统计。 |
| `version-check.yml` 只保证版本一致性（四） | 接受。 | 保持现状，不把它描述为行为测试；行为验证仍以 `tests/behavior.md` 与结果记录为准。 |
| 不建议继续扩规则/路径（四、六） | 接受。 | 本轮未新增路径、档位、强制角色或适配层，未改分流规则文本。 |

## 本轮验证

- `bash tests/fixtures/b30/run.sh`：红→绿，退出 0（初始检查失败、补丁后 `PASS: 7/7`）。
- B29a/B29b/B31/B32：独立实例执行，结果与证据见 [routing-0.3.2.md](routing-0.3.2.md)。
- `node scripts/version.mjs check`：版本文件同步。
- `node --test test/version.test.mjs test/reset.test.mjs`：11/11 通过。
- `git diff --check`、两份 JSON 解析、Markdown 本地链接检查通过。

## 未覆盖与限制

- B33 未执行；B01–B28 未重跑；跨模型重复与成本计量未做。
- 行为执行均为单宿主（DeepSeek Harness）、最小夹具；子代理实际模型与推理深度未由工具返回。
- `full` 实验的交付状态为“部分完成/待确认”，不是可安全发布的证明。
