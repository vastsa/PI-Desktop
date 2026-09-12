#!/usr/bin/env bash
# Attach Apple's notarization ticket to the one DMG built by a native macOS job.

set -euo pipefail

RELEASE_DIR="${1:-apps/desktop/release}"

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "error: release directory does not exist: $RELEASE_DIR" >&2
  exit 1
fi

shopt -s nullglob
DMGS=("$RELEASE_DIR"/*.dmg)

if [[ "${#DMGS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one DMG under $RELEASE_DIR/." >&2
  exit 1
fi

DMG="${DMGS[0]}"
echo "==> Stapling notarization ticket to $DMG"
xcrun stapler staple "$DMG"
