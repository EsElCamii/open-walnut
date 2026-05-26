#!/usr/bin/env bash
# Install / uninstall the Open Walnut watchdog LaunchAgent.
#
# Usage:
#   bash scripts/install-watchdog.sh install
#   bash scripts/install-watchdog.sh uninstall
#   bash scripts/install-watchdog.sh status

set -euo pipefail

LABEL="com.openwalnut.watchdog"
WALNUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$WALNUT_DIR/scripts/com.openwalnut.watchdog.plist"
TARGET="$HOME/Library/LaunchAgents/${LABEL}.plist"
WATCHDOG_SCRIPT="$WALNUT_DIR/scripts/walnut-watchdog.sh"

cmd="${1:-install}"

case "$cmd" in
  install)
    chmod +x "$WATCHDOG_SCRIPT"
    mkdir -p "$HOME/Library/LaunchAgents" /tmp/open-walnut

    # Substitute the absolute walnut dir into the template.
    sed "s|__WALNUT_DIR__|${WALNUT_DIR}|g" "$TEMPLATE" > "$TARGET"

    # Unload any previous version, then load fresh.
    launchctl unload "$TARGET" 2>/dev/null || true
    launchctl load "$TARGET"
    echo "installed: $TARGET"
    echo "watchdog will health-check http://localhost:3456/api/config every 30s"
    echo "logs: /tmp/open-walnut/watchdog.log  (server: /tmp/open-walnut/server.log)"
    ;;

  uninstall)
    if [ -f "$TARGET" ]; then
      launchctl unload "$TARGET" 2>/dev/null || true
      rm -f "$TARGET"
      echo "uninstalled: $TARGET"
    else
      echo "not installed"
    fi
    ;;

  status)
    echo "--- launchctl ---"
    launchctl list | grep "$LABEL" || echo "(not loaded)"
    echo
    echo "--- plist ---"
    [ -f "$TARGET" ] && echo "installed at $TARGET" || echo "(no plist at $TARGET)"
    echo
    echo "--- server ---"
    if curl -sf -m 2 http://localhost:3456/api/config >/dev/null 2>&1; then
      echo "server: UP on :3456"
    else
      echo "server: DOWN"
    fi
    echo
    echo "--- recent watchdog log ---"
    tail -n 10 /tmp/open-walnut/watchdog.log 2>/dev/null || echo "(no log yet)"
    ;;

  *)
    echo "usage: $0 {install|uninstall|status}" >&2
    exit 2
    ;;
esac
