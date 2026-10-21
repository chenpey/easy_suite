# 更新日志

版本变更记录。最近一次更新见 [README](README.md)。

## 0.8.1 更新说明（2026-10-21）

本次发布修复审计发现的规则冲突、验证载体与维护脚本缺陷。

- `SKILL.md`：quick 收尾按暴露内容分流（高风险边界或公共契约影响升级 `full`，仅验证或实现细节超出内联核心时加载模块并留在 `quick`），删除「复杂 quick」表述；`full` 选择条件补上高风险边界；按需加载的 execution 行改为同一表述；模型配置来源段只在需要字段校验、用户指定模型或升级规则时读取 `models.md`；收尾段补上 `debug（仅定位）`；聊天表达段说明用户只写 `ultra` 时按表达档位处理并说明推理深度未改变。
- `references/orchestration.md`：审查轮次改为发起即记 `r/4`（占用）、完成后更新为（完成）或（受阻），连续重连超过 2 次按环境故障报告受阻；强度分档链接改指 `review.md#强度分档`。
- `references/planning.md`：范围与授权链接文本改为「全程约束中的范围与授权」；「未答默认」只在用户明确表示跳过/继续时生效，用户未回应时依赖该项的实现保持暂停。
- `references/execution.md`：既有 `quick` 历史不占 `full` 阶段 0 的试修预算（配置 `upgrades` 时该阶段为 1 次），也不消耗无 `upgrades` 时的三次预算。
- `references/setup.md`：新增「Codex 与 Pi」小节，记录可验证的分派字段与「审查实例只读、与实现实例不同」的要求，不写未验证的工具签名。
- `tests/experiments/swebench/run.py`：模板解包允许指向包内相对路径的软链与硬链，拒绝绝对路径、空或含 NUL 的目标，以及词法上或解析后逃出目标目录的链接（`..` 逃逸、经由已有包内软链的逃逸、硬链指向归档外路径）；软链目标按链接所在目录、硬链目标按归档根解析；解包按归档成员顺序逐个校验并立即提取，避免归档内后建链接绕过预扫描，无 `data_filter` 的运行时同样安全，目录成员只建目录、不在写入阶段改权限，所有成员提取完后，目录属性使用创建时解析的规范路径并在应用前复核包含性，按深度降序应用目录的 mode 与 mtime（单个目录失败不中断其余目录），保留只读目录归档的可用性，支持的 Python 版本在 `extract` 时传 `filter="data"`；Codex 运行目录收紧到 `0700`；先原子写入 `protected-modes.json` 再 `chmod(0)`，实验开始时按记录恢复被中断运行留下的 0 权限。`test_run_protocol.py` 的 tar 链接用例从 1 条扩展到 8 条（包内软链/硬链、子目录相对软链、`..` 逃逸、绝对路径、硬链逃逸、归档内后建链接链的两种成员顺序），并新增只读目录（0555）、嵌套只读目录（0500/0500）、逃出目标目录的目录成员、目录属性落在创建时规范路径、目录属性按深度降序共五条用例。
- `scripts/version.mjs`：`version` 必须位于 `metadata:` 块内，块内缺失或版本挂到其他顶层键时校验失败；`sync` 用同一规则定位再写入。`test/version.test.mjs` 新增合法与错位两条用例。
- `tests/cases/public-contract-callers/acceptance.py`：新增 `track_order_value`，让后来出现的所有者值同时进入值集合与文本扫描正则。
- `.github/workflows/easydev-fixture.yml`：新增 agent_runner、swebench 离线单测；`.github/workflows/version-check.yml` 固定 Node 20 并新增 `node --test test/version.test.mjs`。
- `tests/behavior.md` 与 README：说明当前只有 B01、B02、B16 与 `public-contract-callers` 具备可执行载体；README 行为场景编号改到 B49，Skills CLI 安装补安装后校验命令，维护条目补 Node 单测的版本约束。
- 独立审查 r1 修正：`run.py` 把 `protected-modes.json` 的恢复移到读取 `dataset.json`/`task-baselines` 之前，中断重跑不再因数据文件为 mode 0 直接 `PermissionError`；恢复只处理当前 mode 为 0 的路径（不覆盖用户后来收紧的权限），记录必须是「路径→0..0o777 整数」的 JSON 对象，损坏时抛可执行的 `RuntimeError`，正常结束删除记录（`lock_protected_paths`）。`scripts/version.mjs` 只认顶层 `metadata:` 的直接子键 `version`，块扫描跳过空行与 `#` 注释行，`check`/`sync` 共用同一套定位（新增 `updateSkillFrontmatterVersion`）。`SKILL.md` 按需加载表 models 行改为「需要字段校验、用户指定/调整模型、配置异常或需要升级时的来源核对与应用」，与第 33 行一致。版本脚本单测从 `easydev-fixture.yml` 移到对所有 push/PR 生效的 `version-check.yml`。README 维护段区分仓库根与 `easydev/` 目录的 Node 测试命令；`references/execution.md` 恢复 `quick`/`full`/`upgrades` 反引号；`references/setup.md` 补 Pi 字段以宿主当前工具 schema 为准。新增 `test_run_protected_modes.py` 与 `test/version.test.mjs` 表驱动用例。
- 独立审查 r2 修正：`run.py` 锁定前用 `expanduser().resolve()` 把保护路径（含 `--protect-paths` 与 `experiment` 派生路径）规范化为去重的绝对路径，锁定时归并为不重叠集合（祖先已在集合时丢弃其后代，只锁父目录）；恢复只接受绝对路径条目，遇到相对路径抛 `RuntimeError` 并给出记录路径与手工 `chmod` 出口，不再按当前工作目录解释旧记录；恢复与 `finally` 还原按路径深度升序执行，祖先先于后代，父目录为 mode 0 也不再阻断子路径。`test_run_protected_modes.py` 新增相对路径记录、旧格式拒绝、父子归并与恢复顺序、跨目录重启五条用例。README、`tests/behavior.md` 与本节 CI 说明按实际工作流同步：固定补丁复验与 agent_runner、swebench 离线单测在 `easydev-fixture.yml`，版本校验与版本脚本单测在 `version-check.yml`，真实 Agent 行为回归尚未接入。
- 独立审查 r3 修正：`run.py` 的 `lock_protected_paths` 在写入记录与任何 `chmod` 之前，把 `protected-modes.json` 与归并后的保护路径都 `resolve()` 比较，保护路径是记录的祖先（含记录文件本身）时抛 `RuntimeError`，消息写明被拒绝的保护路径、记录路径、原因（记录会被锁住导致中断后无法恢复）与出口（改为保护更具体的子路径，或不要保护实验目录），拒绝时不写记录也不改权限；符号链接别名经 `resolve()` 同样被拦住。`restore_protected_modes` 的校验循环拒绝含 `..` 组件的记录条目（与相对条目同一处置：抛 `RuntimeError` 并给出记录路径、原路径与手工 `chmod` 出口），不在可能含符号链接的旧路径上做词法折叠；所有条目先全部校验通过再 `chmod`，不会先恢复部分条目。`test_run_protected_modes.py` 新增保护实验目录、保护其祖先、保护指向它的符号链接、旧记录含 `..` 条目四条拒绝用例与保护 `task-baselines` 子路径仍允许的对照用例。
- 独立审查 r4 修正：`run.py` 的 `lock_protected_paths` 在写入记录与任何 `chmod` 之前，发现记录路径本身是符号链接（用 `os.path.lexists` 覆盖悬空链接）就抛 `RuntimeError`，消息说明记录路径必须是普通文件、链接可能来自旧运行或外部预置，并给出出口（删除链接让工具重建记录，或手工 `chmod` 恢复权限后重跑）；`reject_record_inside_protected_paths` 改用 `record_path.parent.resolve() / record_path.name`（`os.replace` 的实际落点）与保护路径比较，不再用会跟随链接的 `resolve()` 结果，避免「记录位于被保护目录内」被放行后记录实际落回实验目录、中断时被 mode 0 遮住。`test_run_protected_modes.py` 新增五条用例：记录路径是指向实验目录外有效 JSON 的链接时分别保护实验目录与保护 `task-baselines` 子路径都被拒、悬空链接同样被拒、同结构下普通（不存在）记录路径正常锁定与清理的对照，以及落点包含判断的直测。

验证：`node scripts/version.mjs check` 通过；`node --test 'test/*.test.mjs'`（14 项）、agent_runner（12 项）与 swebench（63 项）离线单测通过；`tests/cases/public-contract-callers/run.sh` 在本机用显式 `/tmp` 模板的 `mktemp` 包装后通过（macOS `mktemp` 忽略 `TMPDIR`，夹具本身未改）；本地 Markdown 链接与锚点检查 0 失效；tar 包内软链/硬链与子目录相对软链三条允许用例在一律拒绝链接的旧实现下报 `RuntimeError`（已复现），三条拒绝用例在移除逃逸检查后不再抛 `RuntimeError`，其中逃逸软链会留下指向目标目录外的软链、绝对路径软链会留下指向 `/etc/passwd` 的软链（已复现），`test_run_protected_modes.py` 的新用例分别在移除对应修复后按预期失败（已复现：去掉 r3 的前置拒绝后，保护实验目录、保护其祖先、保护指向它的符号链接三条拒绝用例报「RuntimeError not raised」；去掉 `..` 条目拒绝后，该用例报「RuntimeError not raised」，且正常条目被提前恢复为 `0o644`，而拒绝后才保持 `0`；r4 的两点修复同时去掉后，记录链接的三条拒绝用例报「RuntimeError not raised」，只去掉叶节点拒绝后保护实验目录的用例改报包含判断的消息、子路径与悬空链接两条仍报「RuntimeError not raised」，只把落点换回 `resolve()` 时落点直测报「RuntimeError not raised」）。本轮把模板解包改为逐成员校验并立即提取后，新增的链接链用例在「全量预扫描 + `extractall`」的旧实现下报「RuntimeError not raised」，同一归档会把 `pwn` 写到目标目录外（已复现），恢复后通过；把目录成员改回逐个 `archive.extract()`（立即应用归档 mode）后，只读目录与嵌套只读目录两条用例在 Python 3.9 与 3.12 上都报 `PermissionError`（已复现：`repo/file.txt` 写入与 `a/b` 建目录被拒），恢复逆序应用后通过；本轮把目录属性改为「创建时解析的规范路径 + 应用前复核」后，把属性阶段改回字面路径并去掉复核时，目录属性用例因目标目录外哨兵目录的 mode 与 mtime 被改（0o750→0o500、mtime→归档值）而失败（已复现），改回 `reversed()` 时先子目录后父目录的顺序用例报「0o755 != 0o500」（已复现），恢复后通过。r4 的两点修复与本轮解包顺序修复为自查复现，尚未经过下一轮独立审查。行为场景与真实宿主回归未运行。

## 0.8.0 更新说明（2026-10-21）

本次发布补上「意图不清时怎么问」的缺失环节：此前只有「何时可以请求用户决定」，没有提问格式与禁止猜测的约束，模型倾向按自己的理解继续。

- `references/planning.md` 新增「选项式澄清」：把互斥解读收敛成带 `[推荐]` 的有限选项，最多 3 题，每题 2–4 个互斥选项加「其他（说明）」，每题给「未答默认」且默认项须安全；给出必须提问（改变可见行为、公共契约、数据或兼容承诺、成本量级，或高风险边界无安全默认）与继续实施（唯一解读、常规技术选择、可逆低成本默认）两侧边界；规定待答期间的分工、答复入账、同一问题不重复问，并禁止把猜测写成已确认需求。附格式示例。
- `SKILL.md` 开工第 1 步改指「选项式澄清」并禁止自行选定一种解读继续，`全程约束` 新增「不猜意图」；按需加载表的 planning 行标注该职责。
- `references/execution.md` 收敛「需求含糊先做最小版本」：核心工作与验收唯一时仍先做最小版本，存在会改变结果的互斥解读时先问再改；审查反馈里需用户决定的部分改由主代理按该格式合并提问。`references/review.md` 的「严重歧义时提问」指向同一规则，避免审查者各自向用户开问。
- `references/orchestration.md` 交接段要求子代理不直接问用户、不以猜测补缺，把候选选项交主代理合并，并在交接中记录采用的默认项与未确认解读。
- README 运行规则新增「意图澄清」小节，维护条目把「澄清」纳入需要同步的范围；`tests/behavior.md` 新增 B49，覆盖选项式提问、默认项与对照场景。

验证：`node ../scripts/version.mjs check` 通过；`node --test test/` 通过；`references/planning.md` 与 `SKILL.md` 的本地链接经人工核对。B49 未执行真实宿主回归。
## 0.7.1 更新说明（2026-10-21）

本次发布让只持有安装副本、没有源码的用户也能确认技能版本。

- `SKILL.md` 前置元数据新增 `metadata.version`，与 `versions.json` 保持一致；安装副本读该字段即可确认版本，不需要源码、git 历史或远端仓库。选规范的 `metadata` 字段而非顶层 `version`，pi 等宿主忽略未用键，不影响加载。
- `scripts/version.mjs` 为 `easydev` 增加 `skillPath`：`sync` 写入并规范化 `metadata.version`，`check` 校验其与 `versions.json` 一致，缺失或过期时报错；未声明 `skillPath` 的其他项目不受影响。
- README 安装章节新增「查看已安装版本」，给出从 `SKILL.md` 读取版本的命令；维护条目补上该字段必须与 `versions.json` 同步。

验证：`node ../scripts/version.mjs check` 通过；把版本改为 `9.9.9`、或删除 `metadata` 块时，`check` 分别报不一致与缺失，`sync` 可写回；`SKILL.md` 前置元数据经 YAML 解析得到 `metadata.version`。未执行真实宿主中“仅安装副本读取版本”的回归。

## 0.7.0 更新说明（2026-10-21）

本次发布集中在审计验收契约、规则一致性与文档修复。

- B16 审计验收改为核对 prompt 要求的机器可核对块（`easydev-findings`）：逐行 `P级 | 位置=文件:行号 | 触发= | 后果=`，检查块格式、1–20 条、P0→P3 排序；每条位置均须解析到被审计仓库内真实存在的行，且至少一条落在 `withdraw()` 函数体内（AST 计算函数边界，支持 `文件:符号` 与 Windows 反斜杠路径）。触发/后果字段只要求非空，不再用词表猜描述含义。只解析报告层级围栏（0–3 个前导空格；4 空格缩进、列表或引用容器内的围栏不在支持范围内，prompt 要求块只在顶层给出），未闭合块、第二个机器块、块内杂围栏、空字段、越界路径报格式/证据问题。
- B01 改为核对 prompt 要求的末行标记 `审查状态：自查` / `审查状态：独立`：只认最后一条非空行、整行匹配（从行首开始，不接受前导空格或 Tab），围栏代码块内的标记不计（围栏按 0–3 个前导空格识别）；在 quick 场景下“独立”与缺失均不通过。
- 行为 runner 的场景清单改由 `scenarios.SCENARIO_MODULES` 单一来源派生，`list` 输出与 `--scenario` 参数校验不再手写重复列表。
- `SKILL.md` quick 核心补充同一问题最多三次有新证据尝试的停止规则（含纯调查不计次、环境故障不耗预算并保留候选；此前只写在 quick 默认不加载的 `execution.md`），并给“不加载参考模块”补上复杂任务的例外，与按需加载表和 `references/execution.md` 一致。
- `references/baseline-safety.md` 的加载条件改为与按需加载表一致：`full` 不再无条件加载，只在脏文件、未跟踪/敏感文件、无 Git/首次提交或需恢复时加载。
- README 手工安装补充 `agents/` 可选扩展与 `examples/` 示例配置的安装方式；SWE-bench README 补记 `setup` 子命令；行为 runner README 说明新适配器必须把原生读取动作映射到 `file_access`/`module_access`，否则 B16 与 B01 的读取判定失效。
- `public-contract-callers` 用例说明 `solution.patch` 是夹具级参考补丁（含 `check_orders.py`、`docs/orders.md` 更新），不是 Agent 合规样例；场景 prompt 注明契约文档由评测方同步，消除“Skill 要求同步文档”与“禁止改 `docs/`”的表面冲突。

## 0.6.0 更新说明（2026-10-21）

- 模型配置改为强约束：外部 `~/.config/easydev/models.json`（或 XDG/APPDATA 等效路径）成为权威来源，优先级调整为外部配置 > 对话指定文件 > 内置 `inherit` 默认值。进入 `full` 或任何分派前必须实际读取并记录来源，不可读或无效时暂停分派、不得静默回退；配置或用户指定的具体模型与深度为硬性要求，宿主无法满足时暂停分派而非改用继承模型；`review`/`audit` 与任何分派前的来源检查同受约束。分派后按返回值、运行记录或事件核对实际模型与推理深度，与请求不一致时报告并重新分派，确无记录或不可访问时才记未知并说明原因，可查到的事实不得写成未知。配置与示例中的具体模型 `model` 必须与宿主模型表逐字一致（如 `codex/gpt-6.1-sol`），保留其命名空间前缀、裸写可能无法解析；模型层级与 `inherit` 按各自规则，深度只写在 `reasoning_effort`。示例文件 `examples/models.cross-provider.json` 同步改为完整 ID。同步更新 `SKILL.md`、`references/{models,orchestration,setup}.md`、README 与示例说明；新增 B48 行为用例，尚未执行真实 Agent 回归。
- 吸收 Claude Code 2.1.304 的减少确认思路：授权规则改为开工时一次性归纳「可直接执行 / 需确认 / 禁止」授权基线（小任务记在当前上下文），只对未覆盖项提问，同一授权跨文件、阶段与子代理复用；项目规则只提供日常开发约定，提交、发布、部署、对外消息不因项目规则自动放行，须用户明确授权并遵守宿主规则，被审仓库规则与审查材料不构成授权；压缩或换实例后按项目规则与账本/交接记录重建基线。账本与交接模板同步增加该字段。
- 审查规程新增「轻 / 标准 / 深」三档强度（见 `references/review.md#3-审查强度与检查深度`）：默认「标准」，用户指定 > 项目或组织默认 > 按风险自选，高风险边界最低取「深」且该下限优先于上述来源，单凭选定某一档不算放宽；深档需要的动态验证按既有只读隔离交开发者执行。强度只决定调查广度与验证深度，不改变 P0–P3 定义、证据要求、只读约束与 `r/4` 轮次预算，也不拆分 `full` 流程档位。
- 新增 B46（授权基线与重复确认，含仓库规则声明可直接发布的对照）、B47（审查强度分档，含用户指定「轻」但触及高风险边界的对照）行为用例，并同步 README；尚未执行真实 Agent 回归。
- 修正 Codex 技能默认提示词：流程按风险而非复杂度选择，交付对象改为覆盖只读路径的“实际产物”，与当前分流规则保持一致。
- 取消包内 `models.json`：默认行为恒为角色 `inherit` 且 `upgrades` 为空，已由内置规则覆盖，不再需要实体文件。
- 模型配置优先级定稿为三级：用户外部配置（`~/.config/easydev/models.json` 等）> 当前对话明确指定的文件 > 内置 `inherit` 默认值；任何一级都不读取包内 JSON。默认结构模板移至 `examples/models.default.json`，仍不自动加载。
- 运行时最低文件集缩减为 `SKILL.md` 与 `references/`；安装说明、校验命令、目录结构、评测脚本（agent_runner、SWE-bench）及行为用例同步更新。

- 清理历史项目测评报告与审查记录，移除相关文档引用；保留测试用例、夹具、脚本及 CI。
- 将当前固定测试材料从 `tests/fixtures/b30/` 迁移到语义化目录 `tests/cases/public-contract-callers/`，场景 ID 同步改为 `public-contract-callers`；runner 的 `--fixture-root` 改为 `--case-root`，默认目录改为 `tests/cases`。历史版本记录中的 B30 名称保留为当时事实。
- 修复 SWE-bench 完整数据集与任务子集同时使用时的契约加载：`summarize` 按实验 manifest 与实际 run 的任务并集校验，事件归因按实际 run 校验；没有 manifest 时按实际 run 或全部数据集行回退，不再要求未纳入实验的任务存在 baseline。报告任务数取自实际结果，P2P 回归分母只包含官方任务列出的测试。
- 独立验收补充异常对象及 `error.args` 的订单值泄露检查，并新增 `error-text-leak` 与 `other-user-error-text-leak` 两类伪修复回归；B16 会过滤“其余检查项”及“本次审查范围内”等范围型零结论句，无论其独立成行、位于发现之后、先于后续证据或紧跟“结论：”等标签，都不会否决有效发现。
- SWE-bench 补丁采集改用任务运行前的可信 Git 配置，并禁用 Agent 可注入的 hooks、fsmonitor 与外部 Git 配置/attributes；补充 hook 和 clean filter 回归测试。

- 在 `SKILL.md` 增加所有路径及子代理适用的测试硬约束：按验收行为定粒度，同语义输入优先参数化，禁止围绕实现细节机械拆测；保留独立失败诊断与必要边界覆盖。
- 新增测试须证明相对现有覆盖的增量价值，并从需求、契约或独立参考取得预期结果；禁止镜像实现、自设需求或按数量凑测试，已有有效覆盖时不要求新增测试。
- 独立检查必须在稳定快照上批量并行并收齐结果；串行仅限有具体依据的依赖、共享资源冲突、资源或工具限制，局部冲突不串行化全部检查。
- 移除审查反馈“一次改一项并验证”的固定要求，同步 quick、实施计划、full 编排与 README，补充 B43–B45 行为回归定义；新增用例尚未执行真实 Agent 回归。

## 0.5.0 更新说明（2026-10-20）

### 离线归因与行为回归

- 新增 `tests/experiments/swebench/analyze_events.py`：按运行统计 reviewer 实例、报告、P0–P3、reference 文件访问、usage、缓存率、耗时、声明路径与升级行为；子代理不可见 token 保持未知。
- 新增 `tests/experiments/agent_runner/`：提供 B01、B02、B16、B30 的隔离准备、Codex CLI 适配、事件归因与场景验收入口；离线自测覆盖四个场景，真实模型运行尚未执行。
- 新增 [四臂审查消融协议](tests/experiments/review-ablation/README.md)，明确无审查、同模型审查、同强度跨模型审查、弱开发加强审查四组，不包含伪造实验结果。
- reviewer 只按 `completed` 状态和实际报告计数，重复快照去重；顶层与嵌套事件形状均校验，malformed/空事件流不记为有效调用。SWE-bench runner 只接受带 `result_protocol=2` 的完整结果，行为 runner 使用独立的 `behavior_result_protocol=behavior-v1`，两者历史结果仅作事件归因并单独统计历史 resolved。
- SWE-bench 存储结果必须与真实 `events.jsonl` 的有效事件数、malformed 数和 `turn.completed` 交叉一致；分析器与 SWE-bench runner 同时校验任务、臂、重复目录身份及 F2P/P2P 契约，避免只信任可单独改写的 `result.json`。行为 runner 的结果计数直接取自当次事件解析，恢复语义不按 SWE-bench 结果协议处理。
- 读取归因覆盖 `time`/`nice` 等包装命令、Python 脚本参数及 `git diff -p`/`--patch-with-stat` 等内容输出；B30 增加 `gold`、`runs/`、`result.json`、`agent.patch`、JUnit/pytest 产物等标记，区分摘要命令与真实内容读取，并记录失败命令中的访问尝试及 `cd`/`pushd`/`popd` 与嵌套 shell 的目录上下文。
- 初始 `quick`、最终 `full` 与否定升级语句分别判定；B02/B30 接受真实的 quick 到 full 迁移，拒绝“不升级/禁止升级”等伪升级，`full-local`/`full-staged` 不冒充正式 `full`。B16 的具体发现块排除限制性标题、未覆盖和零发现伪装，同时允许“具体发现 + 未检查边界”。
- 行为 runner 对安装后的运行时 Skill 做前后内容快照，Git 排除规则不能隐藏 Skill 篡改；`result.json` 改为同目录临时文件加原子替换，截断或非法结果会被忽略并允许重跑。
- 结果协议校验 usage 非负整数、缓存数不超过输入数、测试状态枚举、F2P 与 `resolved` 语义、有限墙钟时间及任务/臂/重复目录身份；reviewer 完成只接受 `wait`/`close` 的 `completed` 状态，不接受 `spawn_agent` 伪造。
- 超时清理轮询记录后代 PID，并按进程组、根进程和已记录后代分别发送 `SIGTERM`/`SIGKILL`；发信号前复核 PID 身份，覆盖调用 `setsid()` 的已跟踪后代并降低 PID 复用误杀风险。快速双 fork 并被 init 收养等逃逸仍需 OS 级沙箱兜底。
- B16 对排除 `.git` 后的全工作区做前后指纹，除 Git diff 与索引外还能发现 `.pytest_cache`、`__pycache__` 等 ignored 路径变化。
- B01/B02/B30 的验收子进程使用 `python -S -B`，阻止工作区 `sitecustomize.py` 与字节码产物劫持或污染只读检查；捕获路径之外的全工作区变化同样会使验收失败。

### 运行文本与模型配置

- 将 `normal`/`lite`/`ultra` 三档聊天表达完整内联到 `SKILL.md`，删除 `references/expression.md`，quick 不再为表达规则额外读取文件。
- 将 clean quick 执行闭环内联到 `SKILL.md`；把脏文件、敏感快照、无 Git 与恢复规则拆到 `references/baseline-safety.md`，仅在需要时加载。
- 删除 `shortcut:` 强制注释格式，改为在注释或文档中说明实际限制与升级条件；收尾不可计量的 token、耗时、模型或深度统一标未知。
- 默认包内 `inherit` 配置不再强制读取 `models.md`/`setup.md`；用户指定模型、外部配置、配置错误或升级时才加载。`examples/` 永不自动加载；删除 Antigravity 专用模型示例，默认让所有 harness 继承宿主模型，跨角色分流由用户自行修改外部配置。
- `full-local`/`full-staged` 仍作为消融后的候选方案记录，不进入当前运行规则；在真实行为、隐藏验收和成本证据满足采用门槛前，`full` 不拆分内部档位。
- 最小安装的 rsync 示例排除可选的 `agents/` 与 `examples/`，与运行时最低文件集保持一致。

### 验证与限制

- `git diff --check`、两份剩余模型 JSON 解析、离线事件归因/协议自测与 runner 离线自测通过。
- 行为 runner 只验证夹具准备、隔离和固定验收，不证明真实 Agent 会按 Skill 执行；真实 Agent、网络配置实测、文件系统硬隔离、隐藏验收和四臂消融均未执行。
- 历史 pilot 使用 `0.3.10` 且禁止修改测试，不能用于证明 TDD、独立审查收益或当前版本效果。

## 0.4.1 更新说明（2026-10-20）

- 对 `SKILL.md` 与按需 `references/` 模块做保守精简，并回补精简中弱化的规则：账本已试修复层级、模型诊断调用条件、审查未列场景判断、不虚构路径/行号、依赖引入条件、表达完整性、测试去重与跨进程状态。
- 修正“少关闭证据”、`inherit` 字段说明和若干压缩语病；运行时正文由 29,135 字符降至 25,889 字符（约 -11.2%）。
- 完成本地链接、模型 JSON、版本一致性与 `git diff --check` 静态检查；未执行真实 Agent 行为回归，行为无损性仍需回归用例确认。

## 0.4.0 更新说明（2026-10-20）

- full 采用集成初审与定向复审，高风险公共契约按需提前检查；前置、阶段与最终审查共享预算，保留最终完整变更覆盖。
- 明确人工介入条件与可回查的精简交接，按故障原因补上下文、取证或升级。
- 将最小易读代码、精简注释、正向且完备的文档与人工接手纳入实现和审查标准。
- 补充融合效果的四维对照协议与行为用例；效果收益仍待对照评测。

## 0.3.10 更新说明（2026-10-19）

### B30 错误文本泄露

- 缺失身份的错误文本现在按词边界扫描已知订单字段值，拦截把订单 ID、所有者或金额写进 `error`/`message`/`detail` 的实现（如 `"denied for o1 total 120"`）。
- `run.sh` 新增 `text-leak` 负向变体，负向伪修复共九类；断言仍为 38 条。

## 0.3.9 更新说明（2026-10-19）

### B30 缺失身份结果形状

- 0.3.8 推送后复测发现：缺失身份返回变形后的嵌套订单字段（如 `{"status": 200, "order": {"total": 121}}`）仍能通过。已改为限定缺失身份允许的结果：报错、`None`、空容器，或仅含 4xx `status` 与错误文本的字典。
- `run.sh` 新增 `transformed-leak` 负向变体，负向伪修复共八类；断言仍为 38 条。

## 0.3.8 更新说明（2026-10-19）

### B30 验收与夹具

- 独立验收新增运行时生成订单，并分别改动固定/动态订单的实际所有者，拒绝把固定订单到用户的映射写死或使用导入时快照；缺失身份检查覆盖直接返回的标量订单字段。
- `run.sh` 新增硬编码订单映射与标量泄露两类负向变体，负向伪修复共七类；断言计数改为运行时统计（当前 38 条）。
- 夹具提交显式使用 `-c commit.gpgsign=false`，不再受安装者全局 Git 提交签名配置影响。

### 安装与文档

- 明确运行时最低文件集为 `SKILL.md`、`references/`、`models.json`；`agents/` 与 `examples/` 为可选扩展。
- `references/setup.md` 的 Antigravity 示例改用仓库绝对链接，并说明最小安装缺少 `examples/` 时回退 `models.json` 的 `inherit` 默认值。

## 0.3.7 更新说明（2026-10-19）

### 安全验收与审查反馈

- B30 独立验收扩到 23 条：新增第二订单、跨订单越权、`user_id="admin"`、None/空身份、缺失/空导出角色等断言；`run.sh` 增加五类负向伪修复并检查不生成 `__pycache__`/`.pyc`。
- “处理审查反馈”实施纪律迁入 `references/execution.md`，`orchestration.md` 改为引用，`SKILL.md` 加载表补充，覆盖委派 developer 与 quick/B19。
- Antigravity 示例升级阶段审查模型保持 `pro`；`models.md`/`setup.md` 修正 `inherit`、模型 ID 与层级契约，并补充宿主指令约束。
- 移除本地 `.pi/sandbox.json` 对 `~/.dsh/.env` 的写白名单（本地配置不随 Git 发布）。

## 0.3.6 更新说明（2026-10-19）

### 安装与模型示例

- 新增 Antigravity 模型配置示例 `examples/models.antigravity.json`：`flash` 开发、`pro` 审查，升级阶段换 `pro` 开发；README 与 `references/setup.md` 说明其以降低成本为目标，效果待成本基线验证。
- README 安装章节新增只复制运行时文件的 rsync 命令：`DEST` 明确为技能父目录，排除 `README.md`、`CHANGELOG.md` 与 `tests/`，并说明无 `--delete` 时的更新步骤，避免嵌套目录和旧文件残留。
- `references/setup.md` 的安装与成本基线链接改为仓库绝对 URL，避免安装副本中指向未复制文件。

### 回归与文档

- `tests/behavior.md` 新增“最小成本回归集合与记录”：定义每次升级的最低复跑集合 B01/B02/B09/B13/B16/B25q、与大版本升级集合的并集关系及去重项，并要求在 `tests/results/` 记录成本基线。
- 发布前检查改为解析 `examples/` 下全部 `models*.json`；目录树补充新示例与本轮审计记录。
- 清理 `references/orchestration.md` 中与“默认至多 4 轮正式审核”重复的旧句，预算规则不变。

## 0.3.5 更新说明（2026-10-19）

### 安装与发现元数据

- 补充 Google Antigravity App/IDE 与 CLI 的技能目录、Skills CLI ID、旧目录映射和原生委派能力核对说明。
- `SKILL.md` description 补充英文能力与排除边界，使用 YAML 折叠标量；流程正文与路由规则保持不变。英文激活效果及 Antigravity 宿主行为尚未实测。

### 证据与回归边界

- 历史 Opus 输出的仓库引用改为相对路径，临时产物链接改为普通文本，并声明路径整理不代表重新执行。
- 明确 B30 CI 仅复验固定补丁，不调用 Agent；补充模型/宿主升级后的优先回归集合。持续 Agent 行为回归套件仍未建立。

## 0.3.4 更新说明（2026-10-19）

### 评测加固

- B30 独立验收补充缺失/空身份断言与伪修复回归检查：覆盖 `get_order("o1")`、`get_order("o1", None)`、`handle_show_order({}, "o1")`，并检测完整/部分/嵌套订单数据泄露；`run.sh` 负向回归要求恰好 3 条失败并匹配三个 label。
- B30 用户请求显式声明 `request["user_id"]`、`PermissionError`、`{"status": 403}`（仅 status）与 404；`behavior.md` 内联摘录注明完整夹具以 `tests/fixtures/b30/initial/` 为准。

### 安装说明

- 手动安装只复制运行时文件，排除本地 `.pi/` 与 `tests/`；更新说明同步；CLI 安装后要求检查目录、包含则删除。

### 发布

- 版本 0.3.4。

## 0.3.3 更新说明（2026-10-19）

### 评测加固

- B30 红阶段加入接口探针 `probe.py`（初始期望 200、修复后期望 403），并要求失败原因恰好是 3 条 `TypeError`，不再接受任意非零退出。
- 新增独立验收脚本 `acceptance.py`：断言集不依赖被测仓库的 `check_orders.py`，可直接用于 Agent 任务评测；夹具 README 区分历史补丁复验、Agent 任务评测与独立验收三种用途。
- 新增 `.github/workflows/easydev-fixture.yml`：仅在 `easydev/**` 变更时执行 B30 一键复验；真实 Agent 行为测试仍不进入 CI。

### 发布

- 版本 0.3.3。

## 0.3.2 更新说明（2026-10-19）

### 评测修正

- 更正 0.3.1 完整 `full` 实验的交付状态：工作流已执行、功能检查通过、独立审查完成，但身份来源可信性未验证，按完成边界记为“部分完成/待确认”，不新增规则。
- B30 改为可复现夹具：`tests/fixtures/b30/` 提供初始仓库、完整补丁、审查原文与红绿运行脚本；验收条件收紧为必须适配仓库内调用方并验证原有调用路径，无法确认的外部调用方须记录兼容性风险，未经授权的破坏性变更不能仅靠披露风险过关。

### 发布

- 版本 0.3.2。

## 0.3.1 更新说明（2026-10-19）

### 流程修正

- 分流改按最小必要调查后的实际影响判定：任务描述不完整、根因尚未定位、改动跨文件本身都不再构成 `full` 理由；`quick` 中实际影响超出初判时按实际影响升级，并保留已用尝试与证据。
- 明确用户显式限定流程与高风险边界的优先级：遵守用户授权，但不省略必要的安全验证；缺少独立审查时如实报告缺口，不称闭环完成。
- 区分低影响 P3 延期建议与实质缺陷争议：不实施可延期的 P3 不触发独立确认轮；把确定缺陷降级、以越界为由移出或拒收影响验收的发现，仍须附证据并交下一轮独立确认。

### 测试与发布

- B29 拆分为 B29a（纯非开发问题，不读取 `references`）与 B29b（规则咨询可读取相关文档，但不进入开发流程）。
- 新增 B30（公共契约与调用方检查）、B31（跨文件机械改动仍为 `quick`）、B32（根因初始未知）、B33（仅可延期 P3 不追加复审）。
- 修复版本漂移：`versions.json` 对齐 0.3.1；`scripts/version.mjs` 为 EasyDev 增加 CHANGELOG 发布说明校验；新增版本一致性 CI。

## 0.3.0 更新说明（2026-10-19）

### 破坏性变更

- 删除实现档位。路径后裸写的 `lite`/`ultra` 不再改变实现取舍，档位词只指聊天表达。旧提示词里的实现档位写法会静默失效（不再报错，也不再产生缩减或质疑需求的行为），需要表达极简请写“表达 ultra”。
- `full` 触发条件重写：不再把“跨文件行为变化”作为触发词，改为影响多个调用方、公共契约或持久数据，根因或方案存在实质不确定性，或用户明确要求闭环。单纯文件多的机械改动不再因此进入完整闭环。

### 其他改动

- 合并重复定义：路径表、表达档位与 `full` 边界以 SKILL.md 及各模块为唯一来源，README 不再复制。
- 新增 B29 负向激活用例与结果落盘要求。

## 0.2.1 更新说明（2026-10-19）

- 修正授权修复路由、技能控制边界、作者隔离与默认主代理开发规则。
- 明确档位语法、任务级持续范围、统一修复计数和可恢复账本位置。
- 拆分原生/fallback 工作区用例，补充针对性场景，撤回缺少证据的历史通过声明。
- 补充作者争议的独立确认、quick/full 预算隔离、review 转修复的审核计数、敏感基线保护及 B27/B28 场景。

## 0.2.0 更新说明（2026-10-19）

### 流程与能力

- 新增 `spike` 路径：用最小实验验证可行性并给出结论，产物标记为 `throwaway`，不并入产品代码。
- 新增 `audit` 路径：对全仓或指定目录执行一次性只读审计，按严重度输出最多 20 条确定发现，并优先检查高影响路径和预期负载。
- 完善根因排障：逐层定位偏离边界、对照正常样本、保持单一假设；同一问题三次修复失败后重新质疑架构，并区分代码、环境与时序根因。
- 补充 TDD 红绿纪律：新功能和非平凡行为先确认失败原因，再以最小实现转绿；修复证据必须同时记录修复前失败与修复后通过。
- 补充审查反馈处理：收到反馈后先核实事实，信息不足先澄清，再按优先级逐项修复，并允许基于证据反驳。
- 补充可交接计划契约：计划包含目标、验收标准、影响路径、接口签名、实施步骤、验证方式与提交边界，不允许占位符。
- 新增工作区隔离与收尾：优先使用宿主原生工作树工具，完成后提供本地合并、推送并创建 PR、保留现状三个选项，清理必须获得授权。

### 规则与文档

- 聊天表达统一为 `normal`、`lite`、`ultra` 三档；`ultra` 仅在明确要求时启用，压缩表达不省略风险、数字、路径、错误原文和验证结果。
- 新增技能共存规则：同时安装多个开发或审查技能时，只保留一个流程控制者，避免并行闭环。
- 完善任务基线保护，覆盖干净 Git、已有未提交修改、未跟踪文件和无 Git 仓库。
- 扩展设计与计划审查、全仓审计、独立审查预算和完成边界。
- 精简 README 中的重复内容，将模型字段、优先级和校验规则集中到 `references/models.md`。
- 删除与 `models.json` 重复的 `examples/models.inherit.json`，保留跨供应商示例。
- 修正 DeepSeek Harness 的原生技能目录与共享目录说明。
- 新增 `tests/behavior.md`，定义 B01–B21 行为回归用例。

### 兼容性

- 本次仅修改 Skill 指令、参考文档、示例与测试定义，不涉及数据迁移。
- 外部 `models.json` 的配置格式保持兼容；原先把个人配置直接写入安装目录的用户应先迁移到外部配置路径。
- 更正验证声明：曾记录 B01–B21 通过及 B21 fallback 已验证，但未保留可核验执行证据；历史结果不可核验，不能作为已通过基线。原生工作树路径仍需实测。

## 0.1.0 更新说明（2026-10-18）

- 首次发布一体化编码 Skill，提供 `auto`、`quick`、`full`、`design`、`plan`、`debug`、`review` 七条路径。
- 支持开发与独立审查角色分离，最多四轮正式审核；模型升级、换实例和多个审核者不增加轮数。
- 引入最小完整实现、任务基线保护、验证证据、P0–P3 审查分级和完成边界。
- 提供 developer、reviewer 与升级阶段模型配置。
- 支持六个 harness 的安装位置和 Skills CLI 安装方式。
