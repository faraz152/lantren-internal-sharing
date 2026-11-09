#!/usr/bin/env bash
set -euo pipefail

LABEL="lantern-share.service"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="$(command -v node || true)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$LABEL"
DATA_DIR="$HOME/.lantern-share"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 20 or newer was not found. Install Node.js, open a new Terminal, then retry." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Lantern Share requires Node.js 20 or newer; found $("$NODE_BIN" --version)." >&2
  exit 1
fi

systemd_quote() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}

NODE_ARG="$(systemd_quote "$NODE_BIN")"
SERVER_ARG="$(systemd_quote "$PROJECT_ROOT/server.js")"
WORK_DIR="$(systemd_quote "$PROJECT_ROOT")"
mkdir -p "$UNIT_DIR" "$DATA_DIR"

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Lantern Share private local network host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORK_DIR
Environment=SHARE_DIR=%h/.lantern-share
ExecStart=$NODE_ARG $SERVER_ARG
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$LABEL"

if command -v loginctl >/dev/null 2>&1; then
  LINGER="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [[ "$LINGER" != "yes" ]]; then
    echo "Enabling the user service at system boot (sudo may ask for your password)…"
    if command -v sudo >/dev/null 2>&1 && sudo loginctl enable-linger "$USER"; then
      echo "Lantern Share will start at boot, even before this user signs in."
    else
      echo "Lingering was not enabled. The service starts automatically after you sign in." >&2
    fi
  else
    echo "Lantern Share will start at boot, even before this user signs in."
  fi
fi

echo "Lantern Share systemd user service is enabled and running."
echo "Data and PIN: $DATA_DIR"
echo "Check service: systemctl --user status $LABEL"
echo "Open http://127.0.0.1:8787 here; use the private IPv4 printed in the service log on other devices."
