# 独立审查原始报告

审查实例：独立子代理（未参与实现），只读，未修改文件。宿主 DeepSeek Harness；实际模型与推理深度未由工具返回，记为未知。审查对象为冻结的工作区 diff（sha256 `e3e5a2016a89a948afd318c36e0650399305e2c19d11cd9e0449f7186fe159d0`，基线 HEAD `bf39ef9`），r=1/4。以下为原文，仅把 `/tmp/easydev-r1` 的绝对路径保留为定位信息，未改写结论。

```text
# 独立审查报告：订单读取所有权校验

## 结论

核心修复正确：订单的所有权校验、admin 导出旁路、两个现有调用方的适配、契约文档与检查脚本均保持一致。实际运行检查脚本的结果为 `PASS: 7/7`，退出码 0。未发现 P0、P1、P2 三个级别的确定缺陷；下面列出 1 条 P3，以及 1 条影响较大的待验证风险。

## 确定发现

[P3] 越权返回 403、订单不存在返回 404，仍可探测订单是否存在

- 位置：/tmp/easydev-r1/app/api.py 的 handle_show_order（第 7–10 行的 403/404 分支）；契约 /tmp/easydev-r1/docs/orders.md 第 8 行明确“越权映射为 403”。
- 场景与影响：任一已认证用户对任意订单 ID 调用详情接口时，403 表示“订单存在但不属于自己”，404 表示“不存在”。夹具中的 o1/o2 是可枚举 ID，因此可批量探测订单存在性（不含内容）。修复前该用户可直接读到内容，风险更严重；这是修复后残留的低影响信息侧信道。
- 证据：实测 handle_show_order({"user_id":"u2"}, "o1") -> {"status":403}；handle_show_order({"user_id":"u2"}, "nope") -> {"status":404}；app/orders.py 对存在的他人订单抛 PermissionError，对缺失订单返回 None。
- 修复与验证：若不接受存在性披露，对 PermissionError 与 None 统一返回 404 并同步文档；为两种情况各加一条断言。若 403 是已确认的产品契约，可保留并记录为已知限制。

## 待验证风险

[待验证风险] 授权身份 request["user_id"] 的来源未在仓库内证明

- 线索：app/api.py:6 直接把 request["user_id"] 当作 current_user_id；仓库只有 app 模块、文档和检查脚本，未包含 HTTP 鉴权/会话中间件（git ls-files 已核对）。docs/orders.md:8 称其为“已认证用户”，这是契约假设，仓库内没有可验证保障。
- 成立条件：上游把客户端可控的 user_id（body/query）放入 request，或未认证请求也能到达该 handler。
- 潜在影响：若 user_id 可伪造，攻击者传入受害者 ID 即可通过所有权校验，本次 IDOR 修复失效（P1 级）；若字段缺失，实测抛 KeyError，表现为 500 而非 401/403。
- 最小确认：定位构造 request 的框架/中间件，确认它从已校验会话写入 user_id、剥离客户端同名输入，并在 handler 前拒绝未认证请求；补一条伪造/缺失 user_id 的接口测试。

## 已核对并排除

- 所有权校验：app/orders.py:4 对存在的他人订单抛 PermissionError，本人返回订单，缺失返回 None。修复前基线 8461ed0:app/orders.py 确无所有权校验，get_order("o1") 直接返回订单，与开发者“修复前已复现”一致（静态确认）。
- admin 导出：app/admin.py:4 委托 get_order_for_export；app/orders.py:11-14 先校验 role == "admin" 再 find_order，保留 admin 校验且不受所有权限制。实测 admin 可读他人订单（export_order("o2", {"role":"admin"}) 返回 o2），viewer 对存在/不存在订单均抛 PermissionError。
- 调用方：全仓 grep 仅 app/api.py、app/admin.py、check_orders.py 使用相关函数；无遗留单参数 get_order 调用；git status --porcelain --untracked-files=all 无未跟踪文件；无 stash 或其他分支改动。
- 文档：docs/orders.md 的签名、None/PermissionError 语义、403 映射均与实现一致。

## 验证证据核对

- 实际运行 PYTHONDONTWRITEBYTECODE=1 python3 -B check_orders.py -> PASS: 7/7 ownership and caller checks，退出码 0；运行后 git status 不变，未生成 __pycache__/.pyc。
- 对 app/*.py 与 check_orders.py 使用内存 compile() 做语法校验，全部通过；精确的 PYTHONPYCACHEPREFIX=/tmp/pycache python3 -m py_compile ... 命令未运行（为保持只读改用不落盘的等价校验）。
- 另做 8 个边界探针，覆盖 owner 读取、他人拒绝、缺失订单、无 user_id、admin/viewer 导出等路径。
- 基线说明：HEAD 实为 bf39ef9，父提交 8461ed0；二者差异仅为 tests/check_orders.py 重命名为根目录 check_orders.py，功能内容一致。注意 8461ed0:tests/check_orders.py 已按两参签名编写，修复前会因 TypeError 失败，不能直接作为“读出他人订单”的运行证据；该缺陷由 8461ed0:app/orders.py 的静态实现确认。

## 收尾说明

- 范围与完成状态：审查 git diff HEAD（HEAD=bf39ef9，父提交 8461ed0）与未跟踪文件，共 5 个修改文件，全量阅读。
- 验证状态：实际运行（夹具检查 + 边界探针）并通过；无 HTTP/鉴权层与真实数据库。
- 关键限制：未验证 request["user_id"] 的上游可信性；检查脚本未覆盖 API 的 404 分支与缺失 user_id 分支；未覆盖真实并发/外部调用方。
- 高影响待验证风险：若上游未把 request["user_id"] 绑定到已认证会话，本次修复可被伪造 ID 绕过（P1 级）。
```
