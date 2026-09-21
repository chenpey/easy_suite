## EasyJev 0.1.3

EasyJev 是为 **Codex** 与 **Antigravity** 打造的极简 **Cloudflare Workers AI Jev 决策门禁** 集成工具。

### 本次更新 (v0.1.3)
- **全自动隐藏安装**：运行 `./easyjev --setup` 时自动在个人 Home 目录下创建 `~/.easyjev/`，并将程序本体与配置自动安装至其中。
- **免手动移动**：用户不再需要手动执行 `mkdir` 或 `mv`；配置完成后，当前下载目录的临时文件可直接安全删除，Codex 将永久引用 `~/.easyjev/easyjev`。

---

### 特性与亮点
- **极简单文件**：纯 Node.js 标准库实现，**零外部依赖**（无需 `npm install`），拉取即用。
- **纯单 Token 模式**：全程仅需 1 个 Cloudflare API Token（`Workers AI: Read` + `Account Settings: Read`），Account ID 自动探测，用户与本地配置**完全零感知 Account ID**。
- **全自动隐藏目录**：自动在 `~/.easyjev/` 中管理程序与配置，保持主目录整洁。
- **安全本地凭据**：交互式隐藏输入（无明文回显），Token 保存于 `~/.easyjev/config.json`，权限强制设为 `0600`（仅当前用户只读写）。
- **免费额度直连**：直接通过 REST API 调用 Cloudflare Workers AI 每日免费 Neurons 额度，**无需部署任何 Cloudflare Worker**。
- **原生 MCP 协议**：无缝对接 Codex CLI、Codex Desktop 与 Antigravity。

---

### 使用说明

#### 1. 下载与自动安装（两步即可）
```bash
# 1. 赋予执行权限
chmod +x easyjev

# 2. 运行交互式引导（自动完成安装并隐藏至 ~/.easyjev/）
./easyjev --setup

# 3. （可选）删除当前下载的临时文件
rm easyjev
```
* 按终端提示粘贴你的 Cloudflare API Token（密码模式隐藏输入）。
* 脚本自动完成有效性校验、账号探测、连通性测试，并将 `~/.easyjev/easyjev` **自动注册至 Codex**。

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
