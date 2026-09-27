# 框架测试数据

本目录保存框架回归测试与 `notebooks/manual_test.ipynb` 共用的固定数据，
覆盖 HTTP、RPC、数据库、UI、步骤关联和快照。业务演示统一维护在
[JSONPlaceholder Demo](../../../examples/jsonplaceholder/README.md)。

`cases/`、`config/`、`snapshots/` 和 `assets/` 组成一个默认严格离线的测试项目。
`tests/conftest.py` 将框架的表格测试指向这里，普通业务项目不依赖此目录。

在仓库 `easytest/` 目录执行 `uv run pytest` 即可运行框架回归。
维护者需要重新生成工作簿、编译 JSON 和截图时，执行：

```bash
uv sync --extra examples
uv run python scripts/generate_test_fixtures.py
```

脚本只生成本目录下的测试输入，不更新 `snapshots/` 中已确认的基线，
也不改写 JSONPlaceholder Demo。基线变化需另外检查和确认。
