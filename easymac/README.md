# EasyMac

[简体中文](README.md) | [English](README.en.md)

当前版本：`0.4.6`

[EasyMac Latest 下载](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)

EasyMac 在旧 Mac 上扫描已安装软件，支持搜索、筛选与选择迁移项目，并导出可在新 Mac 上执行的安装脚本。工具由轻量本地启动器与本地网页组成，开箱即用。

## 使用

1. 解压并保留完整的 `EasyMac` 文件夹。
2. 首次使用时打开 macOS 自带的“终端”，复制 `首次使用.txt` 中的完整授权命令粘贴运行；校验与授权完成后会自动打开 EasyMac（之后可直接双击 `EasyMac.app`）。
3. 在自动打开的本地网页中搜索、筛选并选择需要迁移的项目，预览后下载迁移脚本 ZIP。
4. 将 ZIP 带到新 Mac 解压，按 `EasyMac-First-Run.txt` 说明运行 `EasyMac-Migration.command`（右键“打开”或终端运行），并在确认提示中输入 `install apps` 开始安装。

## 识别与安装特性

- **扫描来源**：`/Applications`、`~/Applications`、本机 Homebrew 安装记录、App Store 元数据 ID 与内置离线 Cask 目录。
- **精准分类**：
  - **Homebrew Cask**：匹配本机安装记录或唯一精确 `.app` 名称的官方 Cask。
  - **App Store**：识别具备有效 App Store ID 的应用，安装后通过 `mas list` 验收。
  - **命令行工具**：`brew leaves` 返回的顶层 Formula。
  - **网页应用**：识别 Chrome/Edge `CrAppModeShortcutURL` 应用，导出时保留宿主浏览器与清理跟踪参数后的地址。
  - **手动安装**：列出其余应用供迁移参考。
- **Node.js / nvm**：选择 `node` 或 `nvm` 时通过官方 v0.40.7 安装器配置，自动安装最新 Node.js LTS 并设为默认版本；通过 zsh 实际启动环境读取 `NVM_DIR` 与 `ZDOTDIR` 并验证安装结果。
- **Homebrew 安装**：支持最多 3 路并发下载、失败后逐项补装与汇总验收（日志保存于 `~/Library/Logs/EasyMac/`），要求新 Mac 为 macOS 14+ 并以普通用户运行。

## 安全与隐私

- 扫描、筛选与脚本生成全部在本机完成，网页全程离线运行。
- 导出脚本在启动安装前要求输入完整确认词 `install apps`，并以普通用户权限执行。
- 临时扫描目录在页面打开 30 分钟后自动清理。

## 项目结构

```text
easymac/
├── VERSION                  # 版本源
├── FIRST_RUN.txt            # Release 首次授权说明
├── catalog/casks.tsv.gz     # 离线 Cask 映射目录
├── scripts/                 # 扫描、启动、构建与目录更新脚本
├── test/                    # Node.js 核心测试
├── web/                     # 本地网页界面与图标源
├── build/                   # 本地构建产物（Git 忽略）
└── dist/                    # Release 发布产物（Git 忽略）
```

## 开发与测试

```bash
./scripts/scan-preview.zsh /tmp/easymac-test
EASYMAC_SCAN_FIXTURE=/tmp/easymac-test/data.js node --test test/core.test.cjs
./scripts/build.zsh
```

其他常用命令：

```bash
./scripts/build.zsh --clean           # 清理 build/ 与 dist/
./scripts/generate-icon.zsh           # 预览生成的 macOS 图标
node scripts/update-cask-catalog.mjs  # 更新内置 Cask 离线目录
```

完整版本历史见 [`CHANGELOG.md`](CHANGELOG.md)。

## 版本与发布

```bash
node ../scripts/version.mjs bump easymac patch
node ../scripts/version.mjs check
git tag -a easymac-v0.4.6 -m "发布：EasyMac v0.4.6"
git push origin easymac-v0.4.6
```

推送 `easymac-v<版本>` 标签后，GitHub Actions 会在 macOS Runner 上自动测试、构建并发布 Release。
