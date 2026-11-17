# EasyNote AI 接入

[简体中文](AI_INTEGRATION.md) | [English](AI_INTEGRATION.en.md)

EasyNote 在 `/mcp` 提供远程 Streamable HTTP MCP，AI 客户端直接通过 HTTPS 连接服务端：

```text
AI 客户端 → https://EasyNote 地址/mcp → D1 / R2
```

## 创建令牌

登录 EasyNote 后打开「设置 → AI 接入」创建令牌：

- **名称**：显示在令牌列表与历史版本中（如 `我的 Codex`）。
- **权限**：按需选择「只读」或「读取和写入」。
- **有效期**：30、90、365 天或永久；每个账号最多保留 10 个有效令牌，可随时撤销。

创建后立即复制 `enai_...` 明文令牌。

## 连接 Codex

点击「复制 Codex 配置」，加入 `~/.codex/config.toml`：

```toml
[mcp_servers.easynote]
url = "https://你的-EasyNote-域名/mcp"
http_headers = { Authorization = "Bearer enai_..." }
```

使用环境变量管理令牌时，先执行 `export EASYNOTE_TOKEN='enai_...'`，再配置环境变量名：

```toml
[mcp_servers.easynote]
url = "https://你的-EasyNote-域名/mcp"
bearer_token_env_var = "EASYNOTE_TOKEN"
```

重启 Codex 后使用 `/mcp` 检查连接；Codex 桌面端可在「设置 → MCP servers」中添加同一 URL。

## 连接 ChatGPT 网页版

在 ChatGPT 的 MCP 应用设置中添加：

- **服务器地址**：`https://你的-EasyNote-域名/mcp`
- **认证方式**：OAuth（客户端自动注册 + PKCE S256）

完成登录授权后生成“ChatGPT”令牌（访问令牌 1 小时有效，刷新令牌 30 天有效并自动轮换），可在「设置 → AI 接入」随时撤销。OAuth 端点包括 `/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`、`/oauth/register`、`/oauth/authorize` 与 `/oauth/token`。

## MCP 工具与 Resources

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `easynote_search_notes` | 只读 | 搜索正常和归档笔记，返回命中上下文、字符范围与分页 |
| `easynote_list_recent` | 只读 | 列出最近笔记 |
| `easynote_read_note` | 只读 | 分段读取单篇完整笔记 |
| `easynote_read_notes` | 只读 | 批量读取最多 20 篇笔记 |
| `easynote_connection_status` | 只读 | 验证账号、令牌名称与权限 |
| `easynote_note_stats` | 只读 | 精确统计正常、归档、回收站及全部笔记数量 |
| `easynote_create_note` | 读写 | 创建笔记 |
| `easynote_update_note` | 读写 | 更新笔记（携带 `expected_revision`） |
| `easynote_archive_note` | 读写 | 归档或取消归档 |
| `easynote_trash_note` | 读写 | 移入回收站 |

- **Resources**：通过 `easynote://notes/{id}.md` 读取 `text/markdown`，列表返回最近更新的最多 100 篇笔记。
- **最佳实践**：统计数量使用 `easynote_note_stats`；按 `startOffset` 分段读取或使用 `easynote_read_notes` 批量读取；写入前通过 `easynote_read_note` 获取最新 `revision`，标题保持纯文本，正文顶级章节从 `##` 开始；AI 写入记录为 `AI：<令牌名称>`。

## 验证与状态码

运行 `npm run test:ai` 可通过真实 Streamable HTTP MCP 客户端验证搜索、读取、写入、Resources、权限隔离与 revision 冲突。常见状态码：`401`（令牌无效或过期）、`403`（权限不足或需 HTTPS）、`405`（需使用 Streamable HTTP POST 访问 `/mcp`）、`409`（revision 冲突，重新读取后处理）。
