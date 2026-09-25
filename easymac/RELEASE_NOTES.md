## EasyMac 0.4.4

- 启动脚本 `app-launch.zsh` 改用独立临时目录，避免并发多实例启动时目录覆盖与冲突。
- 预览脚本 `scan-preview.zsh` 增加已存在目录校验，避免覆盖已有输出目录。

## EasyMac 0.4.3

- 重构国际化体系为独立字典（`i18n.js`），支持 `t(key, ...args)` 参数插值。
- HTML 采用 `data-i18n*` 标记静态文案，JS 动态文案统一使用 `t(...)` 获取，移除 `MutationObserver`。
- 新增 `scripts/check-i18n.mjs` 自动化 Key 对齐检查，确保中英文完全对称。

## EasyMac 0.4.2

- 统一设置面板语言标签为「语言/Language」，保持语言选择器中的「中文」与「English」原样显示。

## EasyMac 0.4.1

- 增强动态属性监听（`aria-label`、`title`、`placeholder`、`alt`），提升英文切换完整度。
- 补充页面描述元信息（meta description）翻译与安装脚本说明文本。

## EasyMac 0.4.0

- 本地 UI 增加中英文切换，默认中文并保存用户选择。
- 新增设置面板，优化英文与窄屏布局。

## EasyMac 0.3.3

项目正式更名为 EasyMac，全面同步应用标识与发布工作流。

- 项目全面重命名为 EasyMac（原 EasyNewMac）。
- 应用程序名称、Bundle ID (`party.tiandi.easymac`)、图标资源与本地 Web 界面文本全面更新。
- 更新 GitHub Actions 发布工作流与标签规范（`easymac-v*`）。
- 保持完整迁移与扫描能力：包含应用扫描、Cask 离线匹配、迁移脚本生成与 shell 配置环境检测。

发布包包含 EasyMac.app 与“首次使用.txt”。
