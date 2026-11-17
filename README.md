# Easy Suite

[简体中文](README.md) | [English](README.en.md)

Easy Suite 是一个多项目工具集，包含跨设备文件中转、自托管 Markdown 笔记、Mac 迁移清单和表格驱动测试框架。各项目相互独立，拥有各自的配置与文档。

## 版本

<!-- versions:start -->
| 项目 | 当前版本 |
| --- | --- |
| [EasyDrop](easydrop/) | `1.4.1` |
| [EasyNote](easynote/) | `1.6.2` |
| [EasyMac](easymac/) | `0.4.6` |
| [EasyTest](easytest/) | `0.4.2` |
<!-- versions:end -->

## 项目目录

### [EasyDrop](easydrop/)

部署在 Cloudflare Workers 上的网页文本与文件中转站，通过同一 HTTPS 地址在电脑、手机和平板间同步内容。

- **核心能力**：多用户隔离空间、管理员账号管理、分片并发与断点续传、客户端 WebP 缩略图、限时免登录文件链接、Android PWA 系统分享接收及跨设备历史同步。
- **技术栈**：JavaScript、Cloudflare Workers、D1、R2。
- **运行与部署**：本地执行 `npm ci && npm run setup && npm run dev`，生产执行 `bash deploy.sh`。

详细说明见 [EasyDrop README](easydrop/README.md)。

### [EasyNote](easynote/)

面向个人与小团队的自托管 Markdown 笔记应用，每个账号拥有独立数据空间。

- **核心能力**：CodeMirror 6 即时渲染与源码/阅读模式、自动保存、目录与手动排序、任务中心、Obsidian/Markdown 导入导出、PDF 逐页预览导出、限时或永久只读分享、私有图片与附件、全文搜索、版本历史、离线笔记库、并发冲突合并及远程 MCP 接入。
- **技术栈**：React、TypeScript、CodeMirror、pdfmake、PDF.js、Cloudflare Workers、D1、R2、Durable Object。
- **运行与部署**：本地执行 `bash dev.sh`，生产执行 `bash deploy.sh`。

详细说明见 [EasyNote README](easynote/README.md)。

### [EasyMac](easymac/)

在旧 Mac 上运行的迁移清单工具，扫描已安装软件并生成可审查、可执行的安装脚本。

- **核心能力**：扫描 Homebrew（Cask 与 Formula）、Mac App Store 与普通应用及网页应用，支持搜索、筛选、导出及新机安装脚本生成。全程本机运行，通过轻量本地启动器与本地网页交互。
- **下载**：[EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)
- **技术栈**：AppleScript、Zsh、HTML、CSS、JavaScript。

详细说明见 [EasyMac README](easymac/README.md)。

### [EasyTest](easytest/)

面向接口与业务流程的 Excel 表格驱动 Python 测试框架，将 XLSX 编译为确定性 JSON 并通过 CLI、pytest 或 Notebook 执行。

- **核心能力**：HTTP、RPC、Database、UI 与业务场景编排，共享数据集驱动、静态预检、离线 Mock、文件与 SQLite 快照、外置截图、并发基线保护及自包含 HTML/PDF 报告。
- **技术栈**：Python 3.12/3.13、pytest、openpyxl、SQLite。
- **快速开始**：执行 `uv sync && uv run pytest`，或 `uv run easytest init ../my-tests` 创建新项目。

详细说明见 [EasyTest README](easytest/README.md)。

## 运行环境

各项目命令在对应项目目录内执行：

- **EasyDrop / EasyNote**：Node.js 22+
- **EasyMac**：macOS 13+（解压发布包后按 `首次使用.txt` 在终端完成首次授权，之后直接双击 `EasyMac.app`）
- **EasyTest**：Python 3.12 / 3.13，推荐使用 `uv`

## 版本管理

各项目通过 `<project>/version.config.json` 声明版本真源与同步目标，根目录 [`versions.json`](versions.json) 与版本表由脚本自动维护。发布更新时在仓库根目录执行：

```bash
node scripts/version.mjs bump <project> patch   # 或 minor / major
node scripts/version.mjs check
```

## 清空重建

在对应项目目录执行清理脚本：

```bash
cd easynote && bash reset.sh --local    # 清空本地状态（保留 .dev.vars）
cd easynote && bash reset.sh --remote   # 重置远端 Worker、D1 与 R2
cd easydrop && bash reset.sh --local
cd easydrop && bash reset.sh --remote
```

完成后在项目目录执行 `bash deploy.sh` 即可重新部署。
