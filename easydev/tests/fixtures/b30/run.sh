#!/usr/bin/env bash
# B30 可复现夹具：初始版本必须按预期失败（红），应用 solution.patch 后通过（绿），
# 最后用独立验收脚本复核，避免只依赖被测仓库自带的 check_orders.py。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
bypass=""
trap 'rm -rf "$work" ${bypass:+"$bypass"}' EXIT

cp -R "$here/initial/." "$work/"
cd "$work"
git init -q
git add -A
git -c user.email=fixture@example.com -c user.name=fixture commit -qm "b30 initial"

echo "== 红：初始代码缺少所有权校验，他人读取返回 200"
python3 probe.py 200

echo "== 红：初始检查必须因目标契约缺失（TypeError）失败，且失败行恰好 3 条"
if python3 check_orders.py >red.log 2>&1; then
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
python3 probe.py 403

echo "== 绿：修复后仓库自带检查通过"
python3 check_orders.py

echo "== 绿：独立验收通过"
python3 "$here/acceptance.py" "$work"

echo "== 负向：省略身份的伪修复必须被独立验收拒绝"
bypass="$(mktemp -d)"
cp -R "$here/initial/." "$bypass/"
cat > "$bypass/app/orders.py" <<'PY'
from app.db import find_order


def get_order(order_id, current_user_id=None):
    order = find_order(order_id)
    if order is None:
        return None
    if current_user_id is not None and order["owner_id"] != current_user_id:
        raise PermissionError("order is not owned by the current user")
    return order
PY
cat > "$bypass/app/api.py" <<'PY'
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
if python3 "$here/acceptance.py" "$bypass" >bypass.log 2>&1; then
  echo "unexpected: acceptance passed an identity-omitting implementation" >&2
  exit 1
fi
failures="$(grep -c '^- ' bypass.log || true)"
if [ "$failures" != "3" ]; then
  echo "unexpected: expected 3 bypass failures, got $failures" >&2
  cat bypass.log >&2
  exit 1
fi
for label in \
  "missing identity does not read order" \
  "none identity does not read order" \
  "missing request identity does not read order"; do
  if ! grep -qF "$label" bypass.log; then
    echo "unexpected: bypass missing failure label: $label" >&2
    cat bypass.log >&2
    exit 1
  fi
done
cat bypass.log
echo "== 负向通过：伪修复被拒绝"
