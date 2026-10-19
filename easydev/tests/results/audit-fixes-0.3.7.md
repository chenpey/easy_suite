# GPT 审计（0.3.7）核实与修复记录

日期：2026-10-19
范围：EasyDev `4dca389`（0.3.7）及本轮未提交修复。审计报告由 GPT 提供；本轮由当前实例逐条复现、修复并验证。

## 结论

审计列出的 4 项确定发现（3 项 P2、1 项 P3）全部成立，已修复并加入回归检查。未发现运行时绑定作者本机路径、密钥或特定模型的硬编码。

## 确定发现与处理

| ID | 级别 | 发现 | 复现 | 处理 |
| --- | --- | --- | --- | --- |
| F-01 | P2 | 独立验收只检查固定订单与用户，硬编码 `{"o1": "u1", "o2": "u2"}` 仍通过 | 固定映射实现输出 `PASS: 23/23`；把 `o1` 实际所有者改为 `u3` 后，`u1` 仍可读取 | `acceptance.py` 运行时生成唯一订单与用户，检查本人可读、他人被拒、接口 200/403、admin 导出；随后分别改动动态订单和 `o1`/`o2` 的实际所有者，复查旧所有者被拒、新所有者可读，以同时拦截纯固定映射与“固定映射 + 动态回退”的混合实现；`run.sh` 增加 `hardcoded-owner-map` 负向变体 |
| F-02 | P2 | `contains_order()` 不识别直接返回的标量，缺失身份返回订单金额仍通过 | 缺失身份返回 `120`、接口返回 `{"status": 200, "order": 120}`，旧脚本仍输出 `PASS: 23/23` | 缺失身份检查改为限定结果形状：只允许报错、`None`、空容器，或仅含 4xx `status` 与 `error`/`message`/`detail`/`code` 文本的字典；`order` 仅允许为空。这样可同时拦截精确标量、变形嵌套字段与任意非空订单容器；`contains_order()` 保留为已知字段值的二次检查，并先判类型避免不可哈希字段导致崩溃。`run.sh` 增加 `scalar-leak` 与 `transformed-leak` 负向变体，要求六个缺失/空身份标签全部命中 |
| F-03 | P2 | 夹具提交继承全局 Git 签名配置 | 模拟 `commit.gpgsign=true` 且签名程序不可用，`run.sh` 在测试开始前退出 `128`，报 `gpg failed to sign` | 夹具提交改为 `git -c commit.gpgsign=false commit`；在相同签名环境下复跑通过 |
| F-04 | P3 | 最小安装缺少 `examples/` 时，运行时文档引用失效 | 只复制 `SKILL.md`、`references/`、`models.json` 后，`references/setup.md` 的 `../examples/models.antigravity.json` 不存在 | README 明确最低文件集与可选扩展；`setup.md` 改用仓库绝对链接，并说明缺少 `examples/` 时回退 `models.json` 的 `inherit` 默认值 |

## 硬编码与安装结论复核

- `models.json` 的 developer/reviewer 均为 `inherit`，`upgrades` 为空；具体模型名只出现在可选示例 `examples/models.*.json`。
- 历史 `/tmp/...` 路径只存在于评测记录与审查原文，不参与运行时绑定。
- Skills CLI 当前安装源码的目录排除项为 `.git`、`__pycache__`、`__pypackages__`，未过滤 `.pi/` 与 `tests/`；从本地工作区安装后仍需按 README 检查并清理。官方源码：<https://github.com/vercel-labs/skills/blob/main/src/installer.ts>。

## 验证

- 修复前基线：`bash tests/fixtures/b30/run.sh` 退出 0，独立验收 `PASS: 23/23`。
- 修复后：`bash tests/fixtures/b30/run.sh` 退出 0；红阶段 3 条 `TypeError`、绿阶段 `PASS: 7/7` 与 `PASS: 38/38`；八类负向变体全部被拒绝，未生成 `__pycache__`/`.pyc`。
- 签名环境复跑：`HOME=<临时目录> GIT_CONFIG_NOSYSTEM=1 bash tests/fixtures/b30/run.sh` 退出 0，八类负向通过。
- 最小安装模拟：仅复制 `SKILL.md`、`references/`、`models.json` 后，本地 Markdown 链接全部可解析。
- `node ../scripts/version.mjs check` 通过；3 份模型 JSON、SKILL.md/agents YAML、全部 Python 与 run.sh 语法通过。
- Markdown 本地链接 144 条、标题锚点 36 条均可解析；`git diff --check` 通过；B30 连续复跑 3 次均为 `PASS: 38/38`。

## 追加发现（0.3.9）：变形嵌套字段仍可泄露

0.3.8 推送后，用“缺失身份返回 `{"status": 200, "order": {"total": 121}}`”的实现复测，旧验收仍输出 `PASS: 38/38`。原因是缺失身份检查只匹配已知订单字段值，变形后的嵌套值不在集合中。

修复改为限定缺失身份允许的结果形状（见 F-02），并新增 `transformed-leak` 负向变体。复测：该伪实现退出 1；固定补丁、返回 `{"status": 403, "error": "missing identity"}`、返回 `{"status": 404, "order": None}` 三种正确/可接受实现仍为 `PASS: 38/38`。

## 独立审查

本轮尝试独立审查实例复核最终 diff，但实例未在合理时间内返回报告，故独立审查未完成。上述复现与验证均为实现者自查，不构成 `full` 闭环；后续可对已提交 diff 单独送审。

## 限制

- 未运行真实多宿主安装、`npx skills add` 或完整 Agent 行为回归，不能据此保证所有宿主兼容。
- F-01/F-02 影响评测可信度，不代表 Skill 自身存在订单业务漏洞。
