# EasyDev

当前版本：`0.2.0`

一个 Skill 入口完成设计、编码、排障、验证和独立审查。简单修改直接处理，复杂任务按需进入开发、审查、修复闭环。

EasyDev 是纯文件的 Agent Skill。宿主指令、用户要求与适用项目偏好优先；最小实现与聊天表达使用内置规则，不依赖另行安装的外部技能。流程调度与共存边界见 [SKILL.md](SKILL.md#与其他技能共存)。

## 安装

### 推荐：Skills CLI

使用通用安装工具选择目标 harness（即宿主），需要 Node.js/npm。

已下载本仓库时，在仓库根目录执行：

```bash
npx skills add ./easydev --skill easydev
```

按提示选择需要的 harness 和安装方式；默认安装到当前项目，加 `--global` 安装到用户级目录。安装源路径可改为你的 EasyDev 文件夹绝对路径；在目标项目目录执行，安装到该项目。

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

### 六个 harness 的安装位置

将整个 `easydev` 文件夹复制到目标 harness 的技能目录，保持 `SKILL.md`、`references/`、`models.json` 等文件的相对位置。

下表给出可用于手动复制的默认位置；项目级路径相对于目标项目，`~` 表示用户主目录。Skills CLI 会将支持共享目录的客户端安装到 `.agents/skills`（用户级为 `~/.agents/skills`）；实际位置以安装输出为准。

| Harness          | Skills CLI ID          | 项目级目录                                      | 用户级目录                                          |
| ---------------- | ---------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Codex            | `codex`              | `.agents/skills/easydev/`                     | `~/.agents/skills/easydev/`                       |
| Claude Code      | `claude-code`        | `.claude/skills/easydev/`                     | `~/.claude/skills/easydev/`                       |
| OpenCode         | `opencode`           | `.agents/skills/easydev/`                     | `~/.config/opencode/skills/easydev/`              |
| Pi               | `pi`                 | `.agents/skills/easydev/`                     | `~/.agents/skills/easydev/`                       |
| DeepSeek Harness | 使用原生目录或共享目录 | `.dsh/skills/easydev/` 或 `.agents/skills/easydev/` | `~/.dsh/skills/easydev/` 或 `~/.agents/skills/easydev/` |
| Cursor           | `cursor`             | `.agents/skills/easydev/`                     | `~/.cursor/skills/easydev/`                       |

CLI 目录映射见 [Skills CLI 官方文档](https://github.com/vercel-labs/skills#supported-agents)；[Pi 官方文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)也明确支持 `.agents/skills`。手动复制只需文件系统操作。安装后按宿主方式刷新技能或开启新会话；Pi 可运行 `/reload`。

**DeepSeek Harness：**其 [filesystem skill provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill/skill-filesystem) 默认还扫描项目 `.agents/skills/` 和用户 `~/.agents/skills/`，所以与 Codex/Pi 共用一份安装即可。自定义 `DSH_HOME` 时，原生用户级位置改为 `$DSH_HOME/skills/easydev/`；自定义 `DSH_AGENTS_HOME` 时，共享用户级位置改为 `$DSH_AGENTS_HOME/skills/easydev/`。项目目录取最近的 `.git` 祖先，缺少该标记时使用当前目录。

DeepSeek Harness 的运行配置需加载 `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem` 和用于模型调用的 [`@deepseek-ai/dsh-tool-skill`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill/tool-skill)。自定义部署关闭默认扫描目录时，把技能父目录加入其 `customSkillDirs`。

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

也可使用宿主的技能调用入口：Codex 中写 `$easydev review 审查当前改动`，Pi 使用 `/skill:easydev review 审查当前改动`，DeepSeek Harness 使用 `/easydev review 审查当前改动`。后两者的入口分别见上述 Pi 文档与 DeepSeek Harness tool-skill 文档；某客户端的 `$` 或 `/` 语法按该客户端的约定使用。

路径分流（`auto`/`quick`/`full`/`design`/`plan`/`debug`/`review`/`spike`/`audit`）的选择条件与完成边界、实现档位 `lite`/`ultra`、审核预算与收敛规则，全部以 [SKILL.md](SKILL.md) 及其按需加载的模块为唯一来源，本文件不再复述。

同时安装 Superpowers、旧 dev-review-loop 或独立审查技能时的分流、优先级与冲突处理见 [SKILL.md 的“与其他技能共存”](SKILL.md#与其他技能共存)。

## 自定义模型

默认开发和审核都继承宿主模型，可换成任意供应商。复制 [默认配置](models.json) 或 [跨模型示例](examples/models.cross-provider.json) 到你的用户配置位置，再修改模型 ID：

- macOS/Linux：`~/.config/easydev/models.json`；设置了 `XDG_CONFIG_HOME` 时使用 `$XDG_CONFIG_HOME/easydev/models.json`。
- Windows：`%APPDATA%/easydev/models.json`；APPDATA 未设置时使用用户主目录下的 `.config/easydev/models.json`。
- 也可在对话中指定一个可访问的配置文件，例如“使用 easydev，模型配置用 `/path/to/my-models.json`”。

字段含义、优先级、校验规则与示例见 [模型配置规则](references/models.md)，这里不复述。

配置由代理读取，**个人配置放在安装目录之外，更新 Skill 时保持原样。**多个 harness 可以共用它，也可在各自对话中指定不同文件。Skill 只读取模型 ID 与推理深度，密钥留在你自己的供应商配置里。

## 更新与迁移

本地来源安装：获取新版源码后，重新运行相同的 `skills add` 命令。远端来源安装可按 Skills CLI 的更新流程执行：

```bash
npx skills update easydev
```

更新会替换安装目录内容；个人模型配置放在上述外部路径，曾直接改过安装目录内 `models.json` 的话先把它迁移出去。手动复制安装的用户，备份后替换整个文件夹即可。

## 目录

```text
easydev/
├── README.md
├── SKILL.md
├── models.json
├── examples/models.cross-provider.json
├── agents/openai.yaml
├── tests/behavior.md
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

`agents/openai.yaml` 是 Codex 的可选展示元数据，其余文件构成通用 Skill 内容。

设计参考 [Superpowers](https://github.com/obra/superpowers) 的流程方法；最小完整实现与测试驱动原则已内置于 [execution.md](references/execution.md)，工作区隔离与分支收尾见 [worktree.md](references/worktree.md)，聊天表达内置 `normal`/`lite`/`ultra` 三档，运行时不依赖另行安装。

## 维护验证

修改流程、角色边界或表达规则后，按 [行为回归用例](tests/behavior.md) 选择受影响场景，在独立上下文和临时工作区验证。用例覆盖分流、授权、证据、恢复和技能共存；记录实际产物与动作，不以“模型复述了规则”代替行为通过。链接、配置与 Skill 格式检查只证明结构有效，不能替代行为验证。
