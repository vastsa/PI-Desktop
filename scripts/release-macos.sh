#!/usr/bin/env bash
# Release build for native macOS: signed + notarized DMG/ZIP.
#
# Local default (`pnpm --filter @pi-desktop/desktop dist`) stays unsigned
# (identity: null in package.json). This script injects a real signing
# identity and enables notarization, both from environment variables:
#
#   MAC_SIGNING_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID               Apple ID email for notarization
#   APPLE_APP_SPECIFIC_PASSWORD  app-specific password for the Apple ID
#   APPLE_TEAM_ID          Apple Developer Team ID
#   MAC_ARCH               optional `arm64` or `x64`; must match the host
#
# See docs/spec/06-delivery/06-release-runbook.md for the full runbook.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: scripts/release-macos.sh must run on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) DEFAULT_MAC_ARCH=arm64 ;;
  x86_64) DEFAULT_MAC_ARCH=x64 ;;
  *)
    echo "error: unsupported macOS runner architecture: $(uname -m)." >&2
    exit 1
    ;;
esac

MAC_ARCH="${MAC_ARCH:-$DEFAULT_MAC_ARCH}"
case "$MAC_ARCH" in
  arm64|x64) ;;
  *)
    echo "error: MAC_ARCH must be arm64 or x64 (got: $MAC_ARCH)." >&2
    exit 1
    ;;
esac

if [[ "$MAC_ARCH" != "$DEFAULT_MAC_ARCH" ]]; then
  echo "error: MAC_ARCH=$MAC_ARCH requires a native $MAC_ARCH macOS runner; this host is $DEFAULT_MAC_ARCH." >&2
  exit 1
fi

if [[ -z "${MAC_SIGNING_IDENTITY:-}" ]]; then
  echo "error: MAC_SIGNING_IDENTITY is not set." >&2
  echo "For an unsigned local build use: pnpm --filter @pi-desktop/desktop dist" >&2
  exit 1
fi

NOTARIZE_ARGS=()
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "==> Notarization credentials found; notarization enabled."
  NOTARIZE_ARGS=(-c.mac.notarize=true)
else
  echo "==> Notarization credentials missing (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)." >&2
  echo "    Building signed but NOT notarized DMG." >&2
fi

echo "==> Building host-core (release)"
cargo build -p host-core --release

echo "==> Building workspace packages"
pnpm -r --filter '!@pi-desktop/desktop' build

echo "==> Building + packaging desktop (signed, $MAC_ARCH)"
pnpm --filter @pi-desktop/desktop exec electron-vite build
pnpm --filter @pi-desktop/desktop exec electron-builder --mac "--${MAC_ARCH}" \
  -c.mac.identity="${MAC_SIGNING_IDENTITY}" \
  "${NOTARIZE_ARGS[@]}"

echo "==> Done. Artifacts in apps/desktop/release/"
