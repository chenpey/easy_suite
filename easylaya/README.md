# EasyLaya

当前版本：`0.1.0`

[EasyLaya Latest 下载](https://github.com/chenpey/easy_suite/releases/tag/easylaya-v0.1.0)

EasyLaya 是为 **Codex** 与 **Antigravity** 打造的极简 **本地 System 1 快速决策引擎** 集成工具。

基于开源项目 [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)（Apache 2.0 协议），通过标准 MCP (Model Context Protocol) 协议，将经过 RLCD 强化学习训练的 ModernBERT / mmBERT 决策模型直接运行在本地。单前向传递延迟低至 **~33ms**，无需自回归文本生成，零幻觉、零云端 Token 费用、零数据外发。在代码门禁、安全审查、数据分类打标和上下文初筛等高频判断场景下，大幅降低主模型的 Token 消耗与响应延迟。

---

## 特性亮点

* **三大主流平台原生支持**：提供 macOS ARM64 (Apple Silicon)、Linux x64、Windows x64 独立可执行程序。
* **100% 本地自托管**：**无需配置任何 API Token**，零外部云端依赖，零调用费用。
* **全自动隐藏安装**：运行 `--setup` 时自动创建并安装至 `~/.easylaya/` 隐藏目录，运行后下载的临时文件可直接删除。
* **极速确定性决策**：单前向传递仅需 ~33ms，直接输出分类选项（`choice`）、置信度与布尔判断（`noul`），无文本生成等待。
* **原生 MCP 支持**：无缝对接 Codex CLI、Codex Desktop 与 Antigravity。

---

## 快速配置

> [!TIP]
> **全自动安装与隐藏（无需手动创建任何目录）**：
> 运行 `./easylaya --setup` 时，程序会**自动在用户 Home 目录下创建隐藏目录 `~/.easylaya/`**，并将自身安装至该目录中：
> - 服务程序本体：`~/.easylaya/easylaya`（Windows 为 `~/.easylaya/easylaya.exe`）
> - 本地配置文件：`~/.easylaya/config.json`
> - Codex 会自动注册该隐藏路径。
> - **运行 `--setup` 完成后，当前下载的临时文件可以随时删除**，服务将长久稳定运行，绝不污染个人主目录。

### 方式 1：直接下载 Release 独立文件（最简，推荐）

根据操作系统下载对应的独立可执行程序（无需配置 Python 环境）：

* **macOS (Apple Silicon ARM64)**: `easylaya-darwin-arm64`
* **Linux (x64)**: `easylaya-linux-x64`
* **Windows (x64)**: `easylaya-windows-x64.zip`

```bash
# 1. 赋予执行权限 (macOS / Linux)
chmod +x easylaya-darwin-arm64

# 2. 运行交互式引导（自动完成安装并隐藏至 ~/.easylaya/，预热模型）
./easylaya-darwin-arm64 --setup

# 3. （可选）删除当前下载的安装文件，Codex 将永久调用 ~/.easylaya/easylaya
rm easylaya-darwin-arm64
```

### 方式 2：克隆仓库 / Python 源码运行

```bash
cd easylaya
pip install -r requirements.txt
./easylaya --setup
```

测试连通性：
```bash
./easylaya test
```

---

## Codex 与 Antigravity 接入

### 1. 接入 Codex

#### 命令行一键接入（推荐）
在任意终端执行：
```bash
codex mcp add easylaya -- ~/.easylaya/easylaya
```
*(Windows 用户请将路径替换为 `%USERPROFILE%\.easylaya\easylaya.exe`)*

#### 配置文件手动接入
在 `~/.codex/config.toml` 中添加：
```toml
[mcp_servers.easylaya]
command = "/Users/chenpei/.easylaya/easylaya"
```

### 2. 接入 Antigravity

在 Antigravity 的 MCP 配置文件（`mcp_config.json`）中添加：

```json
{
  "mcpServers": {
    "easylaya": {
      "command": "/Users/chenpei/.easylaya/easylaya"
    }
  }
}
```

---

## 提供的核心工具

1. **`laya_eval`（结构化快思考裁决）**：
   * 输入上下文与问题清单（支持 `noul` 布尔判断、`choice` 分类选项、`score` 评分），输出精确裁决与置信度（Confidence）。
2. **`laya_label`（文本/数据分类打标）**：
   * 将文本或记录归类到指定的一组标签中。
3. **`laya_relevance`（目标相关性初筛）**：
   * 对一组候选代码片段或文本针对目标进行相关度评估，过滤无关噪声。

---

## 使用场景与 Prompt 提示词范例

AI（Codex / Antigravity）启动后会自动挂载 `easylaya` 提供的 MCP 工具。你在聊天对话中**无需手动执行脚本，直接使用自然语言向 AI 提要求即可**，AI 会自主决定在后台调用相应工具。

### 场景 1：代码安全与破坏性操作门禁（`laya_eval`）

在执行敏感操作、重构或提交代码前，让 Codex 先由 Laya 进行快速门禁评估：

> **给 Codex 的提示词**：  
> “帮我审查刚才修改的 `db/migration.sql` 脚本，调用 `laya_eval` 判断是否存在高危或不可逆破坏性操作（如 DROP TABLE、TRUNCATE），并评估风险等级。”

**AI 动作**：
* Codex 自动调用 `laya_eval`，把 SQL 内容传给 Laya；
* Laya 在 35ms 内返回结构化判断结果与置信度；
* Codex 根据 Laya 的裁决给出详细的安全说明或拦截警告。

---

### 场景 2：数据/工单/反馈批量打标（`laya_label`）

对多条用户反馈、报错日志或工单做快速分流：

> **给 Codex 的提示词**：  
> “读取 `feedback.jsonl` 中的所有反馈内容，使用 `laya_label` 工具为每条内容打上 [bug, feature_request, performance, billing] 中的一个标签，并将打标结果写入 `feedback_labeled.jsonl`。”

**AI 动作**：
* Codex 逐条或分批调用 `laya_label`，快速完成标签归属，显著降低大模型逐条生成的耗时与费用。

---

### 场景 3：大文件上下文初筛（`laya_relevance`）

当项目中代码量很大，想先初筛出真正相关的代码片段，避免主模型上下文爆炸：

> **给 Codex / Antigravity 的提示词**：  
> “我准备为项目增加 OAuth2 登录功能。请在当前仓库中检索候选模块，并使用 `laya_relevance` 帮我挑选出与认证系统最相关的 3 个代码文件。”

**AI 动作**：
* AI 搜索出潜在候选后，调用 `laya_relevance` 做快速二值判断与打分；
* 筛除无关文件，仅将真正关键的代码读入主上下文进行深入编写。

---

## 常见问题与排查

* **Q: 首次运行 `--setup` 时速度较慢？**
  * 首次运行会自动从 Hugging Face 下载预训练模型权重（约 300MB ~ 600MB），后续所有运行均为纯本地毫秒级推理，不再需要联网。
* **Q: Windows 下如何配置？**
  * 下载 `easylaya-windows-x64.zip` 解压后，在 PowerShell 中执行 `.\easylaya.exe --setup` 即可。
* **Q: 是否需要 GPU 支持？**
  * 不需要。Laya 为轻量级非自回归模型，在现代 CPU（尤其是 Apple Silicon 或多核 x64）上单次推理通常在 30~50ms 内即可完成。
