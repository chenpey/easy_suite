#!/usr/bin/env bash
# Thin wrapper: the deterministic re-verification lives in verify.py.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$(dirname "$0")/verify.py" "$@"
