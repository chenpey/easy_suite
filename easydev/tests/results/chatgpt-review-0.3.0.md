# ChatGPT 第二轮 Review 处理记录

日期：2026-10-19。对象：EasyDev v0.3.0（提交 `2a7ab3a`）。来源：ChatGPT 共享会话《EasyDev v0.3.0 第二轮 Review》（`https://chatgpt.com/s/t_6ad5ccc5b5548191bf9591ccb060ba11`）。本轮产出 v0.3.1；逐条按该 review 的章节处理，未采纳项给出理由。

## 逐条处理

| Review 项 | 判断 | 处理与证据 |
| --- | --- | --- |
| P1 版本信息未统一（二） | 成立。`versions.json` 仍为 0.2.0，根 README 表格未更新，`node scripts/version.mjs check` 退出 1。 | 用 `scripts/version.mjs set easydev 0.3.1` 同步 `versions.json`、根 README 与 `easydev/README.md`；为 EasyDev 增加 `notesPath`，使 `check` 校验 CHANGELOG 发布说明；新增 `.github/workflows/version-check.yml`，在 push/PR 执行 `check`。验证：`node scripts/version.mjs check` 通过。 |
| P1 B29 不能算严格满足（三） | 成立。原用例把“解释正则”和“模型选型”合并判定，误把回答问题所需的读取当成流程加载。 | 拆为 B29a（纯非开发问题，不读 `references`）与 B29b（规则咨询可读 `models.md`/`models.json`，但不建账本、不声明路径、不进入流程）。 |
| P1 缺少完整 full 实测（三、六） | 成立。上一轮四个用例均禁用子代理，未覆盖独立审查闭环。 | 按 B30 夹具实测一条完整链路：鉴权改动判 `full`、修复前复现、红绿验证、冻结 diff 后由独立子代理只读审查（r=1/4）。记录见 [0.3.1 全链路记录](baseline-0.3.1.md)。 |
| P1 `quick / full` 两处歧义（三） | 成立。初始不确定性会让普通 Bug 进入 `full`；用户限流与高风险优先级的优先关系未写清。 | SKILL.md 分流段改为按最小必要调查后的实际影响判定：任务描述不完整、根因未定位、跨文件本身不构成 `full` 理由；调查后影响变大才升级；用户限定时遵守授权但不省略安全验证，缺独立审查如实报告缺口，不因省成本执行无法控制的危险操作。对应 B31/B32。 |
| P1 审查争议产生多余轮次（三） | 成立。P3 建议与“排除发现须下一轮确认”可能叠加，形成成本放大器。 | orchestration.md：不实施不影响验收的低影响 P3 属延期建议，不构成排除发现、不触发确认轮；把确定缺陷降级、以越界为由移出或拒收影响验收的发现，仍须附证据并交下一轮确认。对应 B33。 |
| P2 B02 公共契约验证缺口（三） | 成立。7/7 只证明所测安全场景，未证明调用方适配。 | 新增 B30（公共契约与调用方）及可复用夹具；本轮全链路实测覆盖两个调用方的适配与检查脚本，不只测被改函数。 |
| P0 实测完整 full 链路（六） | 成立。 | 已执行，见 [0.3.1 全链路记录](baseline-0.3.1.md)：无 P0–P2，1 条 P3（403/404 存在性侧信道）按延期建议记录，1 条待验证风险（`request["user_id"]` 上游可信性）。 |
| P0 验证路由误判与边界案例（六） | 部分落实。 | 规则已改，B31（跨五个文件机械改名仍 `quick`）、B32（根因初始未知）已定义；本轮未执行这两条用例，留待下一轮。 |
| 建议新增 B30–B35（五） | 部分采纳。 | B30–B33 已加入 `tests/behavior.md`；B34（不同模型）、B35（不同 Reviewer 配置）需要重复运行与成本统计，本轮未建测量设施，未加入，避免把单次通过当作统计结论。 |
| 成本指标与优化假设（四） | 未实施。 | 未采集成功率、Token、端到端耗时、误路由率、返工率；无计量条件时不宣称成本收益。 |
| 不建议新增路径、Proxy 或适配框架（七） | 接受。 | 本轮未新增路径、实现档位、强制审查角色或 Harness 适配层，只修规则、测试与发布检查。 |

## 本轮验证

- `node scripts/version.mjs check`：全部同步；修复前失败项为 `easydev/README.md is missing 0.2.0`。
- `node --test test/version.test.mjs test/reset.test.mjs`：11/11 通过。
- `git diff --check`、`models.json` 与 `examples/models.cross-provider.json` 解析、Markdown 本地链接检查通过。
- 完整 `full` 链路：夹具 `/tmp/easydev-r1`，`python3 check_orders.py` 为 `PASS: 7/7`；独立审查 r=1/4；结论与证据见 [0.3.1 全链路记录](baseline-0.3.1.md)。

## 未覆盖与限制

- B01–B29 未全量重跑；B31–B33 仅有定义，尚未执行。B34/B35、审查成本对比与 Token 计量未做。
- 全链路实测为单宿主（DeepSeek Harness）、单最小 Python 夹具；审查子代理的实际模型与推理深度未由工具返回，记为未知。
- 版本 0.3.1 随本轮提交发布，未打 tag；安装目录更新需用户自行执行。
