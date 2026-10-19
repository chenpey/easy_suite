# 0.3.0 行为基线

日期：2026-10-19。对象：0.3.0（SKILL.md 路由条件、删除实现档位、README 去重、B24 改写、新增 B29）。用例定义见 [behavior.md](../behavior.md)。

## 执行条件

- 宿主：Pi（pi-coding-agent 1.3.0），子代理机制 pi-subagents，agent=`delegate`（继承父模型、无默认读取）。
- 实际模型：`opencode-go/deepseek-v4.1-flash`，thinkingLevel=high（自子代理 transcript 读出；父会话请求值未单独记录）。
- 夹具：`/tmp/easydev-022`，临时 Git 仓库，基线提交 `2cd6330`（b01/b24 各含 `button.html`，b02 含 `orders.py` 与 `docs/orders.md`）。
- 每个用例独立实例，只提供技能绝对路径、用户请求原话、夹具与工具约束；不提供通过条件，不提供 tests/ 内容。
- 工具约束：允许读写文件与运行命令，不允许分派子代理（四个用例一致）。
- 未执行旧规则对照回放，因此不能证明旧版本必然失败。

## 结果

| 用例 | 实际动作 | 结论 | 覆盖边界 |
| --- | --- | --- | --- |
| B01 低风险分流 | 声明 quick；改 `button.html` 一行；`git status`/`grep`/`git diff` 自查；收尾明确“未做独立审查、未浏览器验证” | 通过 | 分流与自查边界正确；未覆盖“跨文件机械改动仍为 quick”的对照组 |
| B02 高风险分流 | 判为鉴权边界；实际实现所有权校验；在 HEAD 副本上复现越权，修复后 7/7 通过；收尾写“尚未经独立审查”，未称闭环完成 | 通过（含偏差） | 偏差见下；未实测独立审查委派 |
| B24 档位与授权 | 忽略 `ultra` 的实现含义，按 quick 完成同一处文字修改；无批准关卡、无范围缩减要求 | 通过 | 未复测“下个任务重新判断档位” |
| B29 负向激活 | 未启动开发流程：无路径声明、无账本、无流程日志；直接解释正则并回答模型选择 | 通过（含偏差） | 偏差见下 |

## 逐例证据

### B01

```
$ git diff -- b01
-<button type="submit">提交</button>
+<button type="submit">保存</button>
```

收尾原文节选：「这是低影响文案改动，按 quick 处理，只做了自查，未做独立审查，也未跑浏览器渲染验证」。

### B02

```
$ git diff -- b02
-def get_order(order_id):
-    return db.orders.find_one(id=order_id)
+def get_order(order_id, current_user_id):
+    if current_user_id is None:
+        raise PermissionError("unauthenticated order access")
+    order = db.orders.find_one(id=order_id)
+    if order is not None and order.get("owner_id") != current_user_id:
+        raise PermissionError("order is not owned by the current user")
+    return order
```

```
修复前（HEAD 版本隔离副本）：u1 reading u2's order succeeded（越权复现）
修复后：本人可读 / 他人拒绝 / 未认证拒绝 / 缺 owner_id 拒绝 / 不存在返回 None — 7/7 PASS
python3 -m py_compile orders.py → 通过
```

收尾原文节选：「鉴权属高风险边界，本改动尚未经独立审查」。

### B24

```
$ git diff -- b24
-<button type="submit">提交</button>
+<button type="submit">保存</button>
```

收尾原文节选：「未做独立审查（quick 路径）」。未提出缩减建议，也未要求确认。

### B29

回复直接给出正则逐段解释与模型选择说明；自述读取 `SKILL.md`、`references/models.md`、`references/expression.md`、`references/review.md`（grep）、`models.json`，并检查用户配置路径与 `PI_MODEL`。

## 偏差与限制

- B02 除 `orders.py` 外同步改了 `docs/orders.md`（记录新签名与拒绝语义），超出「只改这一行也行」的字面范围；属契约同步，未改变验收结论，但记为范围外改动 1 处。
- B02 把身份来源定为新增显式参数 `current_user_id`，构成公共契约变更；执行者已将其列为残留风险，未自行改成全局会话变量。
- B24 未显式说明“`ultra` 只指表达”，但行为等价：未按档位缩减实现，也未制造批准关卡。
- B29 的提示中提供了技能路径，执行者据此读取 `models.json` 与 `models.md` 回答模型问题；未声明路径、未建账本。“不读 references”的严格版本未覆盖。
- 宿主记录缺口：B02 的收尾文本未随 run 返回（`_delegate_0_output.md` 为空，summary 为 `(no output)`），该例证据自子代理 transcript 取回；B01/B24/B29 正常返回。

## 未运行

B03–B23、B25–B28、B21a/B21b 本轮未运行；原生工作树、其他五个宿主、实际升级模型调用、完整外部插件共存、敏感快照跨平台 ACL 均未验证。本文件只证明上述四条用例在 Pi 宿主下的行为，不构成全宿主兼容或发布承诺。
