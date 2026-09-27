#!/usr/bin/env bash
set -euo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '需要 Python 3.9+。macOS：安装 python.org 的 Python 3，之后原命令重试；无需 pip 安装。' >&2
  exit 1
fi
exec python3 "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/newapi.py" "$@"
