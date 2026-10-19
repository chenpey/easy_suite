# Gemini Review 处理记录（0.3.4）

日期：2026-10-19。对象：EasyDev 0.3.4（对 0.3.3 的 Gemini review 修复），基线提交 `31988fa` 加本轮修复。来源：用户提供的 Gemini 对当前项目的 review 文本（无公开链接）。

处理原则：只改 B30 夹具、验收脚本、B30 任务提示与安装说明；不修改 `SKILL.md` 与编排规则。本轮修复随 0.3.4 发布。独立审查只读，未修改工作区。

## 逐条处理

| Review 项 | 判断 | 处理与证据 |
| --- | --- | --- |
| P2：`acceptance.py` 未校验单参/空身份，伪修复仍 8/8 | 成立。 | 复现：`get_order(order_id, current_user_id=None)` 在 `None` 时返回订单、`api.py` 传身份，`acceptance.py` 输出 `PASS: 8/8`；`get_order("o1")`、`get_order("o1", None)`、`handle_show_order({}, "o1")` 均返回订单。修复：新增 `contains_order`/`expect_no_order` 与三条负向断言；`run.sh` 增加伪修复回归，要求恰好 3 条失败并匹配三个 label。修复后 `PASS: 12/12`，伪修复非零退出。 |
| P2：未声明 403 契约；`behavior.md` 内联摘录与 `initial/` 双源 | 部分成立。403 精确形状确实未在任务材料声明，带 `error` 字段的正确实现会被判失败；但“没有任何位置提及 `user_id`”只对内联摘录成立，`initial/probe.py` 与 `initial/check_orders.py` 已分别出现 `user_id` 与 `PermissionError`。 | 修复：[B30 用户请求](../behavior.md)显式声明 `request["user_id"]`、`PermissionError`、`{"status": 403}`（仅 status）与 404；[内联摘录](../behavior.md)注明完整夹具以 `tests/fixtures/b30/initial/` 为准。403 精确匹配保留，避免 403 响应携带订单内容。 |
| P3：手动复制/CLI 安装带入 `.pi` 与 `tests` | 成立（本地复制）。CLI 复制集未验证。 | 修复：[README](../../README.md)手动安装只列运行时文件，排除 `.pi/` 与 `tests/`；更新说明同步；CLI 安装后要求检查目录，包含则删除。未声称 CLI 会自动过滤。 |
| 待验证风险：多宿主与 B03–B21b 未重跑 | 成立，属已披露覆盖欠账。 | 本轮不重跑；保留为待验证风险。优先 B06/B08/B21a/B21b/B28。 |

## 本轮验证

- `bash tests/fixtures/b30/run.sh`：红 3 条 `TypeError` → 绿 `PASS: 7/7` + `PASS: 12/12` → 负向恰好 3 条失败并拒绝伪修复，退出 0。
- 旧 `acceptance.py` 对伪修复 `PASS: 8/8`；新脚本拒绝，证明缺口已封。
- 安全 `None` 返回、抛 `RuntimeError`、固定补丁均 `PASS: 12/12`；`{"total":120}`、`{"data":order}`、`[order]` 三种泄露均被拒。
- `node ../scripts/version.mjs check`、`node --test ../test/version.test.mjs` 5/5、`git diff --check`、本地 Markdown 链接检查通过。
- 独立审查：r=1 报 3 条 P3（部分字段/嵌套容器泄露、负向只查第一条、README 另一处“替换整个文件夹”），修复后 r=2 全部关闭；r=3/r=4 完成记录与目录树收尾，未发现新确定缺陷。首个审查实例超时未返回，已用新实例完成同一轮；实际模型与深度未由工具返回，记为未知。

## 未覆盖与限制

- `npx skills add` 实际复制集未实测；`skills` 包不在本地，离线不可用。README 只提供人工检查/删除步骤。
- 真实 Agent 行为评测与多宿主未运行；B30 仅最小 Python 夹具。
- `request["user_id"]` 的上游可信性仍是夹具外待验证风险。
- `contains_order` 是字段名启发式；改名后的订单字段理论上可绕过，但三种已报告泄露与契约字段已覆盖。
- 历史记录 [chatgpt-review-0.3.2.md](chatgpt-review-0.3.2.md)、[chatgpt-review-0.3.3.md](chatgpt-review-0.3.3.md) 中的 `8/8` 对应旧提交，保留不改；当前夹具为 `12/12`。
