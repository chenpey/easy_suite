# 可安装业务 handler 示例

`easytest-business-example` 是一个独立 Python 包，通过 `sample_business:quote` 接入 EasyTest 的 `scenario` executor，演示如何将业务适配包独立安装到测试环境中运行。

在 `easytest/` 目录构建 wheel 并创建独立环境验证：

```bash
uv build --wheel
uv venv examples/business_handler/.venv
uv pip install --python examples/business_handler/.venv/bin/python \
  dist/easytest-0.4.2-py3-none-any.whl ./examples/business_handler
examples/business_handler/.venv/bin/easytest list --root examples/business_handler/project
examples/business_handler/.venv/bin/easytest validate --root examples/business_handler/project --case-id pricing.quote
examples/business_handler/.venv/bin/easytest run --root examples/business_handler/project --case-id pricing.quote
```

接入实际业务 SDK 时，在本包声明 SDK 依赖并替换 `quote` 实现即可；handler 通过 `context.environment` 读取项目环境变量，普通 dict 返回值完整保留，需要返回截图或 metadata 时使用顶层导出的 `ExecutionResult`。复杂写流程的数据清理见 [新业务接入指南：数据清理示例](../../docs/新业务接入指南.md#数据清理示例)。
