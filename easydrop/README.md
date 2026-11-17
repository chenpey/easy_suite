# EasyDrop

[简体中文](README.md) | [English](README.en.md)

当前版本：`1.4.1`

基于 Cloudflare Workers 的跨设备文本与文件中转站，结合 D1 数据库与私有 R2 对象存储，通过同一 HTTPS 地址在电脑、手机和平板间安全交换内容。

## 核心能力

### 账号与权限

- **租户隔离**：每位用户拥有独立的文本、文件、上传状态、历史版本和幂等空间；所有内容接口同时校验资源 ID 与当前会话用户 ID。
- **账号管理**：首次部署交互创建初始管理员，管理员可新增用户、启停账号、重置密码及管理自助注册开关；最后一位已启用管理员受并发条件保护。
- **凭据规范**：用户名（3～32 位字母/数字/`.`/`_`/`-`）与密码（12～32 位，含数字与大小写字母）使用随机盐 100,000 次 PBKDF2-SHA-256 派生；会话使用 HttpOnly Cookie，写请求校验同源 `Origin` 与 `X-CSRF-Token`。
- **账户安全**：用户可修改密码、生成一次性 256-bit 恢复码或注销账号；改密与全端登出即时撤销全部会话。

### 文本与文件传输

- **文本分享**：支持多行文本与代码片段（默认上限 128 KiB），纯文本渲染并自动识别 `http://` / `https://` 链接，支持一键复制与删除。
- **分片并发上传**：支持点击选择、拖放与直接粘贴图片/文件；默认同时处理 3 个文件、每文件 3 路 5 MiB 分片并发上传（单文件默认上限 200 MiB）。
- **校验与断点续传**：浏览器逐片计算 SHA-256 并生成整文件指纹，Worker 校验分片正文；支持暂停、继续及刷新后重新选择原文件恢复（默认 24 小时恢复窗口）。
- **幂等保护**：文本与上传请求携带 `Idempotency-Key`（UUID v4），安全重试并防止重复写入。

### 下载、缩略图与限时分享

- **缩略图与预览**：JPEG、PNG、GIF、WebP、AVIF、BMP 图片在客户端并行生成最长边 512 px 的 WebP 缩略图并存入私有 R2，支持站内原图弹窗预览。
- **HTTP Range 下载**：支持 `GET`、`HEAD` 与单段 `Range` 请求，返回 `ETag`、`Last-Modified` 及附件下载头。
- **限时免登录链接**：可为单个文件生成 1～168 小时有效的公开下载链接与二维码，支持随时替换或撤销。

### 历史同步与移动端 PWA

- **分页与轮询**：文本与文件混排按新旧分页（默认每页 10 条），默认每 5 秒检查版本变化，页面可见/恢复焦点/联网时立即同步，网络异常按 5～60 秒退避恢复。
- **站点二维码与 PWA**：顶部提供站点 Origin 二维码；内置 Manifest 与 Service Worker，支持安装为桌面或手机独立应用。
- **Android 系统分享接收**：通过支持 Web Share Target 的 Chromium 浏览器安装为 PWA 并打开一次后，可从系统分享面板直接分享文本、链接或文件到 EasyDrop，暂存于浏览器本地等待点击确认发送。

## 架构与存储

| 组件 | 职责 |
| --- | --- |
| Cloudflare Worker | 路由、鉴权、参数校验、分享接口、下载与后台清理 |
| Workers Static Assets | 提供构建后的前端页面与哈希静态资源 |
| D1 数据库 | 存储用户、会话、限流计数、文本、文件元数据、操作幂等状态与分片状态 |
| 私有 R2 存储桶 | 存储文件实体 `files/<id>` 与可选缩略图 `files/<id>/preview` |
| Cron Trigger | 每 15 分钟清理过期会话、临时链接、超时上传与待删除对象 |

## 本地运行

需要 Node.js 22+：

```sh
cd easydrop
npm ci
npm run setup      # 交互创建本地初始管理员（写入 .dev.vars）
npm run dev        # 默认监听 http://127.0.0.1:8787
```

临时无状态预览：

```sh
npm run preview    # 随机端口与一次性密码，停止后自动清理
```

清空本地 D1/R2 状态（保留 `.dev.vars`）：

```sh
bash reset.sh --local
```

## 部署到 Cloudflare

1. **启用 R2**：在 Cloudflare Dashboard 打开 **Storage & databases → R2 → Overview** 完成开通确认。
   ![Cloudflare R2 启用路径](docs/img/cloudflare/cloudflare-r2-enable.svg)
2. **准备公开入口**：
   - `workers.dev`：在 **Workers & Pages** 初始化账号级 `workers.dev` 子域名。
     ![Cloudflare workers.dev 初始化路径](docs/img/cloudflare/cloudflare-workers-dev.svg)
   - **Custom Domain**：在同账号下准备状态为 **Active** 的根域名及空闲主机名（如 `share.example.com`）。
3. **创建 Custom API Token**（[API Tokens](https://dash.cloudflare.com/profile/api-tokens/)）：
   - 基础 Account 权限：`Account Settings (Read)`、`Workers Scripts (Edit)`、`D1 (Edit)`、`Workers R2 Storage (Edit)`。
   - 使用 Custom Domain 时追加 Zone 权限：`Zone (Read)`、`Workers Routes (Read)`。
   ![Cloudflare API Token 权限](docs/img/cloudflare/cloudflare-api-token.svg)
4. **执行部署**：

```sh
cd easydrop
bash deploy.sh
```

脚本隐藏读取 Token，自动完成构建、建库建桶、D1 迁移、Worker 发布与 HTTPS 访问校验，并将资源标识保存至 `wrangler.deploy.json` 供后续增量部署复用。

个人日常使用（每日数千次请求、10 GB 存储以内）通常可落在 Workers Free、D1 Free 与 R2 Standard 免费额度内。

## 配置

在 `wrangler.json` 的 `vars` 中调整参数后重新部署：

| 参数 | 默认值 | 可配置范围 | 说明 |
| --- | --- | --- | --- |
| `SESSION_TTL_SECONDS` | `2592000` | 3600～31536000 | 会话滑动有效期（秒，默认 30 天） |
| `SESSION_RENEW_INTERVAL_SECONDS` | `900` | 60～86400 | 会话最小续期间隔（秒） |
| `MAX_UPLOAD_BYTES` | `209715200` | 1～209715200 | 单文件上限（字节，默认 200 MiB） |
| `UPLOAD_CHUNK_BYTES` | `5242880` | 5242880～99614720 | 分片大小（字节，默认 5 MiB） |
| `UPLOAD_CONCURRENCY` | `3` | 1～6 | 单文件并发分片数 |
| `UPLOAD_FILE_CONCURRENCY` | `3` | 1～4 | 同时上传文件数 |
| `UPLOAD_SESSION_TTL_SECONDS` | `86400` | 3600～518400 | 未完成上传恢复窗口（秒，默认 24 小时） |
| `MAX_TEXT_BYTES` | `131072` | 1～1048576 | 单条文本上限（字节，默认 128 KiB） |
| `POLL_INTERVAL_SECONDS` | `5` | 5～3600 | 历史版本轮询间隔（秒） |
| `LOGIN_WINDOW_SECONDS` / `LOGIN_IP_LIMIT` / `LOGIN_GLOBAL_LIMIT` | `900` / `10` / `100` | — | 登录限流窗口与次数限制 |
| `ACCOUNT_ACTION_WINDOW_SECONDS` | `900` | 60～86400 | 注册与密码恢复计数窗口（秒） |
| `HISTORY_PAGE_SIZE` | `10` | 1～50 | 单页历史条数（上限 10） |
| `CLEANUP_BATCHES` | `4` | 1～8 | 每次 Cron 清理批次数（每批 50 条） |
| `ALLOW_LOCAL_HTTP` | `false` | `true` / `false` | 仅本地环回调试设为 `true` |

## 接口概览

写请求需携带有效会话 Cookie、同源 `Origin` 与 `X-CSRF-Token`。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/auth/config` | 公开 | 查询自助注册开关 |
| `POST` | `/api/login` / `/api/register` / `/api/password/reset` | 同源 | 登录、自助注册、恢复码重置密码 |
| `GET` | `/api/bootstrap` / `/api/session` | 会话 | 获取会话配置与首屏历史 |
| `POST` | `/api/logout` | 写校验 | 退出当前会话 |
| `POST` / `DELETE` | `/api/account/password`、`/recovery-code`、`/api/account` | 写校验 | 改密、生成恢复码、注销账号 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/users`、`/api/users/<id>`、`/api/settings/registration` | 管理员 | 用户管理与注册开关 |
| `GET` | `/api/revision`、`/api/history?before=<seq>` | 会话 | 历史版本号与游标分页查询 |
| `POST` | `/api/text` | 写校验 | 提交文本分享 |
| `POST` / `GET` / `PUT` / `DELETE` | `/api/uploads`、`/api/uploads/<id>`、`/parts/<number>`、`/preview`、`/complete` | 会话/写校验 | 分片上传、缩略图、合并与取消 |
| `GET` / `HEAD` | `/previews/<id>`、`/images/<id>/<filename>`、`/uploads/<id>/<filename>` | 会话 | 缩略图、原图预览与文件下载 |
| `POST` / `DELETE` | `/api/history/<id>/share` | 写校验 | 创建、替换或撤销临时链接 |
| `GET` / `HEAD` | `/shared/<token>/<filename>` | 公开 | 临时链接下载（支持 Range） |
| `DELETE` / `POST` | `/api/history/<id>`、`/api/clear_history` | 写校验 | 删除单条记录或清空历史 |

## 项目结构与命令

| 路径 | 说明 |
| --- | --- |
| `src/worker.js` / `src/auth.js` | Worker 路由、业务接口、鉴权与限流 |
| `web/` | 前端页面与交互 |
| `migrations/` | D1 Schema |
| `scripts/` | 构建、预览与 Cloudflare 部署脚本 |
| `test/` | API、部署协议与 Playwright UI 测试 |
| `wrangler.json` / `deploy.sh` | Worker 配置与交互部署入口 |

常用命令（在 `easydrop/` 目录执行）：

```sh
npm run check          # JS 语法检查
npm run build          # 构建前端产物到 dist/
npm test               # API 与部署协议集成测试
npm run test:ui        # Playwright 浏览器测试
bash reset.sh --remote # 重置远端 Worker、D1 与 R2
```
