# 测试用例目录

本目录保存可执行的自包含用例。每个子目录使用描述行为的语义化 slug，并集中放置被测初始状态、参考材料、独立验收和复验入口。

## 约定

- 目录名描述验收行为，不使用易失的顺序编号作为路径。
- `initial/` 是 Agent 可见的初始仓库。
- `solution.patch`、独立验收器和其他隐藏断言属于评测私有材料，正式评测时必须放在 Agent 无法读取的位置。
- `solution.patch` 是夹具级参考补丁，可以同时更新夹具自带的检查脚本与契约文档以完成复验；它不是 Agent 的合规样例，Agent 的修改边界以用例 prompt 与隐藏验收为准。
- `verify.py` 负责固定补丁的确定性复验，可进入 CI；`run.sh` 只是薄封装；真实 Agent 行为由 `tests/experiments/agent_runner/` 执行。
- 用例 README 说明运行方式、材料边界、覆盖范围和未验证条件。

## 当前用例

| 用例 | 验证目标 | 入口 |
| --- | --- | --- |
| `public-contract-callers` | 公共契约变更、对象级所有权校验和调用方适配 | `bash tests/cases/public-contract-callers/run.sh` |

其余行为场景由 [tests/behavior.md](../behavior.md) 定义；其中 B01、B02、B16 与 `public-contract-callers` 已有离线可执行载体，由 `tests/experiments/agent_runner/` 的替身驱动。只有需要固定仓库材料、参考补丁或独立验收的场景才在此建立目录。
