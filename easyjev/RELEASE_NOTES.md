## EasyJev 0.1.2

EasyJev 是为 **Codex** 与 **Antigravity** 打造的极简 **Cloudflare Workers AI Jev 决策门禁** 集成工具。

### 本次更新 (v0.1.2)
- **文件持久保留说明**：补充说明 `easyjev` 文件为 MCP Server 服务程序本体，运行配置向导后**切勿删除**。
- **推荐存放位置指南**：提供单文件独立使用推荐路径（如 `~/.local/bin/easyjev`）与使用范例。

---

### 特性与亮点
- **极简单文件**：纯 Node.js 标准库实现，**零外部依赖**（无需 `npm install`），拉取即用。
- **纯单 Token 模式**：全程仅需 1 个 Cloudflare API Token（`Workers AI: Read` + `Account Settings: Read`），Account ID 自动探测，用户与本地配置**完全零感知 Account ID**。
- **安全本地凭据**：交互式隐藏输入（无明文回显），Token 保存于本地 `config.json`，权限强制设为 `0600`（仅当前用户只读写），不随 Git 提交。
- **免费额度直连**：直接通过 REST API 调用 Cloudflare Workers AI 每日免费 Neurons 额度，**无需部署任何 Cloudflare Worker**。
- **原生 MCP 协议**：无缝对接 Codex CLI、Codex Desktop 与 Antigravity。

---

### 使用说明

#### 1. 下载与推荐存放位置
推荐将单文件放置在个人的 CLI 工具目录（如 `~/.local/bin`）：
```bash
# 创建目录并移动文件
mkdir -p ~/.local/bin
mv easyjev ~/.local/bin/
cd ~/.local/bin

# 赋予执行权限并运行向导
chmod +x easyjev
./easyjev --setup
```
> **注意**：`easyjev` 是每次 AI 调用 Jev 时的服务执行本体，运行向导后**请勿删除此文件**。

* 按终端提示粘贴你的 Cloudflare API Token（密码模式隐藏输入）。
* 脚本自动完成有效性校验、账号探测、连通性测试，并在检测到 `codex` 时**自动完成 MCP 注册**。

#### 2. Codex 手动接入（若未自动注册）
```bash
codex mcp add easyjev -- /绝对路径/easyjev
```
或在 `~/.codex/config.toml` 中添加：
```toml
[mcp_servers.easyjev]
command = "/绝对路径/easyjev"
```

#### 3. Antigravity 接入
在 Antigravity 的 `mcp_config.json` 中配置：
```json
{
  "mcpServers": {
    "easyjev": {
      "command": "/绝对路径/easyjev"
    }
  }
}
```

---

### 对话中使用（Prompt 示例）

在 Codex / Antigravity 对话中直接用自然语言提要求，AI 会在后台自动调用 Jev：

1. **安全与风险门禁**：
   > “帮我审查刚才修改的代码，调用 `jev_eval` 判断是否存在高危破坏性操作（如删除表或未授权访问）。”
2. **数据分类打标**：
   > “读取 `feedback.jsonl`，使用 `jev_label` 为每条内容归类为 [bug, feature, docs, pricing]。”
3. **上下文大文件初筛**：
   > “在当前项目检索认证模块，用 `jev_relevance` 挑出最相关的 3 个文件，避免主上下文过长。”

---

### 校验和说明
发布附件包含自执行文件 `easyjev` 及其 SHA256 校验和文件 `easyjev.sha256`。
