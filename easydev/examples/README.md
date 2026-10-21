# 模型配置示例

本目录中的 JSON 不会被 EasyDev 自动加载。

- `models.default.json`：内置默认值的等价模板（`developer`、`reviewer` 均为 `inherit`，`upgrades` 为空），需要可复制起始文件时使用。
- `models.cross-provider.json`：跨供应商、跨模型示例。

实际配置优先级为：对话中明确指定的文件 > 用户外部 `easydev/models.json`；
两者都没有时使用内置 `inherit` 默认值，不读取包内任何 JSON 文件。
需要某个示例时，将其内容复制到用户配置位置或明确指定其路径；
不要把它们当作可修改的安装目录默认文件。
