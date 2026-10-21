# 模型配置示例

本目录中的 JSON 不会被 EasyDev 自动加载。

- `models.default.json`：内置默认值的等价模板（`developer`、`reviewer` 均为 `inherit`，`upgrades` 为空），需要可复制起始文件时使用。
- `models.cross-provider.json`：跨供应商、跨模型示例。

示例中的具体模型 ID 一律写成宿主模型表里的完整 ID（如 `codex/gpt-6.1-sol`），保留其命名空间前缀，裸写可能无法解析；`inherit` 与工具暴露的模型层级按各自规则使用。深度用 `reasoning_effort` 单独指定。

实际配置优先级为：用户外部 `easydev/models.json` > 对话中明确指定的文件 > 内置 `inherit` 默认值。
外部配置存在时必须读取并应用，不得跳过；两者都没有时使用内置默认值，不读取包内任何 JSON 文件。
需要某个示例时，将其内容复制到用户配置位置或明确指定其路径；
不要把它们当作可修改的安装目录默认文件。
