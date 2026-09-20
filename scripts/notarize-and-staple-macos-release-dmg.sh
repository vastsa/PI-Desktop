#!/usr/bin/env bash
# Notarize the final macOS DMG with Apple's notary service, then staple its
# ticket. Run after electron-builder produced the DMG.
#
# Why this exists: electron-builder's `mac.notarize=true` notarizes the built
# `PI-Desktop.app` (so the app and the ZIP that carries it pass Gatekeeper and
# in-app updates work). The DMG is a separate artifact with its own signature,
# so it needs its own notarytool submission before it can be stapled. Stapling a
# DMG that was never submitted fails with:
#
#   CloudKit query ... failed due to "Record not found".
#   Could not find base64 encoded ticket
#   The staple and validate action failed! Error 65.
#
# Required environment (never echoed, never written to the repo):
#   APPLE_ID                      Apple ID email in team DUV63RKYTW
#   APPLE_APP_SPECIFIC_PASSWORD   app-specific password for that Apple ID
#   APPLE_TEAM_ID                 must be DUV63RKYTW
#
# Usage: scripts/notarize-and-staple-macos-release-dmg.sh [release-dir]

set -euo pipefail

RELEASE_DIR="${1:-apps/desktop/release}"
EXPECTED_TEAM_ID="DUV63RKYTW"
# The ticket can take a moment to reach the stapler after Apple accepts, but a
# retry is only legal once the submission returned Accepted. Overridable so
# tests do not sleep for real.
STAPLE_ATTEMPTS="${STAPLE_ATTEMPTS:-6}"
STAPLE_DELAY_SECONDS="${STAPLE_DELAY_SECONDS:-10}"

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "error: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are required to notarize the DMG." >&2
  exit 1
fi

if [[ "$APPLE_TEAM_ID" != "$EXPECTED_TEAM_ID" ]]; then
  echo "error: APPLE_TEAM_ID must be $EXPECTED_TEAM_ID (got: $APPLE_TEAM_ID)." >&2
  exit 1
fi

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

# Explicit template: GNU `mktemp -t` rejects a name without X's, and BSD
# `mktemp -t` would append its own suffix. `TMPDIR` is set on macOS runners.
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/pi-desktop-notarytool-submit.XXXXXX")"
trap 'rm -f "$SUBMIT_LOG"' EXIT

# `notarytool log` needs the same credentials as `submit`; both are passed on
# the command line only, so they never appear in the job log.
notarytool_credentials=(
  --apple-id "$APPLE_ID"
  --password "$APPLE_APP_SPECIFIC_PASSWORD"
  --team-id "$APPLE_TEAM_ID"
)

print_notarization_log() {
  local submission_id="$1"
  if [[ -z "$submission_id" ]]; then
    echo "==> No submission id was returned, so no Apple notarization log is available." >&2
    return 0
  fi
  echo "==> Apple notarization log for submission $submission_id" >&2
  xcrun notarytool log "$submission_id" "${notarytool_credentials[@]}" >&2 \
    || echo "warning: could not fetch the Apple notarization log for $submission_id." >&2
}

echo "==> Submitting $DMG to the Apple notary service (waiting for the result)"
if ! xcrun notarytool submit "$DMG" "${notarytool_credentials[@]}" --wait >"$SUBMIT_LOG" 2>&1; then
  cat "$SUBMIT_LOG" >&2
  SUBMISSION_ID="$(sed -n 's/^[[:space:]]*id:[[:space:]]*//p' "$SUBMIT_LOG" | head -n1)"
  echo "error: notarytool submit failed for $DMG." >&2
  print_notarization_log "$SUBMISSION_ID"
  exit 1
fi
cat "$SUBMIT_LOG"

SUBMISSION_ID="$(sed -n 's/^[[:space:]]*id:[[:space:]]*//p' "$SUBMIT_LOG" | head -n1)"
NOTARY_STATUS="$(sed -n 's/^[[:space:]]*status:[[:space:]]*//p' "$SUBMIT_LOG" | tail -n1)"
if [[ -z "$NOTARY_STATUS" ]]; then
  NOTARY_STATUS="$(sed -n 's/^Current status:[[:space:]]*//p' "$SUBMIT_LOG" | tail -n1)"
fi
NOTARY_STATUS="${NOTARY_STATUS%%[. ]*}"
NOTARY_STATUS="${NOTARY_STATUS%"${NOTARY_STATUS##*[![:space:]]}"}"

echo "==> Apple notarization status for $DMG: ${NOTARY_STATUS:-unknown} (submission ${SUBMISSION_ID:-unknown})"

if [[ "$NOTARY_STATUS" != "Accepted" ]]; then
  echo "error: Apple did not accept $DMG (status: ${NOTARY_STATUS:-unknown})." >&2
  echo "A DMG that was never accepted cannot be stapled, so this run fails." >&2
  print_notarization_log "$SUBMISSION_ID"
  exit 1
fi

echo "==> Stapling the accepted notarization ticket to $DMG"
stapled=false
for attempt in $(seq 1 "$STAPLE_ATTEMPTS"); do
  if xcrun stapler staple "$DMG"; then
    stapled=true
    break
  fi
  if [[ "$attempt" -lt "$STAPLE_ATTEMPTS" ]]; then
    echo "warning: stapler attempt $attempt/$STAPLE_ATTEMPTS failed; retrying in ${STAPLE_DELAY_SECONDS}s." >&2
    sleep "$STAPLE_DELAY_SECONDS"
  fi
done

if [[ "$stapled" != "true" ]]; then
  echo "error: stapler could not attach the ticket to $DMG after $STAPLE_ATTEMPTS attempts." >&2
  exit 1
fi

echo "==> Validating the stapled ticket on $DMG"
xcrun stapler validate "$DMG"

echo "==> Staple validation passed: $DMG (status=Accepted)"
