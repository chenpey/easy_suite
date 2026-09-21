## EasyLaya v0.1.1

### 新特性与优化
- **Antigravity 全自动探测与注册**：`--setup` 流程现在会自动探测本地 Antigravity 环境并直接在全局 `mcp_config.json` 中完成注册，无需手动编辑配置文件。
- **Windows 系统级隐藏属性与路径优化**：在 Windows 上运行 `--setup` 时自动通过 Win32 API 为 `%USERPROFILE%\.easylaya` 注入系统级隐藏属性，并对生成的 JSON 配置路径中的反斜杠进行合法转义。
- **命令行 curl 一键免拦截拉取**：文档与 Release 指引全面升级为 `curl` 命令拉取，原生避开 macOS Gatekeeper 隔离属性与 Windows SmartScreen 标记拦截。

---

### 平台一键下载与运行指引（推荐）

#### macOS (Apple Silicon ARM64)
```bash
curl -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.1/easylaya-darwin-arm64
chmod +x easylaya-darwin-arm64
./easylaya-darwin-arm64 --setup
```
*(注：命令行拉取天然无 macOS Gatekeeper 隔离拦截)*

#### Linux (x64)
```bash
curl -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.1/easylaya-linux-x64
chmod +x easylaya-linux-x64
./easylaya-linux-x64 --setup
```

#### Windows (x64, PowerShell)
```powershell
curl.exe -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.1/easylaya-windows-x64.zip
Expand-Archive -Path easylaya-windows-x64.zip -DestinationPath .
.\easylaya.exe --setup
```
*(注：Windows 10/11 内置 curl.exe，命令行拉取可免受浏览器 SmartScreen 标记拦截)*
