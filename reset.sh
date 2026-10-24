#!/usr/bin/env bash
set -euo pipefail

# The root script knows no project names: it forwards to whichever project
# directory owns a reset.sh. Project-specific reset logic lives in that project.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

available() {
  find "$root" -mindepth 2 -maxdepth 2 -name reset.sh -not -path "$root/reset.sh" 2>/dev/null \
    | sed -e "s|^$root/||" -e 's|/reset\.sh$||' | sort | tr '\n' ' ' | sed 's/ $//'
}

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  cat <<USAGE
Usage:
  bash reset.sh <project> --local
  bash reset.sh <project> --remote

<project>  Directory that owns reset.sh. Available: $(available)

Local mode deletes the project's .wrangler/state and keeps .dev.vars.
Remote mode clears the project's Cloudflare D1/R2 data and removes its Worker.
USAGE
  [ $# -ge 1 ] && exit 0
  exit 1
fi

name="$1"
shift
script="$root/$name/reset.sh"

if [ ! -f "$script" ]; then
  printf 'Reset: %s does not own a reset script. Available: %s\n' "$name" "$(available)" >&2
  exit 1
fi

exec bash "$script" "$@"
