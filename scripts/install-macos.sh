#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSION_ID="${1:-}"
EXTENSION_DIR="$ROOT_DIR/dist/extension"
INSTALL_DIR="$HOME/Library/Application Support/FortuneoLunchMoneySync"
HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="$HOST_DIR/com.sylvaindurand.fortuneo_lunchmoney_sync.json"
NODE_BIN="$(command -v node)"

cd "$ROOT_DIR"
npm run build

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Build complete. In Chrome, open chrome://extensions, enable Developer mode, and Load unpacked:"
  echo "$EXTENSION_DIR"
  echo "Then rerun: npm run install:local -- <extension-id>"
  exit 0
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "The Chrome extension ID must contain exactly 32 letters from a to p." >&2
  exit 2
fi

mkdir -p "$INSTALL_DIR/app" "$INSTALL_DIR/node_modules" "$HOST_DIR"
cp -R "$ROOT_DIR/dist/packages" "$INSTALL_DIR/app/"
cp -R "$ROOT_DIR/node_modules/@lunch-money" "$INSTALL_DIR/node_modules/"
cp -R "$ROOT_DIR/node_modules/openapi-fetch" "$INSTALL_DIR/node_modules/"
cp -R "$ROOT_DIR/node_modules/openapi-typescript-helpers" "$INSTALL_DIR/node_modules/"

cat > "$INSTALL_DIR/host" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$INSTALL_DIR/app/packages/native-host/src/main.js"
EOF
chmod 700 "$INSTALL_DIR/host"

cat > "$HOST_MANIFEST" <<EOF
{
  "name": "com.sylvaindurand.fortuneo_lunchmoney_sync",
  "description": "Local Fortuneo to Lunch Money sync host",
  "path": "$INSTALL_DIR/host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
chmod 600 "$HOST_MANIFEST"

echo "Installed the native host for extension $EXTENSION_ID. Restart Chrome once."
echo "The unpacked extension remains at: $EXTENSION_DIR"
