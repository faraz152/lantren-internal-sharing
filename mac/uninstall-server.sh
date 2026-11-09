#!/bin/bash
set -euo pipefail

LABEL="com.lanternshare.server"
DOMAIN="gui/$(id -u)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
fi

echo "Lantern Share's Mac startup agent was removed. Shared files and the PIN were left in $HOME/.lantern-share."
