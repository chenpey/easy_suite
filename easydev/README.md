# EasyDev

当前版本：`0.1.0`

一个 Skill 入口完成设计、编码、排障、验证和独立审查。简单修改直接处理，复杂任务按需进入开发、审查、修复闭环。

EasyDev 是纯文件的 Agent Skill，优先级为：用户显式要求 > 会话中已加载的同类技能 > 内置规则。

## 安装

### 推荐：Skills CLI

与 [Ponytail 的 Skills CLI 安装方式](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md#skills-cli) 相同，使用通用安装工具选择目标 harness（即宿主），需要 Node.js/npm。

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
| DeepSeek Harness | 使用原生目录或共享目录 | `.dsh/skills/easydev/.agents/skills/easydev/` | `~/.dsh/skills/easydev/~/.agents/skills/easydev/` |
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
```

也可使用宿主的技能调用入口：Codex 中写 `$easydev review 审查当前改动`，Pi 使用 `/skill:easydev review 审查当前改动`，DeepSeek Harness 使用 `/easydev review 审查当前改动`。后两者的入口分别见上述 Pi 文档与 DeepSeek Harness tool-skill 文档；某客户端的 `$` 或 `/` 语法按该客户端的约定使用。

| 路径             | 作用                                   |
| ---------------- | -------------------------------------- |
| `auto`（默认） | 根据任务风险选择必要流程               |
| `quick`        | 局部低风险修改，实施、验证与自查       |
| `full`         | 开发、独立审查、修复与复审             |
| `design`       | 只交付方案和权衡                       |
| `plan`         | 只交付实施顺序、边界和验收方式         |
| `debug`        | 先定位根因，再按授权修复               |
| `review`       | 只读审查，列出有证据的缺陷与待验证风险 |

完整闭环最多四轮正式审核；模型升级、更换代理沿用同一预算，子代理在同一闭环内继续推进。宿主无法委派独立代理时，仍完成实施和自查，并如实报告独立审查受阻。

路径后可附加实现档位 `lite`（更省的最小方案）或 `ultra`（先质疑需求），默认按 [执行与验证](references/execution.md) 的取用顺序实现。聊天表达可在简洁与完整之间切换，适用条件见 [聊天表达](references/expression.md)。

## 自定义模型

默认开发和审核都继承宿主模型，可换成任意供应商。复制 [默认配置](models.json) 或 [跨模型示例](examples/models.cross-provider.json) 到你的用户配置位置，再修改模型 ID：

- macOS/Linux：`~/.config/easydev/models.json`；设置了 `XDG_CONFIG_HOME` 时使用 `$XDG_CONFIG_HOME/easydev/models.json`。
- Windows：`%APPDATA%/easydev/models.json`；APPDATA 未设置时使用用户主目录下的 `.config/easydev/models.json`。
- 也可在对话中指定一个可访问的配置文件，例如“使用 easydev，模型配置用 `/path/to/my-models.json`”。

```json
{
  "developer": { "model": "inherit", "reasoning_effort": "inherit" },
  "reviewer": { "model": "inherit", "reasoning_effort": "inherit" },
  "upgrades": []
}
```

`developer` 设置开发/修复角色，`reviewer` 设置独立审核角色；`upgrades` 最多包含两组后续开发/审核配置。`inherit` 表示沿用宿主设置；模型 ID 和推理深度按目标 harness 支持的能力填写。当前主对话的模型在客户端里选择。

优先级为：当前对话明确指定的角色设置，其次是所选配置文件。文件选择顺序为：对话指定路径、用户配置、包内默认配置；只读取一份完整文件（字段不合并）。所选配置无效或不可读时报告问题。详细字段见 [模型配置规则](references/models.md)。

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
└── references/
    ├── planning.md
    ├── execution.md
    ├── debugging.md
    ├── orchestration.md
    ├── review.md
    ├── expression.md
    ├── models.md
    └── setup.md
```

`agents/openai.yaml` 是 Codex 的可选展示元数据，其余文件构成通用 Skill 内容。

设计参考 [Superpowers](https://github.com/obra/superpowers) 的流程方法、[Ponytail](https://github.com/DietrichGebert/ponytail) 的最小完整实现原则，以及 Caveman 的简洁表达原则；后两者的规则已内置于 [execution.md](references/execution.md) 与 [expression.md](references/expression.md)，运行时不依赖另行安装。
