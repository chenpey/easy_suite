# 可安装业务 handler 示例

这是独立的 Python 包 `easytest-business-example`，通过 `sample_business:quote`
接入 scenario executor。计价使用本地 Decimal，没有网络或业务写入；
示例验证安装、模块发现、handler 调用和普通业务 `output` 字段保留，
不代表公司 SDK 已完成验收。

在框架目录先构建 wheel，然后创建业务独立环境：

```bash
uv build --wheel
uv venv examples/business_handler/.venv
uv pip install --python examples/business_handler/.venv/bin/python \
  dist/easytest-0.4.1-py3-none-any.whl ./examples/business_handler
examples/business_handler/.venv/bin/easytest list --root examples/business_handler/project
examples/business_handler/.venv/bin/easytest validate --root examples/business_handler/project --case-id pricing.quote
examples/business_handler/.venv/bin/easytest run --root examples/business_handler/project --case-id pricing.quote
```

可从任意目录使用该虚拟环境的 `easytest` 可执行文件，`--root` 传项目绝对路径。
Windows 可执行文件位于 `.venv/Scripts/`。
不需要改 `PYTHONPATH` 或在框架源码里放业务模块。本示例是用于验证可安装适配器的
纯代码 fixture，因此显式使用 `source_mode: "json"`，且不带 XLSX 生成元数据。
普通人工维护的业务项目仍应采用 XLSX 权威源并提交同名 JSON。

接入公司 SDK 时，在本包声明 SDK 依赖并替换 `quote` 内部调用。
业务 handler 可用 `context.environment` 读取项目环境；不要从 `.env` 复制密钥到代码。
普通 dict 完整保留，需截图或框架 metadata 时返回顶层导出的 `ExecutionResult`。

复杂业务写流程的清理方式见 [业务指南的数据清理示例](../../docs/新业务接入指南.md#数据清理示例)。
