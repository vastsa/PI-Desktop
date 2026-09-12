#!/usr/bin/env bash
# Verify that one native macOS release package is Developer ID-signed,
# notarized, and stapled before it can be published.

set -euo pipefail

RELEASE_DIR="${1:-apps/desktop/release}"
PRODUCT_NAME="PI-Desktop"

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "error: release directory does not exist: $RELEASE_DIR" >&2
  exit 1
fi

shopt -s nullglob
APPS=("$RELEASE_DIR"/mac*/"$PRODUCT_NAME".app)
DMGS=("$RELEASE_DIR"/*.dmg)

if [[ "${#APPS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one $PRODUCT_NAME.app under $RELEASE_DIR/mac*/." >&2
  exit 1
fi

if [[ "${#DMGS[@]}" -ne 1 ]]; then
  echo "error: expected exactly one DMG under $RELEASE_DIR/." >&2
  exit 1
fi

APP="${APPS[0]}"
DMG="${DMGS[0]}"

echo "==> Inspecting Developer ID signature: $APP"
SIGNATURE_INFO="$(codesign -dv --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$SIGNATURE_INFO"
if [[ "$SIGNATURE_INFO" != *"Authority=Developer ID Application:"* ]]; then
  echo "error: $APP is not signed with a Developer ID Application certificate." >&2
  exit 1
fi

echo "==> Verifying code-signing integrity: $APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Assessing Gatekeeper notarization: $APP"
ASSESSMENT="$(spctl -a -vv "$APP" 2>&1)"
printf '%s\n' "$ASSESSMENT"
if [[ "$ASSESSMENT" != *"source=Notarized Developer ID"* ]]; then
  echo "error: Gatekeeper did not recognize $APP as notarized." >&2
  exit 1
fi

echo "==> Validating stapled notarization tickets"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo "==> macOS release verification passed: $APP and $DMG"
