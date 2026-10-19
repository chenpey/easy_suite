# Gemini 4 审查（0.3.6）核实与修复记录

日期：2026-10-19
范围：EasyDev HEAD `fcb7e5f`（0.3.6）及后续未提交修复。审查报告由 Gemini 4 提供；本轮由当前实例逐条核实、复现与修复。

## 结论

5 项确定发现均成立，已修复并验证；3 项待验证风险中，1 项仍未解决，1 项已在文档中补充宿主约束，1 项未做 `npx` 实测。

## 确定发现与处理

| ID | 级别 | 发现 | 核实 | 处理 |
| --- | --- | --- | --- | --- |
| F-01 | P2 | `acceptance.py` 存在 admin 角色混淆、硬编码 `u1`、None/空身份、缺失导出角色等盲区 | 构造 admin-as-user_id、hardcoded-u1、missing-role-export 三类实现，旧脚本均输出 `PASS: 12/12` | 扩到 23 条断言；覆盖第二用户、跨订单越权、`user_id="admin"`、None/空身份、缺失/空导出角色、缺失 `request` 身份不返回订单（缺失键允许报错）；`run.sh` 增加五类负向变体并要求命中对应失败标签 |
| F-02 | P2 | “处理审查反馈”只在 `orchestration.md`，被委派 developer 与 quick/B19 不加载该模块 | 静态核对加载路径：developer 只读 execution，quick/B19 不进入 full | 规则迁入 [execution.md](../../references/execution.md#处理审查反馈)；orchestration 保留主代理核实/作者争议规则并改为引用；SKILL.md 加载表补“审查反馈” |
| F-03 | P3 | Antigravity 示例升级阶段 reviewer 从 `pro` 降为 `inherit`；models.md 的 inherit/模型 ID 契约与 AGY 枚举不一致 | 示例与模型文档逐项对照；AGY 接口接受 `inherit/flash_lite/flash/pro` | 示例 `upgrades[0].reviewer.model` 改为 `pro`；models.md 区分“接口枚举值”与“模型 ID/层级”；setup.md 补充宿主指令可能要求默认 inherit 的约束 |
| F-04 | P3 | `acceptance.py`/`run.sh` 可能在被测工作区生成 `__pycache__` | 标准 Python 会在被测目录写字节码；本机 Python 使用缓存前缀，未在 `app/` 下复现 | `acceptance.py` 设置 `sys.dont_write_bytecode = True`；`run.sh` 使用 `python3 -B`、`PYTHONDONTWRITEBYTECODE=1`，结束前检查无 `__pycache__`/`.pyc` |
| F-05 | P3 | 本地 `.pi/sandbox.json` 将 `~/.dsh/.env` 加入 `allowWrite` | 配置原文确认 | 移除该写白名单，`allowWrite` 置空；该文件被父仓库忽略，不纳入 Git |

## 验证

- `bash tests/fixtures/b30/run.sh`：退出 0；红阶段 3 条 `TypeError`；绿阶段 `PASS: 7/7` 与 `PASS: 23/23`；五类负向变体均非零退出并命中预期标签；未生成 `__pycache__`/`.pyc`。
- `node scripts/version.mjs check`：通过（版本仍为 0.3.6，本轮未发布）。
- 全部模型 JSON 与 `.pi/sandbox.json` 解析通过；仓库内本地 Markdown 链接检查通过。
- 未执行 B19、B01/B02 等真实宿主行为用例；未实际调用 Antigravity `invoke_subagent`。

## 待验证风险

1. 持续自动化 Agent 行为回归与成本基线仍未建立（潜在 P1），本轮未新增真实宿主执行。
2. Antigravity 配置文件能否覆盖宿主“默认 inherit”指令仍未实测；setup.md 已补充约束，需在真实宿主核对 `invoke_subagent` 实际参数。
3. `npx skills add` 对本地 `.pi/`、`tests/` 的复制过滤仍未实测；README 的安装后检查要求保留。

## 限制

- 本轮只做静态检查、夹具复现与临时目录安装模拟，不构成多宿主行为验收。
- 上述修复随 0.3.7 发布；发布后需重新安装本地共享技能目录。
