#!/bin/bash
#
# macOS `codesign` timing shim.
#
# Why this exists: @electron/osx-sign signs a bundle by invoking `codesign` once
# per file, strictly serially, and prints nothing per file unless
# `DEBUG=electron-osx-sign*` is set (that debug stream is enormous). When signing
# looks like it hung - the electron-builder output stops after
# `• signing file=... identifyName=...` - the only cheap way to see which file
# is being worked on, and that `builder-util` is silently retrying a failed call,
# is to time the calls ourselves.
#
# This script is meant to be injected in front of the real `codesign` through
# PATH (see scripts/macos-signing-watchdog.mjs). It appends tab separated
# start/end records to $PI_CODESIGN_LOG and then behaves exactly like the real
# tool: stdout, stderr and the exit status pass through untouched, and with the
# log unset it does nothing but one `exec`.
#
# Environment:
#   PI_CODESIGN_LOG    Append timing records here. Unset or empty disables the
#                      shim completely (single exec, no log I/O, no overhead).
#   PI_CODESIGN_REAL   Absolute path of the real codesign
#                      (default: /usr/bin/codesign).
#
# Never prints its arguments: `--keychain <path>` would be noise and
# `--password <value>` would be a secret. Credential-looking values are replaced
# with [redacted] before they reach the log file.

set -u

PI_CODESIGN_REAL_PATH="${PI_CODESIGN_REAL:-/usr/bin/codesign}"
PI_CODESIGN_LOG_PATH="${PI_CODESIGN_LOG:-}"

if [ -z "$PI_CODESIGN_LOG_PATH" ]; then
  exec "$PI_CODESIGN_REAL_PATH" "$@"
fi

# Wall clock seconds with millisecond resolution. `perl` ships with macOS, but
# the shim must keep working (with second resolution) when it is unavailable, so
# every fallback is checked and none of them may fail the call.
pi_now() {
  local value=""
  if command -v perl >/dev/null 2>&1; then
    value="$(perl -MTime::HiRes=time -e 'printf "%.3f\n", time' 2>/dev/null)" || value=""
    case "$value" in
      [0-9]*.[0-9]*) printf '%s\n' "$value"; return 0 ;;
    esac
  fi
  if command -v date >/dev/null 2>&1; then
    value="$(date +%s 2>/dev/null)" || value=""
    case "$value" in
      [0-9]*) printf '%s\n' "$value"; return 0 ;;
    esac
  fi
  printf '%s\n' "${SECONDS:-0}"
}

pi_log() {
  # Never let a broken or unwritable log path disturb codesign: stderr is
  # silenced before the file is opened, so even the redirection error is
  # swallowed instead of leaking into the build output.
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" 2>/dev/null >> "$PI_CODESIGN_LOG_PATH" || true
}

# Join argv with single spaces, drop newlines/tabs (they would forge log lines)
# and redact credential-looking values.
pi_redacted_args() {
  local joined="" first=1 arg value redact_next=0
  for arg in "$@"; do
    value="$arg"
    if [ "$redact_next" -eq 1 ]; then
      value="[redacted]"
      redact_next=0
    else
      case "$arg" in
        --password | --keychain-password | -p) redact_next=1 ;;
        --password=* | --keychain-password=*) value="${arg%%=*}=[redacted]" ;;
      esac
    fi
    value="${value//$'\n'/ }"
    value="${value//$'\r'/ }"
    value="${value//$'\t'/ }"
    if [ "$first" -eq 1 ]; then
      joined="$value"
      first=0
    else
      joined="$joined $value"
    fi
  done
  printf '%s' "$joined"
}

pi_log "start" "$(pi_now)" "$$" "$(pi_redacted_args "$@")"

"$PI_CODESIGN_REAL_PATH" "$@"
PI_CODESIGN_STATUS=$?

pi_log "end" "$(pi_now)" "$$" "$PI_CODESIGN_STATUS"

exit "$PI_CODESIGN_STATUS"
