#!/bin/zsh

emulate -L zsh
set -euo pipefail

PROJECT_DIR="${0:A:h:h}"
SOURCE="$PROJECT_DIR/web/easymac-icon.svg"
OUTPUT="${1:-$PROJECT_DIR/build/EasyMac.icns}"
work_dir="$(/usr/bin/mktemp -d -t easymac-icon)"
iconset="$work_dir/EasyMac.iconset"
master="$work_dir/icon-1024.png"

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir -p -- "$iconset"

render_master() {
  local sips_log="$work_dir/sips.log"
  local quicklook_log="$work_dir/qlmanage.log"
  if /usr/bin/sips -s format png "$SOURCE" --out "$master" \
    >/dev/null 2>"$sips_log"; then
    return 0
  fi

  # Recent macOS versions may stop rendering SVG through sips. Quick Look is
  # the built-in fallback and keeps the build independent of extra tooling.
  local preview_dir="$work_dir/quicklook"
  local preview
  local ql_status=0
  /bin/mkdir -p "$preview_dir"
  if ! /usr/bin/qlmanage -t -s 1024 -o "$preview_dir" "$SOURCE" \
    >/dev/null 2>"$quicklook_log"; then
    ql_status=1
  fi
  preview="$preview_dir/${SOURCE:t}.png"
  if (( ql_status != 0 )) || [[ ! -s "$preview" ]]; then
    print -u2 -- "sips:"
    [[ ! -s "$sips_log" ]] || /bin/cat "$sips_log" >&2
    print -u2 -- "qlmanage:"
    [[ ! -s "$quicklook_log" ]] || /bin/cat "$quicklook_log" >&2
    return 1
  fi
  /bin/mv -- "$preview" "$master"
}

if ! render_master; then
  print -u2 -- "无法从 $SOURCE 生成 PNG 图标。"
  exit 1
fi

for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$master" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  /usr/bin/sips -z "$double_size" "$double_size" "$master" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

mkdir -p -- "${OUTPUT:h}"
/usr/bin/iconutil -c icns "$iconset" -o "$OUTPUT"
print -r -- "$OUTPUT"
