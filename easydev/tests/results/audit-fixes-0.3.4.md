# v0.3.4 审计问题处理记录

- 日期：2026-10-19。
- 基线：`dbf7a65bd80e8748260fdd916fdc6e1f44ad0319`；开始时整个 Git 工作区无 staged、unstaged 或 untracked 内容。
- 范围：用户提供报告中的三条发现及一条待验证风险；`easydev auto → quick`，仅文档、引用与发现元数据，无执行流程或夹具逻辑改动。
- 初次核实时，本记录对应上述基线上的未提交改动，未发布新版本；后续 0.3.5 提交收尾见文末。未修改已安装的 Skill 副本。

## 核实与处理

| 报告项 | 核实结果 | 处理 |
| --- | --- | --- |
| P2：历史输出含本机路径与错误相对引用 | 成立；共 5 处仓库绝对引用、1 处错误相对引用，另有 1 处临时产物链接。它们位于代码围栏内，是历史输出文本，不是页面实际可点击链接；其路径不可移植问题仍成立 | 仓库引用统一为 `../../references/…`；临时产物路径保留为普通文本；在原记录声明路径经过整理，不伪称逐字原文或重新执行 |
| P3：缺少 Antigravity 说明 | 文档缺项成立；报告建议的项目级 `.gemini/skills/` 与当前官方文档不符 | README 区分 App/IDE 与 CLI 的安装目录、Skills CLI ID 和旧目录映射；setup 说明 `/easydev`、`invoke_subagent` 及能力核对 |
| P3：中文 description 可能影响英文激活 | “纯中文”不完全准确，原描述已有 `coding`、`Bug` 等英文；未提供激活退化实测，因此不认定为已证实行为缺陷 | 按用户建议补充简短英文能力与排除边界；使用 YAML 折叠标量容纳英文冒号，保持 Skill 正文及路由规则不变 |
| 待验证：历史行为用例缺少持续回归 | 持续行为覆盖缺口成立，但未证实发生模型行为漂移；B30 CI 也是固定补丁复验，不调用 Agent | README 与 behavior 明示覆盖边界、升级后优先回归集合及真实验收要求；未新增 Agent runner，风险保持未关闭，不把文档补充称为自动化修复 |

Antigravity 依据：[官方 Skills 文档](https://antigravity.google/docs/skills)、[官方 Subagents 文档](https://antigravity.google/docs/subagents)、[Skills CLI 映射源码](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)（2026-10-19 核对）。项目级统一为 `.agents/skills/`；App/IDE 用户级为 `~/.gemini/config/skills/`，CLI 为 `~/.gemini/antigravity-cli/skills/`。安装和 API 文档核实不等于宿主运行验收。

## 实际验证

执行目录未特别说明时为 EasyDev 项目目录；父仓库指其上一级 `easy_suite`。

| 检查 | 结果与证据 |
| --- | --- |
| 修复前历史引用检查（Python 标准库，含围栏内引用） | 退出 1：`Pre-fix: 7 portability/link errors`；5 个 `/Users/…` 目标、1 个 `/tmp/…` 目标及 `references/orchestration.md` 的错误相对目标 |
| 修复后同范围检查 | 退出 0：`Post-fix: 6 references, 0 portability/link errors`；额外断言原记录不含 `/Users/` 通过 |
| 父仓库：`node scripts/version.mjs check` | 退出 0：`All project versions are synchronized.` |
| 父仓库：`node --test test/*.test.mjs` | 退出 0：11 项通过，0 失败；此处是维护脚本测试，不是 Skill 的行为套件 |
| `bash tests/fixtures/b30/run.sh` | 退出 0：初始探针 200；红阶段恰好 3 个目标契约 `TypeError`；应用补丁后探针 403、7/7 调用方检查、12/12 独立验收；省略身份变体产生恰好 3 条预期失败并被拒绝 |
| skill-creator `quick_validate.py` | 系统及 bundled Python 均因缺少 `yaml`（PyYAML）在导入阶段退出 1；这是工具环境限制，不宣称该校验器通过 |
| Ruby 标准库 Psych：`YAML.safe_load` 解析 frontmatter 并断言元数据约束 | 退出 0：description 为 308 字符字符串、name 与允许字段有效；对比 HEAD 确认 Skill 正文逐字不变。这是替代静态验证，不等同于运行原 Python 校验器 |
| Python 标准库解析两个模型 JSON | 退出 0：`PASS: 2 model JSON files parsed` |
| Python 标准库 Markdown 轻量扫描 | 退出 0：29 个 Markdown 文件、131 个本地行内引用、33 个标题锚点，0 错误。范围为围栏外正文，另包含本次整理的 Opus 输出围栏；其他示例代码排除，不是完整 CommonMark 渲染器，不证明外网链接可访问 |
| `git diff --check` | 退出 0；无空白错误 |

历史引用检查可在项目目录复现：

```bash
python3 - <<'PY'
from pathlib import Path
import re
p = Path('tests/results/opus-followup-evidence.md')
s = p.read_text()
links = list(re.finditer(r'\[[^\]\n]+\]\(([^)]+)\)', s))
errors = [m[1] for m in links
          if m[1].startswith('/') or not (p.parent / m[1]).exists()]
print(f'Post-fix: {len(links)} references, {len(errors)} portability/link errors')
assert not errors, errors
assert '/Users/' not in s
PY
```

## 完成边界

初次实现为 quick 自查，随后完成下述独立复审；未实测 Antigravity 安装/委派、英文自动激活率或 B01–B28 的持续 Agent 回归。三项局部改进已实施；持续行为回归套件仍未建立，不能据此宣称报告中的所有风险均已消除。

## 独立复审与 0.3.5 提交收尾

- 独立 reviewer：`01a153d1-2698-7582-8de9-0adfd83ab35e`，不同实例、不继承完整会话；请求模型与推理深度均为 inherit，工具未返回实际值，记为未知。
- 范围：基线上的完整 6 文件变更，包含本记录。逐块核对 10 段历史输出，仅有已声明的路径整理及相邻空格调整；6 个相对引用可解析，YAML 解析通过，Skill 正文与基线逐字一致。结论：本次范围内未发现确定缺陷。
- 主代理再次核对官方 Skills、Subagents 文档及 Skills CLI 目录映射源码，与当前说明一致；不等于宿主实测。
- 用户随后授权按 0.3.5 提交。通过父仓库 `node scripts/version.mjs bump easydev patch` 同步版本源、项目版本行及根目录版本表，补充 CHANGELOG 和 README 更新说明。此前独立复审覆盖 6 文件实现，后续版本与记录收尾为主代理自查，不虚称已对提交最终快照再做独立复审。
- 提交前验证：沿用未受影响的 Node 11/11 与 B30 固定补丁复验证据。收尾后重新运行版本一致性与 0.3.5 发布说明提取（退出 0）；Markdown 轻量扫描为 29 文件、132 个本地引用、33 个标题锚点、0 错误（退出 0）；Ruby YAML 元数据及正文不变断言、模型与版本 JSON 解析、`git diff --check` 均退出 0。
