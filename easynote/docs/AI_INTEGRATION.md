# EasyNote AI 接入

EasyNote 在部署后的 `/mcp` 提供远程 Streamable HTTP MCP。用户不需要下载源码、安装 Node.js 或运行本地桥接器：

```text
AI 客户端 → https://EasyNote 地址/mcp → D1 / R2
```

## 创建令牌

登录 EasyNote，打开“设置”，在“AI 接入”中创建令牌：

- 名称：显示在令牌列表和历史版本中，例如“我的 Codex”。
- 权限：需要 AI 修改笔记时选择“读取和写入”，仅检索时选择“只读”。
- 有效期：30、90、365 天或永久。

创建后立即复制 `enai_...` 令牌。明文令牌只显示一次。

## 连接 Codex

将令牌放入本地环境变量：

```bash
export EASYNOTE_TOKEN='enai_...'
```

在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.easynote]
url = "https://你的-EasyNote-域名/mcp"
bearer_token_env_var = "EASYNOTE_TOKEN"
```

重启 Codex，然后使用 `/mcp` 检查连接。Codex 桌面端也可在“设置 → MCP servers”中添加同一个 Streamable HTTP URL。

仅在可信设备上，也可直接保存请求头，免去环境变量：

```toml
[mcp_servers.easynote]
url = "https://你的-EasyNote-域名/mcp"
http_headers = { Authorization = "Bearer enai_..." }
```

`config.toml` 此时包含明文令牌，不要共享或提交该文件。

## MCP 工具

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `easynote_search_notes` | 只读 | 默认同时搜索正常和归档笔记，返回命中上下文、字符范围和分页信息 |
| `easynote_list_recent` | 只读 | 列出最近笔记 |
| `easynote_read_note` | 只读 | 分段读取一篇完整笔记 |
| `easynote_read_notes` | 只读 | 批量读取最多 20 篇笔记 |
| `easynote_connection_status` | 只读 | 验证账号、令牌名称和权限 |
| `easynote_create_note` | 读写 | 创建笔记 |
| `easynote_update_note` | 读写 | 更新笔记 |
| `easynote_archive_note` | 读写 | 归档或取消归档 |
| `easynote_trash_note` | 读写 | 移入回收站 |

只读令牌不会暴露写入工具。永久删除、账号管理、令牌管理和文件上传仍由 EasyNote 网页管理。

## MCP Resources

每篇笔记可通过 `easynote://notes/{id}.md` 读取为 `text/markdown`。Resource 列表仅用于浏览最近更新的正常和归档笔记，最多 100 篇；搜索仍覆盖整个知识库。

## 使用建议

```text
检索时先调用 easynote_search_notes；默认 view=any，不遗漏归档知识。
正文命中结果提供 startOffset 和 endOffset，可将 startOffset 交给 easynote_read_note，只读取相关区段。
需要多篇正文时优先调用 easynote_read_notes。
修改前调用 easynote_read_note 获取最新 revision，并作为 expected_revision。
遇到 409 冲突时停止写入，重新读取后处理。
标题不带 #；正文顶级章节从 ## 开始。
删除使用 easynote_trash_note；永久删除由用户在网页中确认。
```

## 安全边界

- `/mcp` 只接受 HTTPS；本地开发回环地址除外。
- 每次 MCP 请求都验证独立 Bearer 令牌、有效期、撤销状态、账号状态和权限。
- AI 写入进入正常版本历史，并标记为 `AI：<令牌名称>`。
- 跨站浏览器请求被拒绝。
- 每个账号最多保留 10 个有效令牌，令牌可随时在设置中撤销。

## 故障排查

- `401`：令牌无效、过期或已撤销。
- `403`：只读令牌尝试写入，或请求不是 HTTPS。
- `409`：笔记 revision 已变化，应重新读取。
- `405`：MCP 地址错误或客户端没有使用 Streamable HTTP POST。
- 找不到工具：确认地址以 `/mcp` 结尾，并重启 Codex。

`npm run test:ai` 使用真实 Streamable HTTP MCP 客户端检查搜索、读取、写入、Resources、权限隔离和 revision 冲突。
