## EasyLaya v0.1.2

### 新特性与优化
- **Apple Silicon 原生 GPU (MPS) 硬件加速**：重构设备探测与调度逻辑（`get_device()`），显式探测并启用 Apple Silicon Metal Performance Shaders (MPS)，将矩阵运算完全从 CPU 卸载至 GPU。
- **推理延迟极限压缩至 ~27ms**：实测单次决策与初筛延迟降至 26~31ms，消除 CPU 满载发热，提升整体交互响应速度。
- **多平台设备自适应降级**：优先调度 CUDA (NVIDIA GPU) 与 MPS (Apple Silicon GPU)，当 GPU 不可用时平滑回退至 CPU，确保跨平台稳定性。

---

### 平台一键下载与运行指引（推荐）

#### macOS (Apple Silicon ARM64)
```bash
curl -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.2/easylaya-darwin-arm64
chmod +x easylaya-darwin-arm64
./easylaya-darwin-arm64 --setup
```
*(注：命令行拉取天然无 macOS Gatekeeper 隔离拦截)*

#### Linux (x64)
```bash
curl -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.2/easylaya-linux-x64
chmod +x easylaya-linux-x64
./easylaya-linux-x64 --setup
```

#### Windows (x64, PowerShell)
```powershell
curl.exe -LO https://github.com/chenpey/easy_suite/releases/download/easylaya-v0.1.2/easylaya-windows-x64.zip
Expand-Archive -Path easylaya-windows-x64.zip -DestinationPath .
.\easylaya.exe --setup
```
*(注：Windows 10/11 内置 curl.exe，命令行拉取可免受浏览器 SmartScreen 标记拦截)*
