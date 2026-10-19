# EasyDev 0.3.6 审计与修复记录

日期：2026-10-19
范围：EasyDev 未提交改动（`README.md`、`references/setup.md`、`references/orchestration.md`、`tests/behavior.md`、`examples/models.antigravity.json`），基线 `abafcda`。审查实例未参与实现。

## 发现与处理

| ID | 级别 | 发现 | 处理 |
| --- | --- | --- | --- |
| F-01 | P2 | README 的 rsync 一行命令在 `DEST` 为技能目录时生成 `easydev/easydev` 嵌套目录，宿主无法发现技能 | 将 `DEST` 明确为技能父目录并保留 `$DEST/easydev/`；临时目录实测生成 `.../skills/easydev/SKILL.md`，无嵌套 |
| F-02 | P2 | 升级回归的两份清单触发条件重叠、集合不同，未说明替代或并集关系 | 在 `tests/behavior.md` 的“最小成本回归集合与记录”中写明大版本升级按上节扩展、两者取并集，并补充去重项 |
| F-03 | P3 | rsync 命令复制 `README.md`、`CHANGELOG.md`，且无 `--delete` 时旧文件残留 | 命令排除两份维护文档；补充无 `--delete` 时先确认无自建文件、再删除重建的更新步骤 |
| F-04 | P3 | README/setup 以肯定语气宣称“降低 full 成本”，与新增的“首份成本记录前不得声称已验证”规则口径不一致 | 两处改为“以降低成本为目标，效果待成本基线验证” |
| F-05 | P3 | 发布前检查只解析 `models.json` 与 `models.cross-provider.json`，漏掉新增示例 | 改为解析 `examples/` 下全部 `models*.json` |
| F-06 | P3 | 安装副本中 `setup.md` 指向 `../README.md` 与 `../tests/behavior.md` 的相对链接失效 | 两处改为仓库绝对 URL；按安装命令模拟后，安装副本内相对链接无失效 |
| F-07 | P3 | 并集说明只列 B01/B02 去重，B09 同时出现在两份清单中 | 改为“重复项只跑一次，当前为 B01/B02/B09” |

## 验证

- `git diff --check` 通过；`examples/models.antigravity.json` JSON 解析通过。
- `node scripts/version.mjs check` 通过（版本 0.3.6）。
- 仓库内 Markdown 本地链接检查通过；按 README 的 rsync 命令模拟安装后，安装副本无相对链接失效。
- 两处新增 GitHub 外链返回 HTTP 200；锚点依赖推送后的 `main`，需在推送后实际打开确认。
- 未执行 B01/B02 等真实宿主行为用例；未建立成本基线；未实际调用 Antigravity `invoke_subagent`。

## 结论

三轮审查后，F-01 至 F-07 均已处理；最后一轮在本次范围内未发现确定缺陷。以上为静态检查、本地安装模拟与外链 HTTP 检查，不构成行为验收或成本降低的实测结论。
