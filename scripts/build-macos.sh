#!/usr/bin/env bash
# Build local macOS app/DMG/ZIP artifacts from this checkout.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19+ is required. Install Node.js, then reopen Terminal." >&2
  exit 1
fi
exec node "$SCRIPT_DIR/build-platform-app.mjs" mac "$@"
