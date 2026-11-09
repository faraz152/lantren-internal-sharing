#!/usr/bin/env bash
set -euo pipefail

LABEL="lantern-share.service"
UNIT_PATH="$HOME/.config/systemd/user/$LABEL"

systemctl --user disable --now "$LABEL" >/dev/null 2>&1 || true
rm -f -- "$UNIT_PATH"
systemctl --user daemon-reload
systemctl --user reset-failed "$LABEL" >/dev/null 2>&1 || true

echo "Lantern Share's Linux service was removed. Shared files and the PIN remain in $HOME/.lantern-share."
echo "System linger was left unchanged because other user services may rely on it."
