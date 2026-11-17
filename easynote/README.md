# EasyNote

[简体中文](README.md) | [English](README.en.md)

当前版本：`1.6.2`

面向个人与小团队的自托管 Markdown 笔记应用。前端使用 React 19 + TypeScript + Vite 构建为可安装 PWA；服务端运行在 Cloudflare Worker，统一提供 API、远程 MCP、OAuth 与静态资源；D1 保存账号与笔记，R2 保存私有图片与附件，Durable Object 广播变更信号，Cron 每小时清理过期数据。

## 核心能力

- **笔记与编辑**：CodeMirror 6 支持「源码 / 即时渲染 / 阅读」三态（默认即时渲染），停止输入 500 ms 自动保存；支持置顶、归档、标签、回收站、大纲、反向链接、内部链接 `[[UUID|标题]]`、`[TOC]` 目录、KaTeX 公式、Mermaid/Pele 图表（支持另存 SVG/PNG）、版本历史（默认保留 20 份）及多端 WebSocket 增量同步。
- **图片与附件**：支持私有图片（JPEG / PNG / WebP，最大 8 MiB）与附件（PDF / Markdown / TXT / CSV / JSON / ZIP，单个最大 20 MiB，单篇最多 10 个且合计不超过 100 MiB），右键菜单与移动端「笔记操作」里的「下载笔记」可导出 `.md` 或含 `attachments/` 的 `.zip`。
- **组织与检索**：支持最多 5 层目录、拖放及 `Alt+↑/↓` 手动排序、全局搜索 `Cmd/Ctrl+K`、命令面板 `Cmd/Ctrl+O` 与任务中心（聚合未完成 TODO）。
- **分享与 AI 接入**：支持 1 小时至永久的只读分享链接；内置 `/mcp` 远程 Streamable HTTP MCP 与 OAuth（PKCE S256），支持 Codex、ChatGPT 等客户端检索与受控写入。
- **离线与 PWA**：支持离线冷启动与独立窗口；IndexedDB 离线笔记库自动镜像正文与私有文件，恢复网络后按 `operationId` 幂等提交与三方合并。安装后在 Android / Chrome 的系统分享面板可直接分享文字、网页链接与图片：服务端只接收正文与标题，分享内容先暂存在浏览器本地，打开 EasyNote 后落成一篇新笔记（链接存为 Markdown 链接，图片按普通上传插入）；带文件的分享在离线时保留到下次联网打开，iOS / Safari 不支持接收系统分享。
- **账号与导入导出**：支持多用户隔离、管理员审批注册、恢复代码、ZIP v3 / Obsidian / Markdown 导入导出、逐页预览 PDF 导出、`backup.sh` 灾备与 `restore.sh` 恢复。

## 架构

```text
浏览器 / PWA（React 19 + TypeScript + Vite）
   │  HTTPS：/api/*  /mcp  /oauth/*  / 静态资源
   ▼
Cloudflare Worker（src/worker、src/ai）
   ├── D1              账号、会话、笔记、版本、目录、同步序号、FTS5、分享、令牌
   ├── R2              私有图片与附件（<user_id>/<file_id>）
   ├── Durable Object  NoteEvents：账号级变更广播（WebSocket Hibernation）
   └── Cron（每小时）  清理过期会话、分享、未引用文件与已注销租户数据
```

<details>
<summary>目录结构</summary>

```text
src/
├── client/     # React 工作台、CodeMirror 编辑器、三方合并、IndexedDB 离线库、PDF 与导入导出
├── worker/     # 路由、鉴权、笔记、Durable Object、私有文件、OAuth、分享与 AI 集成
├── ai/         # 远程 MCP 工具与 Resources
└── shared/     # 共享类型与限额配置
migrations/     # D1 结构与增量迁移（0001～0005）
scripts/        # setup / maintenance / cloudflare / deploy 编排
test/           # Miniflare API、Playwright UI 与脚本测试
```

</details>

## 快速开始

需要 Node.js 22.12+：

```bash
cd easynote
bash dev.sh    # 自动安装依赖、交互初始化本地管理员并启动（http://127.0.0.1:8791）
```

常用运维与开发脚本（均支持 `--help`）：

| 命令 | 用途 |
| --- | --- |
| `bash setup.sh` | 准备依赖与本地管理员账号 |
| `bash dev.sh [--port 8793]` | 启动本地开发服务（热更新另开终端运行 `npm run dev:client`） |
| `bash deploy.sh` / `bash deploy.sh --check` | 交互式生产部署 / 本地构建与部署预检 |
| `bash reset-password.sh --local` / `--remote` | 交互式重置账号密码并撤销会话与 AI 令牌 |
| `bash backup.sh --remote` | 创建并校验完整 D1/R2 灾备 |
| `bash restore.sh <目录> --remote [--check]` | 恢复预检或执行恢复 |
| `bash reset.sh --local` / `--remote` | 确认后清空本地 / 云端资源 |

## 部署到 Cloudflare

1. **开通 R2**：在 Cloudflare Dashboard 的 **Storage & databases → R2 → Overview** 完成账号级开通确认。
2. **准备公开入口**：使用 `workers.dev` 子域名，或准备已激活的自定义域名（如 `notes.example.com`）。
3. **创建 API Token**（[API Tokens](https://dash.cloudflare.com/profile/api-tokens/)）：
   - Account 权限：`Account Settings (Read)`、`Workers Scripts (Edit)`、`D1 (Edit)`、`Workers R2 Storage (Edit)`。
   - 使用 Custom Domain 时追加 Zone 权限：`Zone (Read)`、`Workers Routes (Read)`。
4. **执行部署**：在 `easynote/` 运行 `bash deploy.sh`，按提示输入隐藏 Token 并确认资源变更；后续更新执行 `git pull --ff-only` 后再次运行 `bash deploy.sh` 即可。

1000 篇以内的个人笔记通常可落在 Workers Free、D1 Free 与 R2 Standard 免费额度内（建议将 `VERSIONS_KEPT` 设为 5～10 为 D1 留出充足空间）。

## 配置

服务端参数位于 `wrangler.json` 的 `vars`：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `MAX_NOTE_BYTES` / `MAX_NOTES` | `262144` / `5000` | 单篇正文 256 KiB / 每账号笔记上限 |
| `MAX_IMAGE_BYTES` / `MAX_IMAGE_PIXELS` | `8388608` / `40000000` | 单张图片 8 MiB / 4000 万像素 |
| `MAX_ATTACHMENT_BYTES` / `IMAGE_QUOTA_BYTES` | `20971520` / `1073741824` | 单个附件 20 MiB / 每账号 R2 配额 1 GiB |
| `VERSIONS_KEPT` / `IMAGE_GRACE_HOURS` | `20` / `168` | 每篇保留历史快照数 / 未引用文件清理宽限期（小时） |
| `SESSION_DAYS` / `AUTOSAVE_MS` / `POLL_SECONDS` | `30` / `500` / `30` | 会话有效期（天）/ 自动保存延迟 / 轮询间隔 |
| `LOGIN_WINDOW_SECONDS` / `LOGIN_IP_LIMIT` / `LOGIN_GLOBAL_LIMIT` | `900` / `20` / `200` | 登录限流窗口与次数限制 |
| `ALLOW_LOCAL_HTTP` | `false` | 本地环回开发设为 `true` |

## API 概览

浏览器写接口校验同源 `Origin` 与 `X-CSRF-Token`，AI 接口使用独立 Bearer 令牌，所有数据按账号隔离。

| 方法 / 路径 | 功能 |
| --- | --- |
| `GET /api/session`、`POST /api/login` / `logout` / `register` | 会话状态、登录、登出、申请注册 |
| `POST /api/account/password` / `logout-all` / `recovery-code` / `reset-password`、`DELETE /api/account` | 密码、恢复代码与账号管理 |
| `GET/POST /api/admin/users`、`PATCH/DELETE /api/admin/users/:id`、`PATCH /api/admin/settings/registration` | 管理员用户管理与注册开关 |
| `GET /api/events`、`GET /api/sync`、`GET /api/sync/cursor` | WebSocket 变更通知与增量同步 |
| `GET /api/notes`、`POST/GET/PUT/DELETE /api/notes/:id`、`GET /api/tasks` | 笔记读写、检索与任务中心 |
| `GET /api/notes/:id/versions`、`backlinks`、`GET /api/tags`、`POST /api/notes/duplicates` | 版本历史、反向链接、标签与去重 |
| `GET /api/shares`、`GET/POST/PATCH/DELETE /api/notes/:id/share`、`GET /api/public/shares/:token` | 只读分享管理与免登录读取 |
| `PUT/GET /api/images/:id`、`PUT/GET /api/files/:id` | 私有图片与附件读写 |
| `GET/POST/DELETE /api/integrations/tokens`、`GET/POST/PUT /api/integrations/notes*` | AI 令牌管理与受控笔记读写 |

## 语法速查与快捷键

| 语法 / 快捷键 | 效果 |
| --- | --- |
| `- [ ] 待办` / `- [x] 已完成` | 阅读或即时渲染中点击勾选并写回源码 |
| `[[笔记 UUID\|显示标题]]` | 内部稳定链接 |
| `[TOC]`（单独成段） | 生成可点击的笔记目录 |
| `$x^2$` / `$$...$$` / ` ```mermaid ` | KaTeX 公式 / Mermaid 图表（支持另存 SVG/PNG） |
| `Cmd/Ctrl+K` / `Cmd/Ctrl+O` | 全局搜索 / 快速跳转 |
| `Cmd/Ctrl+S` / `Cmd/Ctrl+E` / `Cmd/Ctrl+P` | 保存版本 / 切换编辑与阅读 / 导出 PDF |
| `Cmd/Ctrl+Enter` / `Cmd/Ctrl+Shift+K` | 当前目录新建笔记 / 插入内部链接 |
| `Cmd/Ctrl+\` / `Cmd/Ctrl+.` / `Cmd/Ctrl+Shift+L` | 切换侧栏 / 大纲与反链 / 深浅主题 |

示例文件可直接导入体验：[`examples/`](examples/)。

## 验证

```bash
bash deploy.sh --check
npm run build          # 类型检查 + i18n 检查 + 构建
npm test               # API 与 AI 测试
npm run test:scripts   # 脚本流程测试
npm run test:ai        # 远程 Streamable HTTP MCP 测试
npx playwright install chromium && npm run test:ui
```

## 更多文档与版本管理

- 版本历史：[`CHANGELOG.md`](CHANGELOG.md)
- AI / MCP 接入：[`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)
- 备份与恢复：[`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md)

提交版本更新时在仓库根目录执行：

```bash
node scripts/version.mjs bump easynote patch
node scripts/version.mjs check
```
