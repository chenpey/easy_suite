# 0.3.2 行为记录：路由与负向激活

日期：2026-10-19。对象：0.3.2 工作树（分流规则与 P3 收敛规则沿用 0.3.1，本轮未再改规则文本）。用例定义见 [behavior.md](../behavior.md)。

## 执行条件

- 宿主：DeepSeek Harness。每个用例使用独立子代理实例，只得到技能路径、用户请求原话、夹具与工具约束；未给通过条件，未提供本文件或 `tests/` 内容。
- 工具约束：允许读写文件与运行命令；明确无子代理能力，禁止创建子代理。
- 实际模型与推理深度未由工具返回，记为未知。主代理只做夹具准备与结果归档，不参与用例执行。
- 夹具：B29a/B29b 为空目录；B31 为五文件改名仓库（`config.py` 与 `jobs/` 四个模块）；B32 为分页缺陷仓库（`paginate.py` + `check.py`）。

## 结果

| 用例 | 实际动作 | 结论 | 覆盖边界 |
| --- | --- | --- | --- |
| B29a 纯非开发问题 | 未加载技能、未读取 `references`，直接解释正则，并用 `python3`/`node` 实跑验证边界差异 | 通过 | 只覆盖“解释类”问题；未覆盖用户明确要求跳过技能的变体 |
| B29b 规则咨询加载 | 只读读取 `models.md`、`models.json`、`examples/models.cross-provider.json` 与 README 模型配置节后回答；未建账本、未声明分流路径、未进入开发流程 | 通过（含偏差） | 读取文件多于核心子集（额外读了示例与 README 节），但不构成开发流程加载 |
| B31 跨文件机械改动 | 声明按 `quick` 处理；改名 5 个文件，`grep` 无残留，`check.py` 通过，未启动独立审查、未扩为 `full` | 通过 | 未覆盖“用户要求 full”的对照变体 |
| B32 根因初始未知 | 先运行 `check.py` 复现失败（`page(...,3,4)` 返回 `[8]`），定位 `chunk[:-1]`，删除 3 行并复测通过；按 `quick` 自查，明确未做独立审查 | 通过 | 未覆盖“调查后仍需进入 full”的变体 |

## 逐例证据

### B29a

未启动 easydev 流程；自述“未加载任何技能（纯正则解释，不属于编码/开发流程），未创建或修改文件”，并用 Python/Node 验证 `$` 末尾换行、`\d` 与 `[A-Z]` 的 Unicode 边界。

### B29b

回答给出配置优先级（对话指定路径 > 用户外部配置 > 包内默认）与 `reviewer.model` 覆盖方式，并指出宿主工具必须支持按角色覆盖模型；自述读取 `references/models.md`、`models.json`、`examples/models.cross-provider.json`、README 模型配置节，检查 `~/.config/easydev/` 不存在；未建账本、未声明路径。

### B31

```
$ grep -rn RETRY_LIMIT → 无结果（exit 1）
$ python3 -B check.py → PASS: 4/4 job modules use retry limit 3
$ git status --short → 仅 config.py 与 jobs/ 下四个模块
```

自述“按 easydev quick 路径处理……改名是机械替换、行为由 check.py 覆盖”，“独立审查：未做”。

### B32

```
修复前：python3 check.py → AssertionError: [8]（末页丢最后一条）
修复后：python3 check.py → PASS: pagination keeps every item
git diff → 仅删除 paginate.py 中 3 行截断分支
```

自述“先复现……再定位根因……按 quick 路径，未做独立审查”，并记录未新增入参校验的限制。

## 限制与未运行

- B29a/B29b/B31/B32 均为单宿主、单实例、最小夹具；结论来自实例自述与实际命令输出，不含隐藏测试。
- B33（`full` 首轮仅可延期 P3）本轮未执行：需要构造一次只产生可延期 P3 的完整送审，成本高于本轮范围，仍为验证欠账。
- B01–B28 未重跑；跨模型重复（B34/B35）与成本计量未做，不将单次通过当作统计结论。
