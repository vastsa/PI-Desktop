#!/bin/bash
# Retry only the stapling operation after the caller has an accepted ticket.
# electron-notarize invokes this command only after notarytool reports Accepted.

set -u

PI_STAPLER_REAL_XCRUN="${PI_XCRUN_REAL:-/usr/bin/xcrun}"

if [[ "${1:-}" != "stapler" || "${2:-}" != "staple" || -z "${PI_STAPLER_MAX_ATTEMPTS:-}" ]]; then
  exec "$PI_STAPLER_REAL_XCRUN" "$@"
fi

PI_STAPLER_ATTEMPTS="$PI_STAPLER_MAX_ATTEMPTS"
PI_STAPLER_DELAY="${PI_STAPLER_RETRY_DELAY_SECONDS:-10}"

if [[ ! "$PI_STAPLER_ATTEMPTS" =~ ^[1-6]$ ]]; then
  echo "error: PI_STAPLER_MAX_ATTEMPTS must be between 1 and 6." >&2
  exit 2
fi

if [[ ! "$PI_STAPLER_DELAY" =~ ^[0-9]+$ ]] || (( PI_STAPLER_DELAY > 60 )); then
  echo "error: PI_STAPLER_RETRY_DELAY_SECONDS must be between 0 and 60." >&2
  exit 2
fi

PI_STAPLER_STATUS=1
for ((attempt = 1; attempt <= PI_STAPLER_ATTEMPTS; attempt += 1)); do
  if "$PI_STAPLER_REAL_XCRUN" "$@"; then
    exit 0
  else
    PI_STAPLER_STATUS=$?
  fi

  if (( attempt < PI_STAPLER_ATTEMPTS )); then
    echo "warning: stapler staple attempt $attempt/$PI_STAPLER_ATTEMPTS failed; retrying in ${PI_STAPLER_DELAY}s." >&2
    sleep "$PI_STAPLER_DELAY"
  fi
done

exit "$PI_STAPLER_STATUS"
