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
> 运行 `./easylaya --setup` 时，程序会自动在用户主目录下创建隐藏目录：
> - **macOS / Linux**：`~/.easylaya/easylaya`，配置文件 `~/.easylaya/config.json`
> - **Windows**：`%USERPROFILE%\.easylaya\easylaya.exe`（自动调用 Windows 系统 API 为目录添加隐藏属性），配置文件 `%USERPROFILE%\.easylaya\config.json`
> - Codex CLI 会自动检测并完成注册。
> - **运行 `--setup` 完成后，当前下载的临时文件可以随时删除**，服务将长久稳定运行，绝不污染个人主目录。

### 方式 1：直接下载 Release 独立文件（最简，推荐）

根据操作系统下载对应的独立可执行程序（内置所有依赖，无需配置 Python 环境）：

* **macOS (Apple Silicon ARM64)**: `easylaya-darwin-arm64`
* **Linux (x64)**: `easylaya-linux-x64`
* **Windows (x64)**: `easylaya-windows-x64.zip`

#### macOS / Linux 使用指引：
```bash
# 1. 赋予执行权限 (以 macOS 为例)
chmod +x easylaya-darwin-arm64

# 2. 运行交互式引导（自动完成安装并隐藏至 ~/.easylaya/，预热模型）
./easylaya-darwin-arm64 --setup

# 3. （可选）删除当前下载的安装文件，Codex 将永久调用 ~/.easylaya/easylaya
rm easylaya-darwin-arm64
```

#### Windows 使用指引（PowerShell）：
```powershell
# 1. 解压缩 zip 包
Expand-Archive -Path easylaya-windows-x64.zip -DestinationPath .

# 2. 运行交互式引导（自动完成安装至 %USERPROFILE%\.easylaya\，预热模型）
.\easylaya.exe --setup

# 3. （可选）删除当前下载的临时文件，Codex 将永久调用 ~/.easylaya/easylaya.exe
Remove-Item easylaya.exe, easylaya-windows-x64.zip
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

## 硬件加速说明（Apple Silicon M 系列 & NVIDIA GPU）

Laya 在底层已实现自动设备探测（`MPS` -> `CUDA` -> `CPU`）：

### 1. Apple Silicon M 系列 Mac (M1 / M2 / M3 / M4 / M5...)
* **开箱即用，无需配置**：直接下载 `easylaya-darwin-arm64` 独立二进制即可。
* **原生 Metal 加速**：Apple Silicon 的 PyTorch 原生支持 **MPS (Metal Performance Shaders)**，单文件直接调用 Mac 统一内存与 GPU/神经引擎，**无需配置任何额外驱动或 CUDA**，推理延迟低至 **~20-30ms**。

### 2. NVIDIA 显卡 (Linux / Windows)
* **独立二进制包设计**：为了将独立打包体积控制在 **~200MB**（避免打包完整 CUDA 导致突破 GitHub Releases 2GB 上限），并避免用户机器 NVIDIA 驱动与 CUDA 版本的兼容冲突，Release 包默认基于高性能 CPU 构建（CPU 单次决策已达 ~35ms）。
* **如何启用 CUDA 显卡加速**：如果您的 Linux/Windows 机器配备有 NVIDIA 显卡，并希望开启 CUDA 极限加速（~10ms），请使用 **方式 2（源码/Python 运行）**：
  ```bash
  cd easylaya
  # 安装对应 CUDA 版本的 PyTorch（例如 CUDA 12.4）
  pip install torch --index-url https://download.pytorch.org/whl/cu124
  pip install -r requirements.txt
  ./easylaya --setup
  ```
  Laya 会自动识别到 `CUDA` 并全速跑在显卡显存中。

---

## 如何跟进上游更新

上游项目地址：[https://github.com/NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)

### 1. 上游模型权重更新（Hugging Face）
当作者在 Hugging Face 仓库（`convaiinnovations/laya`、`laya-multilingual`、`laya-typed-decisions`）发布新权重或微调模型时：
* EasyLaya 使用 `transformers` 与 `huggingface_hub` 自动加载模型。
* 若要强制拉取最新权重，只需清理本地 Hugging Face 缓存目录：
  ```bash
  # macOS / Linux
  rm -rf ~/.cache/huggingface/hub/models--convaiinnovations--*
  # Windows (PowerShell)
  Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\huggingface\hub\models--convaiinnovations--*"
  ```
  下一次调用或运行 `./easylaya --setup` 时会自动拉取最新版本。

### 2. 上游代码库与 PyPI 包更新
当上游在 PyPI 发布了新版本 `laya`（如 `0.3.5`、`0.4.0`）：
1. **修改依赖版本**：在 `easylaya/requirements.txt` 中修改版本（如 `laya>=0.3.5`）。
2. **升级仓库版本号**：在根目录下执行：
   ```bash
   node scripts/version.mjs bump easylaya patch
   # 若有重大变更可升级 minor:
   # node scripts/version.mjs bump easylaya minor
   ```
3. **提交并打 Tag 推送**：
   ```bash
   git commit -am "chore(easylaya): 跟进上游 laya v0.3.5"
   git push origin main
   git tag easylaya-v0.1.1
   git push origin easylaya-v0.1.1
   ```
4. **自动化发版**：GitHub Actions 会自动触发多平台矩阵构建，全自动为 macOS ARM、Linux x64、Windows x64 编译出最新版本的独立二进制并发布到 GitHub Releases。

---

## 常见问题与排查

* **Q: 首次运行 `--setup` 时速度较慢？**
  * 首次运行会自动从 Hugging Face 下载预训练模型权重（约 300MB ~ 600MB），后续所有运行均为纯本地毫秒级推理，不再需要联网。
* **Q: Windows 下如何配置？**
  * 下载 `easylaya-windows-x64.zip` 解压后，在 PowerShell 中执行 `.\easylaya.exe --setup` 即可。
* **Q: 是否需要 GPU 支持？**
  * 不需要。Laya 为轻量级非自回归模型，在现代 CPU（尤其是 Apple Silicon 或多核 x64）上单次推理通常在 30~50ms 内即可完成。

