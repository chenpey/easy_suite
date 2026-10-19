# EasyDev

当前版本：`0.3.9`

面向编码 Agent 的纯文件 Skill。它把设计、实施、排障、验证、审查、探针与全仓审计收进一个入口，再按任务风险选择必要流程，不把全部步骤机械套到每次修改上。

EasyDev 不接管宿主，不安装插件，也不替代项目自身的规则、工具或测试。宿主指令、用户要求与适用项目偏好始终优先；Skill 负责流程调度、完成边界和质量证据。

## 目录

[工作原理](#工作原理) · [核心能力](#核心能力) · [安装](#安装) · [使用](#使用) · [模型配置](#模型配置) · [工作区与收尾](#工作区与收尾) · [更新与迁移](#更新与迁移) · [验证](#验证) · [适用范围](#适用范围) · [更新说明](#更新说明) · [目录结构](#目录结构)

## 工作原理

```text
用户请求
   │
   ▼
SKILL.md 选择路径与完成边界
   ├── quick      局部低风险实施、验证与自查
   ├── full       开发、独立审查、有限修复与复审
   ├── design     只交付设计、权衡、契约与验收
   ├── plan       只交付依赖、边界、步骤与验证
   ├── debug      先取证定位，再按授权决定是否修复
   ├── review     只读审查，输出有证据的发现
   ├── spike      最小实验与可行性结论
   └── audit      全仓或指定目录的一次性只读审计
          │
          ▼
按需加载 references/ 中的模块
          │
          ▼
实际改动、验证证据、审查状态与收尾说明
```

核心约束是“最小充分”和“可验证”：只补足完成目标所需的代码、测试与文档，不扩大范围；不能把自查说成独立审查，也不能把模型复述规则当成行为通过。

## 核心能力

### 任务分流

八个路径的选择条件与完成边界以 [SKILL.md 入口与任务分流](SKILL.md#入口与任务分流) 为唯一来源，此处不复制。

路径按任务选择，风险优先于文件数；涉及 [高风险边界](SKILL.md#入口与任务分流) 即使只改一行，也进入 `full`。

### 开发与审查闭环

- `full` 使用独立实例分离开发与审查，最多四轮正式审核；模型升级、换实例和多个审核者不增加轮数。
- 审查发现先核实，再澄清、修复或有依据反驳；P0/P1 与范围内 P2 必须处理，不影响验收的 P3 作为未实施建议记录。
- 没有子代理能力时完成授权内实施与自查，明确报告独立审查受阻，不由同一实例切换口吻冒充独立审核。
- 预算耗尽或关键证据缺失时报告未完成，不以轮数、测试数量或“无重大问题”推导可以发布。

### 工程纪律

- 先记录任务基线和已有改动，保护用户未提交内容；能由已记录提交可靠重建的干净文件复用 Git 基线，其他情况保存原内容。
- 新功能与非平凡行为先构造最小失败测试，确认失败原因是功能缺失，再做最小实现并使测试通过。
- Bug 修复先复现症状，区分代码根因、环境故障与外部依赖；同一问题重复失败时回到假设与证据，不随机试补丁。
- 证据记录实际命令、工作目录、退出状态、关键输出和对应版本；测试通过、构建通过、验收满足与独立审查完成分别判断。

### 交付边界

- `design`、`plan`、`spike`、`review` 和 `audit` 各有独立交付范围，不因流程结束自动进入实现。
- 实验产物不并入产品代码；只读审查与审计不修改代码、索引、快照或外部系统。
- 高风险或易错操作先写清步骤、限制与恢复方式，不用简短表达省略安全信息。

### 表达档位

- 聊天表达内置 `normal`、`lite`、`ultra` 三档。`normal` 默认，`lite` 用于日常状态与局部修复，`ultra` 仅在用户明确要求时启用。`full` 只代表开发—审查闭环，不是档位。
- 规则与完整性边界见 [expression.md](references/expression.md)；档位语法与持续范围见 [入口规则](SKILL.md#入口与任务分流)。本包不提供实现档位。

## 安装

### 推荐：Skills CLI

使用通用安装工具选择目标 harness（即宿主），需要 Node.js/npm。

已下载本仓库时，在仓库根目录执行：

```bash
npx skills add ./easydev --skill easydev
```

按提示选择 harness 和安装方式；默认安装到当前项目，加 `--global` 安装到用户级目录。安装源路径可改为 EasyDev 文件夹的绝对路径；在目标项目目录执行，则安装到该项目。

明确指定一个或多个 harness：

```bash
npx skills add ./easydev --skill easydev --agent codex
npx skills add ./easydev --skill easydev --agent codex claude-code opencode pi cursor
npx skills add ./easydev --skill easydev --agent codex --global
```

第二条命令同时安装到五个 CLI 已支持的 harness。DeepSeek Harness 使用下表的原生目录，或复用该命令创建的 `.agents/skills/easydev/`。

本目录发布到远端 `main` 分支后，也可直接安装：

```bash
npx skills add https://github.com/chenpey/easy_suite/tree/main/easydev --skill easydev
```

### 各 harness 的安装位置

运行时最低文件集是 `SKILL.md`、`references/` 与 `models.json`，复制到目标 harness 的技能目录并保持相对位置；`agents/` 与 `examples/` 是可选扩展，缺少时不影响技能加载，模型按 `models.json` 的 `inherit` 默认值运行。不要复制本地 `.pi/` 与 `tests/`：前者是宿主本地配置，后者是维护与评测材料。使用 CLI 从本地工作区安装后，请检查安装目录；若包含 `.pi/` 或 `tests/`，删除后再使用。

只复制运行时文件的一行命令（在 EasyDev 目录执行，`DEST` 为技能父目录，如 `.agents/skills`，命令会创建 `$DEST/easydev/`）：

```bash
rsync -a --exclude .git --exclude .pi --exclude tests --exclude README.md --exclude CHANGELOG.md ./ "$DEST/easydev/"
```

命令不带 `--delete`：更新版本时，先确认 `$DEST/easydev/` 内没有自建文件，再删除该目录后重新复制，避免残留已移除的旧文件。

下表给出可用于手动复制的默认位置；项目级路径相对于目标项目，`~` 表示用户主目录。Skills CLI 会将支持共享目录的客户端安装到 `.agents/skills`（用户级为 `~/.agents/skills`）；实际位置以安装输出为准。

| Harness | Skills CLI ID | 项目级目录 | 用户级目录 |
| --- | --- | --- | --- |
| Codex | `codex` | `.agents/skills/easydev/` | `~/.agents/skills/easydev/` |
| Claude Code | `claude-code` | `.claude/skills/easydev/` | `~/.claude/skills/easydev/` |
| OpenCode | `opencode` | `.agents/skills/easydev/` | `~/.config/opencode/skills/easydev/` |
| Pi | `pi` | `.agents/skills/easydev/` | `~/.agents/skills/easydev/` |
| DeepSeek Harness | 使用原生目录或共享目录 | `.dsh/skills/easydev/` 或 `.agents/skills/easydev/` | `~/.dsh/skills/easydev/` 或 `~/.agents/skills/easydev/` |
| Cursor | `cursor` | `.agents/skills/easydev/` | `~/.cursor/skills/easydev/` |
| Google Antigravity App / IDE | `antigravity` | `.agents/skills/easydev/` | `~/.gemini/config/skills/easydev/` |
| Google Antigravity CLI | `antigravity-cli` | `.agents/skills/easydev/` | `~/.gemini/antigravity-cli/skills/easydev/` |

CLI 目录映射见 [Skills CLI 官方文档](https://github.com/vercel-labs/skills#supported-agents)；[Pi 官方文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)也明确支持 `.agents/skills`。手动复制只需文件系统操作。安装后按宿主方式刷新技能或开启新会话；Pi 可运行 `/reload`。

**Google Antigravity（AGY）** 的 App/IDE 与 CLI 目录按 [官方 Skills 文档](https://antigravity.google/docs/skills) 区分，项目级均使用 `.agents/skills/`。Skills CLI 的 `antigravity` 用户级映射目前仍为 `~/.gemini/antigravity/skills/`（IDE 兼容的旧位置），见 [CLI 目录映射源码](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)；App 安装优先手动复制到上表目录，CLI 使用 `--agent antigravity-cli`。安装后确认宿主发现 `easydev`，App/CLI 可用 `/easydev` 显式调用；子代理与模型能力仍按 [环境适配](references/setup.md#google-antigravityagy) 核对，安装成功不代表已完成宿主行为验证。

**DeepSeek Harness** 按 [filesystem skill provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill/skill-filesystem) 的默认设置，除上表两个原生目录外还扫描共享目录，因此与 Codex/Pi 共用同一份安装即可：

- 项目级：最近 `.git` 祖先目录下的 `.agents/skills/`；没有 `.git` 时取当前工作目录。
- 用户级：`~/.agents/skills/`。
- 上表里的 `~/.dsh` 与 `~/.agents` 是默认值：设置 `DSH_HOME` 后原生位置变为 `$DSH_HOME/skills/easydev/`，设置 `DSH_AGENTS_HOME` 后共享位置变为 `$DSH_AGENTS_HOME/skills/easydev/`。

自定义部署需在运行配置中加载 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`，以及提供模型调用入口的 [`@deepseek-ai/dsh-tool-skill`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill/tool-skill)。若关闭了默认扫描目录，再把存放技能的父目录加入 `customSkillDirs`。

这些是同一套标准 Skill 文件的安装与加载方式。多代理、模型覆盖及推理深度由各 harness 的实际工具决定，适配与受阻处理见 [环境适配规则](references/setup.md)。

## 使用

在任意 harness 中，可以直接说：

```text
使用 easydev，为登录表单增加邮箱校验，并验证错误提示。
使用 easydev debug，排查保存按钮偶尔重复提交的问题。
使用 easydev review，审查当前改动，先不要修改代码。
使用 easydev spike，快速验证当前方案能否支撑目标并发。
使用 easydev audit，审计 data-service 目录并给出排名问题。
```

也可使用宿主的技能调用入口：Codex 中写 `$easydev review 审查当前改动`，Pi 使用 `/skill:easydev review 审查当前改动`，DeepSeek Harness 使用 `/easydev review 审查当前改动`。某客户端的 `$` 或 `/` 语法按该客户端的约定使用。

路径选择条件与完成边界以 [SKILL.md](SKILL.md#入口与任务分流) 为唯一来源。需要隔离工作区时，按 [工作区与收尾](references/worktree.md) 优先使用宿主原生工具；同时安装其他开发或审查技能时，按 [技能共存规则](SKILL.md#与其他技能共存) 只保留一个流程控制者。

## 模型配置

默认开发和审核都继承宿主模型，可换成任意供应商。复制 [默认配置](models.json)、[跨模型示例](examples/models.cross-provider.json) 或 [Antigravity 示例（flash 开发、pro 审查，以降低 full 成本为目标，效果待成本基线验证）](examples/models.antigravity.json) 到用户配置位置，再修改模型 ID：

- macOS/Linux：`~/.config/easydev/models.json`；设置了 `XDG_CONFIG_HOME` 时使用 `$XDG_CONFIG_HOME/easydev/models.json`。
- Windows：`%APPDATA%/easydev/models.json`；APPDATA 未设置时使用用户主目录下的 `.config/easydev/models.json`。
- 也可在对话中指定一个可访问的配置文件，例如“使用 easydev，模型配置用 `/path/to/my-models.json`”。

字段含义、优先级、校验规则与升级阶段见 [模型配置规则](references/models.md)。配置由代理读取，个人配置应放在安装目录之外，更新 Skill 时保持原样。Skill 只读取模型 ID 与推理深度，密钥留在供应商自己的配置里。

## 工作区与收尾

局部改动可直接在当前工作区完成。需要隔离或任务较长时，优先使用宿主原生工作树工具；没有原生工具时再回退 `git worktree add`，不创建宿主无法追踪的重复工作区。

完成改动后先运行本任务验证，再呈现“本地合并 / 推送并创建 PR / 保留现状”供用户选择。合并、推送和清理都需要明确授权；清理被拒绝时列出未提交内容，绝不擅自使用 `--force` 或丢弃分支。完整规则见 [worktree.md](references/worktree.md)。

## 更新与迁移

本地来源安装：获取新版源码后，重新运行相同的 `skills add` 命令。远端来源安装可按 Skills CLI 的更新流程执行：

```bash
npx skills update easydev
```

更新会替换安装目录内容；个人模型配置放在上述外部路径即可保留。曾直接修改安装目录内 `models.json` 的用户，应先将其迁移到外部位置。手动复制安装时，备份后按安装说明替换运行时文件（仍排除 `.pi/` 与 `tests/`）。

版本变化与具体改动见 [CHANGELOG.md](CHANGELOG.md)。

## 验证

修改流程、角色边界、表达规则或工作区行为后，按 [行为回归用例](tests/behavior.md) 在独立上下文和临时工作区验证。执行者只拿到 Skill 路径、用户请求、原始材料和真实工具约束，不提前获得通过条件；结果记录实际文件、diff、工具调用、命令输出和未验证项。

发布前至少完成：

- `git diff --check`，确认没有空白错误。
- 在仓库根目录运行 `node scripts/version.mjs check`，确认版本文件与各项目发布说明一致（CI 已接入）。
- 解析 `models.json` 与 `examples/` 下全部 `models*.json`。
- 检查 Markdown 本地链接、目录树和新增文件是否一致。
- 仅复制运行时最低文件集（`SKILL.md`、`references/`、`models.json`）后，确认其中没有指向未复制文件的本地链接。
- 对受影响的行为用例实际执行，不用“模型复述规则”代替行为通过。

持续回归当前只接入 B30 固定补丁复验，不会调用真实 Agent，也未覆盖 B01–B28 的持续行为评测。模型或宿主升级后的回归选择与记录要求见 [持续回归覆盖与缺口](tests/behavior.md#持续回归覆盖与缺口)。本轮审计意见的核实、修复及验证见 [审计问题处理记录](tests/results/audit-fixes-0.3.7.md)。

0.2.0 曾记载 B01–B21 已通过，但仓库未保留对应宿主、模型和执行证据，现标为历史结果不可核验，不能作为回归基线。本次核实与验证见 [审查意见处理记录](tests/results/opus-review.md)；后续复审及 B22–B28 验证见 [复审处理记录](tests/results/opus-followup.md)。0.3.0 的规则改动与实测基线见 [0.3.0 行为基线](tests/results/baseline-0.3.0.md)。0.3.1 的规则改动见 [0.3.1 全链路记录](tests/results/baseline-0.3.1.md)：`full` 工作流已执行，但因身份来源可信性未验证，交付状态为“部分完成/待确认”；可复现夹具在 [tests/fixtures/b30](tests/fixtures/b30/)。0.3.2 新增 B29a/B29b/B31/B32 实测，见 [路由与负向激活记录](tests/results/routing-0.3.2.md)。0.3.3 加固 B30 红阶段与独立验收，并补跑 B33（真实零发现收敛 + P3 决策回放），见 [B33 收敛记录](tests/results/b33-convergence-0.3.3.md)。各轮 review 的逐条处理见 [第二轮](tests/results/chatgpt-review-0.3.0.md)、[第三轮](tests/results/chatgpt-review-0.3.1.md)、[第四轮](tests/results/chatgpt-review-0.3.2.md)、[第五轮](tests/results/chatgpt-review-0.3.3.md) 与 [Gemini review](tests/results/gemini-review-0.3.4.md)。成本与质量对照、真实 P3-only 审查、B32 的 full 对照、原生工作树及其他宿主兼容性仍需实测。

## 适用范围

- 适合需要统一设计、实施、验证与审查口径的编码 Agent。
- 不提供模型、密钥、网络、沙箱、子代理或工作树能力；这些均由宿主和实际配置决定。
- 没有独立子代理时仍可完成实施与自查，但不能宣称 `full` 闭环完成。
- 行为回归验证的是 Skill 的行为边界，不证明每个宿主都已正确加载，也不替代项目自身的测试、构建、迁移或发布检查。
- 用户明确选择其他流程时遵从该选择；EasyDev 不与其他开发闭环并行运行。

## 更新说明

`0.3.9`（2026-10-19）：B30 缺失身份检查改为限定允许的结果形状，拦截变形后的嵌套订单字段；新增 `transformed-leak` 负向变体，负向伪修复共八类。复现与验证见 [audit-fixes-0.3.7.md](tests/results/audit-fixes-0.3.7.md)。

`0.3.8`（2026-10-19）：B30 独立验收增加固定/动态订单归属变更与标量泄露检查，夹具提交禁用签名；统一最小安装与可选示例的引用规则。审计复现与验证见 [audit-fixes-0.3.7.md](tests/results/audit-fixes-0.3.7.md)。

`0.3.7`（2026-10-19）：B30 独立验收扩到 23 条并增加五类负向伪修复；审查反馈纪律迁入 execution；修正 Antigravity 升级审查模型与模型契约；移除本地凭证写白名单。审查记录见 [gemini-review-0.3.6.md](tests/results/gemini-review-0.3.6.md)。

`0.3.6`（2026-10-19）：新增 Antigravity 模型配置示例与只复制运行时文件的安装命令；补充最小成本回归集合与成本基线记录要求；修复安装副本中的文档链接，发布前检查覆盖全部示例配置。审计记录见 [audit-fixes-0.3.6.md](tests/results/audit-fixes-0.3.6.md)。

`0.3.5`（2026-10-19）：补充 Antigravity App/IDE 与 CLI 安装和适配说明；description 增加英文能力与排除边界；整理历史证据引用；明确持续 Agent 行为回归缺口及升级后的优先回归集合。流程正文不变，宿主行为与英文激活效果仍待实测。

`0.3.4`（2026-10-19）：B30 独立验收补充缺失/空身份断言与伪修复回归；B30 任务提示声明 `request["user_id"]`、`PermissionError` 与 403/404 契约；安装说明排除本地 `.pi/` 与 `tests/`。

`0.3.3`（2026-10-19）：B30 红阶段校验失败原因并增加接口探针；新增独立验收脚本与夹具用途说明；新增 EasyDev 夹具 CI；补跑 B33（真实零发现收敛与 P3 决策回放）。

`0.3.2`（2026-10-19）：更正 0.3.1 `full` 实验的交付状态为“部分完成/待确认”；B30 改为可复现夹具并收紧调用方验收条件；新增 B29a/B29b/B31/B32 实测。

`0.3.1`（2026-10-19）：分流改按最小必要调查后的实际影响判定；明确用户限定流程与高风险边界的优先级；区分低影响 P3 延期与实质缺陷争议；B29 拆分为 B29a/B29b，新增 B30–B33；修复版本漂移并增加版本一致性 CI。

`0.3.0`（2026-10-19）：删除实现档位（破坏性，路径后的 `lite`/`ultra` 不再改变实现取舍）；`full` 触发条件改为影响面、契约与不确定性；路径表与档位定义合并到唯一来源；新增 B29 与本次实测基线。

`0.2.1`（2026-10-19）：修复路由与独立审查边界，区分 quick/full 尝试预算，统一档位持续规则，并补充可追溯验证记录。

`0.2.0`（2026-10-19）：新增 `spike` 与 `audit` 路径；聊天表达统一为 `normal`/`lite`/`ultra` 三档；补齐根因排障、TDD 红绿证据、审查反馈核实、可交接计划、工作区收尾、技能共存与 B01–B21 行为回归；修正 DeepSeek 安装路径并移除重复模型示例。

- 完整版本历史：[`CHANGELOG.md`](CHANGELOG.md)
- 流程入口与完成边界：[`SKILL.md`](SKILL.md)
- 模型配置：[`references/models.md`](references/models.md)
- 行为回归：[`tests/behavior.md`](tests/behavior.md)

## 目录结构

```text
easydev/
├── README.md
├── CHANGELOG.md
├── SKILL.md
├── models.json
├── examples/models.cross-provider.json
├── examples/models.antigravity.json
├── agents/openai.yaml
├── tests/behavior.md
├── tests/results/opus-review.md
├── tests/results/opus-followup.md
├── tests/results/opus-followup-evidence.md
├── tests/results/baseline-0.3.0.md
├── tests/results/baseline-0.3.1.md
├── tests/results/routing-0.3.2.md
├── tests/results/b33-convergence-0.3.3.md
├── tests/results/chatgpt-review-0.3.0.md
├── tests/results/chatgpt-review-0.3.1.md
├── tests/results/chatgpt-review-0.3.2.md
├── tests/results/chatgpt-review-0.3.3.md
├── tests/results/gemini-review-0.3.4.md
├── tests/results/audit-fixes-0.3.4.md
├── tests/results/audit-fixes-0.3.6.md
├── tests/results/gemini-review-0.3.6.md
├── tests/results/audit-fixes-0.3.7.md
├── tests/fixtures/b30/
│   ├── README.md
│   ├── run.sh
│   ├── acceptance.py
│   ├── initial/
│   ├── solution.patch
│   └── reviewer-report.md
└── references/
    ├── planning.md
    ├── execution.md
    ├── debugging.md
    ├── orchestration.md
    ├── review.md
    ├── expression.md
    ├── models.md
    ├── setup.md
    └── worktree.md
```

`agents/openai.yaml` 是 Codex 的可选展示元数据，`examples/` 是可选模型示例；运行时最低文件集见[各 harness 的安装位置](#各-harness-的安装位置)。

流程方法参考 [Superpowers](https://github.com/obra/superpowers)；最小完整实现、测试驱动、根因排障、审查反馈与工作计划规则已内置于 `references/`，运行时不依赖其他技能包。
