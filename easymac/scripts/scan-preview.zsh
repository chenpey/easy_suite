#!/bin/zsh

emulate -L zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
WEB_DIR="$PROJECT_DIR/web"
SCANNER="$PROJECT_DIR/scripts/scan.zsh"
if (( $# > 0 )); then
  output_dir="$1"
  mkdir -p -- "${output_dir:h}"
  mkdir -- "$output_dir" || {
    print -u2 -- "输出目录必须不存在：$output_dir"
    exit 1
  }
else
  output_dir="$(/usr/bin/mktemp -d -t easymac-scan)"
fi

cp -R "$WEB_DIR/." "$output_dir/"
"$SCANNER" "$output_dir/data.js"

print -r -- "$output_dir/index.html"
