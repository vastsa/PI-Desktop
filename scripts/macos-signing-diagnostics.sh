#!/usr/bin/env bash
# Record a non-sensitive snapshot of the macOS code-signing environment before
# electron-builder starts packaging.
#
# Why this exists: @electron/osx-sign walks the whole `PI-Desktop.app` and runs
# one `codesign --sign <identity> --force --timestamp --entitlements ...` per
# Mach-O file and per nested bundle, strictly serially. When a release signing
# step stalls, every interesting question is environmental: is a usable
# Developer ID identity in this keychain at all, which keychains are searched,
# is the Xcode toolchain complete, and can every `codesign` call reach Apple's
# timestamp service. Recording that baseline next to the build keeps the answer
# in the job log instead of in a rerun.
#
# Usage: scripts/macos-signing-diagnostics.sh [--require-identity]
#
# Environment:
#   MAC_SIGNING_IDENTITY   bare common name ("XingYu Liu (DUV63RKYTW)") or the
#                          full certificate label
#                          ("Developer ID Application: XingYu Liu (DUV63RKYTW)").
#
# Exit status:
#   0  snapshot printed. A missing certificate is only a warning by default:
#      the runner has no identity until electron-builder imports CSC_LINK.
#   1  not running on macOS, or --require-identity was passed and this keychain
#      has no matching Developer ID identity.
#
# Secret handling: this script never prints the values of CSC_LINK,
# CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD or APPLE_TEAM_ID, and
# it never dumps `env`. Every line produced by an external command is piped
# through `redact`, which rewrites those values (when set and at least 6
# characters long) to `[redacted]`. A value containing a newline cannot be
# represented as a sed pattern, so the snapshot suppresses command output
# instead of risking a leak.

set -euo pipefail

REQUIRE_IDENTITY=false
for arg in "$@"; do
  case "$arg" in
    --require-identity) REQUIRE_IDENTITY=true ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: scripts/macos-signing-diagnostics.sh [--require-identity]" >&2
      exit 1
      ;;
  esac
done

# Accepts either the bare common name or the full certificate label, matching
# scripts/verify-macos-release.sh.
IDENTITY_NAME="${MAC_SIGNING_IDENTITY:-XingYu Liu (DUV63RKYTW)}"
IDENTITY_NAME="${IDENTITY_NAME#Developer ID Application: }"
EXPECTED_IDENTITY="Developer ID Application: ${IDENTITY_NAME}"

if [[ "$(uname -s 2>/dev/null || true)" != "Darwin" ]]; then
  echo "error: macOS signing diagnostics must run on macOS." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------

REDACT_NAMES=(CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)
REDACT_SED=""
REDACT_UNSAFE=false

for redact_name in "${REDACT_NAMES[@]}"; do
  redact_value="${!redact_name:-}"
  # Short values would match unrelated text, so they are not used as patterns.
  if (( ${#redact_value} < 6 )); then
    continue
  fi
  if [[ "$redact_value" == *$'\n'* ]]; then
    REDACT_UNSAFE=true
    continue
  fi
  # Escape backslashes first, then every BRE metacharacter plus the delimiter,
  # so an arbitrary secret can be used as a literal sed pattern.
  redact_pattern="$(printf '%s' "$redact_value" | sed -e 's/\\/\\\\/g' -e 's/[/.[*^$]/\\&/g')"
  REDACT_SED="${REDACT_SED}s/${redact_pattern}/[redacted]/g"$'\n'
done

# Rewrite secret values in stdin to [redacted].
redact() {
  if [[ "$REDACT_UNSAFE" == "true" ]]; then
    echo "[output suppressed: a secret value could not be redacted]"
    return 0
  fi
  if [[ -z "$REDACT_SED" ]]; then
    cat
    return 0
  fi
  sed -e "$REDACT_SED"
}

# Echo one block of already-captured command output with secrets redacted. A
# redaction failure suppresses the block instead of printing it raw.
echo_redacted() {
  local text="$1"
  if [[ -z "$text" ]]; then
    return 0
  fi
  if ! printf '%s\n' "$text" | redact; then
    echo "warning: could not redact command output; suppressing it."
  fi
  return 0
}

# Run a command and echo its combined output, redacted. A missing or failing
# command only warns: this step must never break the release build.
echo_command_output() {
  local command_name="$1"
  shift
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "warning: $command_name unavailable"
    return 0
  fi
  local output status
  output="$("$command_name" "$@" 2>&1)" && status=0 || status=$?
  echo_redacted "$output"
  if [[ "$status" -ne 0 ]]; then
    echo "warning: $command_name $* exited with status $status"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 1. System
# ---------------------------------------------------------------------------

echo "==> System"
echo_command_output sw_vers
echo_command_output uname -a
echo_command_output uname -m

# ---------------------------------------------------------------------------
# 2. codesign
# ---------------------------------------------------------------------------

echo "==> codesign"
echo_command_output which codesign
CODESIGN_VERSION_STATUS=0
CODESIGN_VERSION_OUTPUT="$(codesign --version 2>&1)" || CODESIGN_VERSION_STATUS=$?
echo_redacted "$CODESIGN_VERSION_OUTPUT"
if [[ "$CODESIGN_VERSION_STATUS" -ne 0 ]]; then
  echo "warning: codesign --version exited with status $CODESIGN_VERSION_STATUS; some codesign builds only print their usage here."
fi

# ---------------------------------------------------------------------------
# 3. Code signing identities (only the output of find-identity is printed; no
#    certificate or private key material is ever read or dumped)
# ---------------------------------------------------------------------------

echo "==> Code signing identities (security find-identity -v -p codesigning)"
IDENTITY_OUTPUT=""
if command -v security >/dev/null 2>&1; then
  IDENTITY_STATUS=0
  IDENTITY_OUTPUT="$(security find-identity -v -p codesigning 2>&1)" || IDENTITY_STATUS=$?
  echo_redacted "$IDENTITY_OUTPUT"
  if [[ "$IDENTITY_STATUS" -ne 0 ]]; then
    echo "warning: security find-identity exited with status $IDENTITY_STATUS"
  fi
else
  echo "warning: security unavailable"
fi

# ---------------------------------------------------------------------------
# 4. Keychains
# ---------------------------------------------------------------------------

echo "==> Keychain"
echo_command_output security list-keychains
echo_command_output security default-keychain

# ---------------------------------------------------------------------------
# 5. Xcode toolchain
# ---------------------------------------------------------------------------

echo "==> Xcode toolchain"
echo_command_output xcrun --find notarytool
echo_command_output xcrun --find stapler

# ---------------------------------------------------------------------------
# 6. Apple timestamp service
#    `--timestamp` makes every single codesign invocation depend on this
#    endpoint, so a slow or unreachable service is a prime suspect for a stalled
#    signing phase. A failure here is informational only.
# ---------------------------------------------------------------------------

echo "==> Apple timestamp service (http://timestamp.apple.com/ts01)"
if command -v curl >/dev/null 2>&1; then
  CURL_STATUS=0
  CURL_OUTPUT="$(curl -s -o /dev/null --max-time 10 -w '%{http_code} %{time_total}\n' http://timestamp.apple.com/ts01 2>&1)" || CURL_STATUS=$?
  echo_redacted "$CURL_OUTPUT"
  if [[ "$CURL_STATUS" -ne 0 ]]; then
    echo "warning: Apple timestamp service probe failed (curl exit $CURL_STATUS); codesign --timestamp may be slow or fail."
  fi
else
  echo "warning: curl unavailable; cannot probe the Apple timestamp service."
fi

# ---------------------------------------------------------------------------
# 7. Conclusion
# ---------------------------------------------------------------------------

echo "==> Signing identity"
if [[ -n "$IDENTITY_OUTPUT" && "$IDENTITY_OUTPUT" == *"$EXPECTED_IDENTITY"* ]]; then
  echo "==> Developer ID identity available: ${EXPECTED_IDENTITY}"
  IDENTITY_LINE="$(printf '%s\n' "$IDENTITY_OUTPUT" | grep -F -- "$EXPECTED_IDENTITY" | head -n 1 || true)"
  echo_redacted "$IDENTITY_LINE"
else
  echo "warning: Developer ID Application: ${IDENTITY_NAME} is not available in the current keychain (electron-builder imports CSC_LINK during packaging)."
  if [[ "$REQUIRE_IDENTITY" == "true" ]]; then
    echo "error: Developer ID Application: ${IDENTITY_NAME} is not available in this keychain." >&2
    exit 1
  fi
fi

echo "==> macOS signing diagnostics complete"
