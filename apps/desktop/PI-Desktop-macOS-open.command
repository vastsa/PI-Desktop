#!/bin/bash
# Open a trusted unsigned PI-Desktop installation on macOS.
#
# This helper removes only Apple's quarantine attribute from the known
# application locations. It never uses sudo and never accepts an arbitrary
# path, so it cannot be used to clear quarantine from another application.

set -euo pipefail

readonly APP_BUNDLE_NAME="PI-Desktop.app"
readonly EXPECTED_BUNDLE_ID="com.pi-desktop.app"

show_alert() {
  local title="$1"
  local message="$2"

  if ! /usr/bin/osascript - "$title" "$message" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display alert (item 1 of argv) message (item 2 of argv) as critical
end run
APPLESCRIPT
  then
    printf '%s: %s\n' "$title" "$message" >&2
  fi
}

app_path=""
app_candidates=("/Applications/${APP_BUNDLE_NAME}")
if [[ -n "${HOME:-}" ]]; then
  app_candidates+=("${HOME}/Applications/${APP_BUNDLE_NAME}")
fi

for candidate in "${app_candidates[@]}"; do
  if [[ -d "$candidate" ]]; then
    app_path="$candidate"
    break
  fi
done

if [[ -z "$app_path" ]]; then
  show_alert \
    "PI-Desktop is not installed" \
    "Drag PI-Desktop.app to Applications, then double-click this helper again."
  exit 1
fi

bundle_identifier=""
if [[ -f "$app_path/Contents/Info.plist" ]]; then
  bundle_identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app_path/Contents/Info.plist" 2>/dev/null || true)"
fi
if [[ "$bundle_identifier" != "$EXPECTED_BUNDLE_ID" ]]; then
  show_alert \
    "This is not a PI-Desktop app" \
    "The helper only opens the official PI-Desktop bundle."
  exit 1
fi

# A downloaded unsigned app can carry quarantine on the bundle and on nested
# files. Remove only that attribute, preserving every other extended attribute.
quarantine_attributes="$(/usr/bin/xattr -r -l "$app_path" 2>/dev/null || true)"
if [[ "$quarantine_attributes" == *"com.apple.quarantine"* ]]; then
  if ! /usr/bin/xattr -r -d com.apple.quarantine "$app_path"; then
    show_alert \
      "PI-Desktop could not be opened" \
      "macOS could not clear the quarantine attribute. Try moving the app to Applications and run this helper again."
    exit 1
  fi
fi

/usr/bin/open "$app_path"
