## EasyLaya v0.1.0

### 新特性
- **全新开源底层**：全面迁移至 [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) System 1 快速决策引擎（Apache 2.0 协议）。
- **100% 本地自托管**：0 API Token、0 云端费用、0 外发数据，单前向传递 ~33ms 确定性决策，彻底避免大模型生成幻觉。
- **三大主流平台原生支持**：提供 macOS ARM64、Linux x64、Windows x64 独立可执行程序（开箱即用，无需配置 Python 环境）。
- **标准 MCP 协议支持**：
  - `laya_eval`：结构化快思考裁决（支持 `choice`、`score`、`noul`）。
  - `laya_label`：低延迟文本/记录分类打标。
  - `laya_relevance`：目标相关性初筛。
- **跨平台一键配置与安装**：
  - **macOS / Linux**：`./easylaya --setup` 自动安装至 `~/.easylaya/easylaya`。
  - **Windows**：`.\easylaya.exe --setup` 自动安装至 `%USERPROFILE%\.easylaya\easylaya.exe` 并通过 Windows API 添加目录隐藏属性。
  - 自动探测并注册至 Codex CLI，并输出 Antigravity 配置。

### 平台一键下载与运行指引（推荐）

#### macOS (Apple Silicon ARM64)
```bash
curl -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.0/easylaya-darwin-arm64
chmod +x easylaya-darwin-arm64
./easylaya-darwin-arm64 --setup
```
*(注：命令行拉取天然无 macOS Gatekeeper 隔离拦截)*

#### Linux (x64)
```bash
curl -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.0/easylaya-linux-x64
chmod +x easylaya-linux-x64
./easylaya-linux-x64 --setup
```

#### Windows (x64, PowerShell)
```powershell
curl.exe -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.0/easylaya-windows-x64.zip
Expand-Archive -Path easylaya-windows-x64.zip -DestinationPath .
.\easylaya.exe --setup
```
*(注：Windows 10/11 内置 curl.exe，命令行拉取可免受浏览器 SmartScreen 标记拦截)*
