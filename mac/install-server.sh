#!/bin/bash
set -euo pipefail

LABEL="com.lanternshare.server"
DOMAIN="gui/$(id -u)"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="$(command -v node || true)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
DATA_DIR="$HOME/.lantern-share"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js was not found. Install Node.js 20 or newer, open a new Terminal, then retry." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Lantern Share requires Node.js 20 or newer; found $("$NODE_BIN" --version)." >&2
  exit 1
fi

xml_escape() {
  local value="$1"
  value=${value//&/\&amp;}
  value=${value//</\&lt;}
  value=${value//>/\&gt;}
  value=${value//\"/\&quot;}
  value=${value//\'/\&apos;}
  printf '%s' "$value"
}

NODE_XML="$(xml_escape "$NODE_BIN")"
ROOT_XML="$(xml_escape "$PROJECT_ROOT")"
DATA_XML="$(xml_escape "$DATA_DIR")"
mkdir -p "$PLIST_DIR" "$DATA_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$ROOT_XML/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT_XML</string>
  <key>EnvironmentVariables</key>
  <dict><key>SHARE_DIR</key><string>$DATA_XML</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA_XML/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DATA_XML/launchd.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST_PATH"
plutil -lint "$PLIST_PATH"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl enable "$DOMAIN/$LABEL"
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Lantern Share is running and will start when this Mac user logs in."
echo "PIN and server log: $DATA_DIR/join-pin.txt and $DATA_DIR/server.log"
echo "LaunchAgent: $PLIST_PATH"
echo "Open http://localhost:8787 on this Mac. Use the private IPv4 address printed in server.log on other devices."
