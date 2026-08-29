#!/usr/bin/env bash
#
# Runs the T3rnel session bridge against a browser on a virtual display.
#
# Why not headless: headless Chrome is a distinct browser to the fingerprinting that
# guards the sites worth researching, and it is precisely the shape they refuse. A real
# browser on an X server with no monitor attached is not detected as headless, and it
# keeps the profile, the extension and the logged-in sessions. The cost is one Xvfb
# process.
#
#   ./scripts/virtual-display.sh                 # start Xvfb and run the bridge on it
#   ./scripts/virtual-display.sh -- node foo.js  # run something else on the display
#
set -euo pipefail

DISPLAY_NUM="${T3RNEL_DISPLAY_NUM:-99}"
GEOMETRY="${T3RNEL_DISPLAY_GEOMETRY:-1920x1080x24}"

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "Xvfb is not installed. On Debian/Ubuntu: sudo apt-get install -y xvfb" >&2
  exit 1
fi

# Reuse a display that is already up rather than colliding with it.
if [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "Display :${DISPLAY_NUM} is already running; using it." >&2
  XVFB_PID=""
else
  Xvfb ":${DISPLAY_NUM}" -screen 0 "${GEOMETRY}" -nolisten tcp >/dev/null 2>&1 &
  XVFB_PID=$!
  # Wait for the socket rather than sleeping a guessed interval.
  for _ in $(seq 1 50); do
    [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
    sleep 0.1
  done
  if [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
    echo "Xvfb did not come up on :${DISPLAY_NUM}" >&2
    exit 1
  fi
  trap '[ -n "${XVFB_PID}" ] && kill "${XVFB_PID}" 2>/dev/null || true' EXIT
fi

export DISPLAY=":${DISPLAY_NUM}"
export T3RNEL_SESSION_DISPLAY=":${DISPLAY_NUM}"
export T3RNEL_SESSION_MODE="${T3RNEL_SESSION_MODE:-standalone}"

if [ "${1:-}" = "--" ]; then
  shift
  exec "$@"
fi

cd "$(dirname "$0")/.."
exec node src/server.js
