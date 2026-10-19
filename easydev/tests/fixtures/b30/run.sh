#!/usr/bin/env bash
# B30 可复现夹具：初始版本必须按预期失败（红），应用 solution.patch 后通过（绿），
# 最后用独立验收脚本复核，避免只依赖被测仓库自带的 check_orders.py。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -R "$here/initial/." "$work/"
cd "$work"
git init -q
git add -A
git -c user.email=fixture@example.com -c user.name=fixture commit -qm "b30 initial"

echo "== 红：初始代码缺少所有权校验，他人读取返回 200"
python3 probe.py 200

echo "== 红：初始检查必须因目标契约缺失（TypeError）失败"
if python3 check_orders.py >red.log 2>&1; then
  echo "unexpected: check passed before fix" >&2
  exit 1
fi
count="$(grep -c "got 'TypeError'" red.log || true)"
cat red.log
if [ "$count" != "3" ]; then
  echo "unexpected failure reason: expected 3 TypeError failures, got $count" >&2
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
