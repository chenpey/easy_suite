## EasyLaya v0.1.0

### 新特性
- **全新开源底层**：全面迁移至 [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) System 1 快速决策引擎（Apache 2.0 协议）。
- **100% 本地自托管**：0 API Token、0 云端费用、0 外发数据，单前向传递 ~33ms 确定性决策，彻底避免大模型生成幻觉。
- **三大主流平台原生支持**：支持 macOS ARM64、Linux x64、Windows x64 独立可执行程序。
- **标准 MCP 协议支持**：
  - `laya_eval`：结构化快思考裁决（支持 `choice`、`score`、`noul`）。
  - `laya_label`：低延迟文本/记录分类打标。
  - `laya_relevance`：目标相关性初筛。
- **一键配置与安装**：`easylaya --setup` 自动创建并隐藏安装（macOS/Linux 为 `~/.easylaya/`，Windows 为 `%USERPROFILE%\.easylaya\`），自动探测并注册至 Codex CLI。
