#!/usr/bin/env bash
# Verify that one native macOS release package is Developer ID-signed,
# notarized, and stapled before it can be published.

set -euo pipefail

RELEASE_DIR="${1:-apps/desktop/release}"
PRODUCT_NAME="PI-Desktop"
# Accepts either the bare common name ("XingYu Liu (DUV63RKYTW)") or the full
# certificate label ("Developer ID Application: XingYu Liu (DUV63RKYTW)").
IDENTITY_NAME="${MAC_SIGNING_IDENTITY:-XingYu Liu (DUV63RKYTW)}"
IDENTITY_NAME="${IDENTITY_NAME#Developer ID Application: }"
EXPECTED_IDENTITY="Developer ID Application: ${IDENTITY_NAME}"

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
HOST_CORE="$APP/Contents/Resources/bin/pi-desktop-host-core"

echo "==> Inspecting Developer ID signature: $APP"
SIGNATURE_INFO="$(codesign -dv --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$SIGNATURE_INFO"
if [[ "$SIGNATURE_INFO" != *"Authority=${EXPECTED_IDENTITY}"* ]]; then
  echo "error: $APP is not signed with $EXPECTED_IDENTITY." >&2
  exit 1
fi
if [[ "$SIGNATURE_INFO" != *"flags=0x10000(runtime)"* && "$SIGNATURE_INFO" != *"flags=runtime"* && "$SIGNATURE_INFO" != *"runtime"* ]]; then
  echo "warning: hardened runtime flag not found in codesign -dv output; continuing with --deep --strict."
fi

echo "==> Verifying code-signing integrity: $APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [[ -f "$HOST_CORE" ]]; then
  echo "==> Verifying host-core sidecar signature: $HOST_CORE"
  codesign --verify --strict --verbose=2 "$HOST_CORE"
else
  echo "error: missing host-core sidecar at $HOST_CORE" >&2
  exit 1
fi

echo "==> Assessing Gatekeeper notarization: $APP"
ASSESSMENT="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$ASSESSMENT"
if [[ "$ASSESSMENT" != *"source=Notarized Developer ID"* ]]; then
  echo "error: Gatekeeper did not recognize $APP as notarized." >&2
  exit 1
fi

echo "==> Validating stapled notarization tickets"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo "==> macOS release verification passed: $APP and $DMG"
