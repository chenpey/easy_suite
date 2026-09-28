# Easy Suite

[简体中文](README.md) | [English](README.en.md)

Easy Suite 是一个多项目仓库，包含文件分享、笔记、Mac 迁移和自动化测试四个可独立使用的工具。每个项目拥有自己的依赖、配置、数据存储和使用文档。

## 版本

<!-- versions:start -->
| 项目 | 当前版本 |
| --- | --- |
| [EasyDrop](easydrop/) | `1.3.0` |
| [EasyNote](easynote/) | `0.8.6` |
| [EasyMac](easymac/) | `0.4.4` |
| [EasyTest](easytest/) | `0.4.1` |
<!-- versions:end -->

## 项目目录

### [EasyDrop](easydrop/)

EasyDrop 是一个部署在 Cloudflare Workers 上的网页文件中转站。用户登录同一个网址后，可以在电脑、手机和平板之间发送文字和文件。

主要能力包括多用户隔离、管理员控制的注册与账号管理、分片并发和断点续传、客户端 WebP 缩略图、限时免登录文件链接，以及带退避恢复的跨设备历史同步。D1 保存账号、文本和上传状态，私有 R2 保存原文件与可选缩略图。

技术栈：JavaScript、Cloudflare Workers、D1、R2。

本地运行先进入目录执行 `npm ci`、`npm run setup` 和 `npm run dev`；生产部署执行 `bash deploy.sh`，通过交互式 API Token 流程创建或复用 Worker、D1、私有 R2 和公开入口。

详细说明见 [EasyDrop README](easydrop/README.md)。

### [EasyNote](easynote/)

EasyNote 是一个可自行部署的网页 Markdown 笔记应用，适合个人或小团队在多台设备上记录、整理、搜索和分享笔记。每个账号拥有独立的数据空间。

主要能力包括自动保存、任务中心、Obsidian/Markdown 导入、带逐页预览的 PDF 导出、限时或永久只读分享、私有图片、全文搜索、回收站、版本历史、完整离线笔记库和并发冲突保护。管理员可以管理用户及审批注册，笔记、附件、离线缓存和 AI 令牌按用户隔离。

技术栈：React、TypeScript、CodeMirror、pdfmake、PDF.js、Cloudflare Workers、D1、R2。

本地使用进入目录运行 `bash dev.sh`；生产部署运行 `bash deploy.sh`，通过一个交互式 Cloudflare API Token 自动发现账号并创建或复用 Worker、D1、私有 R2 和公开入口，公开入口支持 `workers.dev` 或自动绑定自定义域名。远程部署和维护使用一个限定到目标账号的 Cloudflare 自定义 API Token，由脚本在每次运行时通过终端隐藏读取，生命周期限定在当前进程。配置文件保存资源标识。1000 篇以内的个人笔记通常可落在 Workers、D1 和 R2 免费额度内，详细假设与权限图见子项目文档。

详细说明见 [EasyNote README](easynote/README.md)。

### [EasyMac](easymac/)

EasyMac 是一款在旧 Mac 上运行的迁移清单工具。它帮助用户整理需要带到新 Mac 的软件，并生成可检查、可执行的安装脚本；EasyMac 本身不会安装软件。

主要能力包括扫描 Homebrew、Mac App Store 和普通应用，搜索、筛选和选择迁移项，以及预览和导出安装脚本。工具由无终端窗口的本地启动器和本地网页组成，不需要 Xcode、开发者账号或额外运行环境，扫描清单不会上传。

发布下载：[EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)

技术栈：AppleScript、Zsh、HTML、CSS、JavaScript。

详细说明见 [EasyMac README](easymac/README.md)。

### [EasyTest](easytest/)

EasyTest 是一个面向接口和业务流程测试的 Python 工具。测试人员在 Excel 中编写用例，框架将其编译为确定性 JSON，并通过命令行、pytest 或 Notebook 执行。

主要能力包括 HTTP、RPC、数据库、UI 和业务场景编排，Excel 共享数据驱动、整批静态预检、离线 Mock、文件与 SQLite 快照、外置截图、并发基线保护，以及自包含 HTML/PDF 报告。

技术栈：Python 3.12/3.13、pytest、openpyxl、SQLite。

本地使用进入目录执行 `uv sync` 和 `uv run pytest`；创建项目可运行 `uv run easytest init ../my-tests`。

详细说明见 [EasyTest README](easytest/README.md)。

## 使用

四个项目相互独立，所有命令都应在对应项目目录中执行：

- EasyDrop 和 EasyNote 需要 Node.js 22 或更新版本。
- EasyMac 需要 macOS 13 或更新版本，解压发布包后按“首次使用.txt”在终端完成单次授权即可打开使用，以后可直接双击 `EasyMac.app`。
- EasyTest 需要 Python 3.12 或 3.13，并推荐使用 `uv` 管理环境。

具体启动、测试、部署、配置和安全边界以各项目 README 为准。

## 版本管理

版本源文件是 [`versions.json`](versions.json)，不要直接修改各项目的版本文件、`package.json` 或 README 版本行。准备提交功能更新时，在仓库根目录执行：

```bash
node scripts/version.mjs bump easynote patch
# 或：node scripts/version.mjs bump easymac minor
# 或：node scripts/version.mjs bump easytest patch
node scripts/version.mjs check
```

脚本会同步项目的版本文件、包清单、锁文件、运行时版本、README 和根目录版本表。`patch` 适合兼容性修复，`minor` 适合新增功能，`major` 适合不兼容变更。随后使用带版本号的提交信息，例如 `发布：EasyMac v0.1.0`。

## 清空重建

仓库根目录的 `reset.sh` 用于清空 EasyNote 或 EasyDrop：

```bash
bash reset.sh easynote --local
bash reset.sh easydrop --local
bash reset.sh easynote --remote
bash reset.sh easydrop --remote
```

本地模式删除所选项目的 `.wrangler/state`，保留 `.dev.vars` 中的本地管理员配置，并提示清除对应浏览器站点数据。远程模式读取该项目的 `wrangler.deploy.json`，要求输入完整确认文本及隐藏的 Cloudflare API Token，然后删除 Worker、清空并重建同名 R2 bucket、重建 D1 Schema。完成后进入对应项目执行 `bash deploy.sh` 即可重新部署。

远程清理要求 R2 中的对象均由应用记录。若 bucket 中存在孤立对象，脚本会在删除 bucket 时停止；先在 Cloudflare Dashboard 对该 bucket 执行 **Empty Bucket**，再重新运行清理命令。
