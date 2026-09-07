#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/Library/Application Support/FortuneoLunchMoneySync"
HOST_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sylvaindurand.fortuneo_lunchmoney_sync.json"
SERVICE="com.sylvaindurand.fortuneo-lunchmoney-sync"

if [[ "$INSTALL_DIR" != "$HOME/Library/Application Support/FortuneoLunchMoneySync" ]]; then
  echo "Refusing unexpected uninstall target" >&2
  exit 2
fi

rm -rf "$INSTALL_DIR"
rm -f "$HOST_MANIFEST"
for account in lunch-money-api-token identity-hmac-key lunch-money-checking-account-id fortuneo-login-credentials fortuneo-account-urls; do
  /usr/bin/security delete-generic-password -s "$SERVICE" -a "$account" >/dev/null 2>&1 || true
done

echo "Removed this integration's native registration, installed files, and Keychain entries."
echo "Remove the unpacked extension separately from chrome://extensions."
