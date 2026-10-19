#!/usr/bin/env bash
# B30 可复现夹具：初始版本执行检查应失败（红），应用 solution.patch 后应通过（绿）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -R "$here/initial/." "$work/"
cd "$work"
git init -q
git add -A
git -c user.email=fixture@example.com -c user.name=fixture commit -qm "b30 initial"

echo "== 初始状态：不带身份参数即可读取他人订单"
python3 - <<'PY'
from app.orders import get_order

print(get_order("o1"))
PY

echo "== 红：初始检查应失败"
if python3 check_orders.py; then
  echo "unexpected: check passed before fix" >&2
  exit 1
fi

echo "== 应用 solution.patch"
git apply "$here/solution.patch"

echo "== 绿：修复后检查应通过"
python3 check_orders.py
