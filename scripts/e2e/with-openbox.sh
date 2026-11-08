#!/bin/sh
set -eu

openbox >/dev/null 2>&1 &
window_manager_pid=$!
trap 'kill "$window_manager_pid" 2>/dev/null || true; wait "$window_manager_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A live process is not yet an EWMH window manager: early maximize requests
# can be lost before Openbox claims the root window.
attempt=0
while [ "$attempt" -lt 100 ]; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[1-9a-fA-F]'; then
    "$@"
    exit
  fi
  if ! kill -0 "$window_manager_pid" 2>/dev/null; then
    echo 'Openbox exited before claiming the X11 display' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done

echo 'Openbox did not claim the X11 display within 10 seconds' >&2
exit 1
