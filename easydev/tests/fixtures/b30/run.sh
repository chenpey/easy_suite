#!/usr/bin/env bash
# B30 可复现夹具：初始版本必须按预期失败（红），应用 solution.patch 后通过（绿），
# 最后用独立验收脚本复核，避免只依赖被测仓库自带的 check_orders.py。
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
bypass_root="$(mktemp -d)"
trap 'rm -rf "$work" "$bypass_root"' EXIT

cp -R "$here/initial/." "$work/"
cd "$work"
git init -q
git add -A
git -c user.email=fixture@example.com -c user.name=fixture -c commit.gpgsign=false commit -qm "b30 initial"

echo "== 红：初始代码缺少所有权校验，他人读取返回 200"
python3 -B probe.py 200

echo "== 红：初始检查必须因目标契约缺失（TypeError）失败，且失败行恰好 3 条"
if python3 -B check_orders.py >red.log 2>&1; then
  echo "unexpected: check passed before fix" >&2
  exit 1
fi
cat red.log
failures="$(grep -c '^- ' red.log || true)"
type_errors="$(grep -c "got 'TypeError'" red.log || true)"
if [ "$failures" != "3" ] || [ "$type_errors" != "3" ]; then
  echo "unexpected failure reason: $failures failure lines, $type_errors TypeError lines" >&2
  exit 1
fi

echo "== 应用 solution.patch"
git apply "$here/solution.patch"

echo "== 绿：修复后他人读取返回 403"
python3 -B probe.py 403

echo "== 绿：修复后仓库自带检查通过"
python3 -B check_orders.py

echo "== 绿：独立验收通过"
python3 -B "$here/acceptance.py" "$work"

expect_rejected() {
  local name="$1"
  local dir="$2"
  shift 2
  if python3 -B "$here/acceptance.py" "$dir" >"$dir/rejected.log" 2>&1; then
    echo "unexpected: acceptance passed $name" >&2
    cat "$dir/rejected.log" >&2
    exit 1
  fi
  for label in "$@"; do
    if ! grep -qF -- "$label" "$dir/rejected.log"; then
      echo "unexpected: $name missing failure label: $label" >&2
      cat "$dir/rejected.log" >&2
      exit 1
    fi
  done
  cat "$dir/rejected.log"
  echo "== 负向通过：$name 被拒绝"
}

new_bypass() {
  local name="$1"
  local dir="$bypass_root/$name"
  mkdir -p "$dir"
  cp -R "$here/initial/." "$dir/"
  printf '%s' "$dir"
}

echo "== 负向：省略身份的实现必须被独立验收拒绝"
bypass="$(new_bypass identity-omitting)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id=None):
    order = find_order(order_id)
    if order is None:
        return None
    if current_user_id is not None and order["owner_id"] != current_user_id:
        raise PermissionError("order is not owned by the current user")
    return order
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "identity-omitting" "$bypass" \
  "missing identity does not read order" \
  "none identity does not read order" \
  "missing request identity does not read order" \
  "none request identity does not read order"

echo "== 负向：缺失身份时返回订单标量的实现必须被拒绝"
bypass="$(new_bypass scalar-leak)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order

_MISSING = object()


def get_order(order_id, current_user_id=_MISSING):
    order = find_order(order_id)
    if current_user_id is _MISSING or current_user_id in (None, ""):
        return order["total"] if order is not None else None
    if order is None or order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "scalar-leak" "$bypass" \
  "missing identity does not read order" \
  "none identity does not read order" \
  "empty identity does not read order" \
  "missing request identity does not read order" \
  "none request identity does not read order" \
  "empty request identity does not read order"

echo "== 负向：缺失身份时返回变形嵌套字段的实现必须被拒绝"
bypass="$(new_bypass transformed-leak)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id=None):
    order = find_order(order_id)
    if not current_user_id:
        return {"total": order["total"] + 1} if order is not None else None
    if order is None or order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "transformed-leak" "$bypass" \
  "missing identity does not read order" \
  "none identity does not read order" \
  "empty identity does not read order" \
  "missing request identity does not read order" \
  "none request identity does not read order" \
  "empty request identity does not read order"

echo "== 负向：缺失身份时把订单值嵌进错误文本的实现必须被拒绝"
bypass="$(new_bypass text-leak)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id=None):
    if not current_user_id:
        return {"message": "denied for o1 total 120"}
    order = find_order(order_id)
    if order is None or order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "text-leak" "$bypass" \
  "missing identity does not read order" \
  "none identity does not read order" \
  "empty identity does not read order" \
  "missing request identity does not read order" \
  "none request identity does not read order" \
  "empty request identity does not read order"

echo "== 负向：把 user_id 当 admin 角色的实现必须被拒绝"
bypass="$(new_bypass admin-user-id)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id):
    order = find_order(order_id)
    if order is None:
        return None
    if current_user_id == "admin" or order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order


def export_order(order_id, operator):
    return get_order(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request["user_id"])
    except (KeyError, PermissionError):
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "admin-user-id" "$bypass" \
  "admin user_id is not owner in get_order" \
  "admin user_id 403 in handle_show_order"

echo "== 负向：硬编码 u1 所有权的实现必须被拒绝"
bypass="$(new_bypass hardcoded-u1)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id):
    order = find_order(order_id)
    if order is None:
        return None
    if current_user_id == "u1":
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request["user_id"])
    except (KeyError, PermissionError):
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "hardcoded-u1" "$bypass" \
  "second owner reads own order" \
  "first user denied on second order" \
  "second owner 200" \
  "first user 403 on second order"

echo "== 负向：硬编码固定订单与用户的映射必须被拒绝"
bypass="$(new_bypass hardcoded-owner-map)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order

OWNERS = {"o1": "u1", "o2": "u2"}


def get_order(order_id, current_user_id=None):
    if not current_user_id:
        raise PermissionError("missing identity")
    if order_id not in OWNERS:
        return None
    if OWNERS[order_id] != current_user_id:
        raise PermissionError("order is not owned by the current user")
    return find_order(order_id)


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request.get("user_id"))
    except PermissionError:
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "hardcoded-owner-map" "$bypass" \
  "dynamic owner reads own order" \
  "dynamic other user denied" \
  "dynamic owner 200" \
  "dynamic other user 403" \
  "previous owner denied after ownership change" \
  "o1 previous owner denied after ownership change"

echo "== 负向：缺少角色校验的导出实现必须被拒绝"
bypass="$(new_bypass missing-role-export)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id):
    order = find_order(order_id)
    if order is None or order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role and operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request["user_id"])
    except (KeyError, PermissionError):
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "missing-role-export" "$bypass" \
  "missing role export denied" \
  "none role export denied"

echo "== 负向：空字符串身份可绕过校验的实现必须被拒绝"
bypass="$(new_bypass empty-identity)"
cat >"$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id):
    order = find_order(order_id)
    if order is None:
        return None
    if current_user_id == "":
        return order
    if order["owner_id"] == current_user_id:
        return order
    raise PermissionError("order is not owned by the current user")


def get_order_for_export(order_id, operator_role):
    if operator_role != "admin":
        raise PermissionError("export requires admin role")
    return find_order(order_id)
PY
cat >"$bypass/app/admin.py" <<'PY'
from app.orders import get_order_for_export


def export_order(order_id, operator):
    return get_order_for_export(order_id, operator.get("role"))
PY
cat >"$bypass/app/api.py" <<'PY'
from app.orders import get_order


def handle_show_order(request, order_id):
    try:
        order = get_order(order_id, request["user_id"])
    except (KeyError, PermissionError):
        return {"status": 403}
    if order is None:
        return {"status": 404}
    return {"status": 200, "order": order}
PY
expect_rejected "empty-identity" "$bypass" \
  "empty identity does not read order" \
  "empty request identity does not read order"

leftovers="$(find "$work" "$bypass_root" \( -name '__pycache__' -o -name '*.pyc' \) -print -quit)"
if [ -n "$leftovers" ]; then
  echo "unexpected: bytecode artifact created: $leftovers" >&2
  exit 1
fi
echo "== 通过：未生成 __pycache__ 或 .pyc"
