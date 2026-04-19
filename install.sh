#!/usr/bin/env bash
# install.sh — Install and register the live-translator Mac audio agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_PATH="$SCRIPT_DIR/daemon.js"
PLIST_NAME="com.live-translator.agent"
PLIST_TEMPLATE="$SCRIPT_DIR/$PLIST_NAME.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
CONFIG_DIR="$HOME/.config/live-translator-agent"
CONFIG_FILE="$CONFIG_DIR/config.json"
LOG_DIR="$HOME/Library/Logs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[install]${NC} $*"; }
warn()  { echo -e "${YELLOW}[install]${NC} $*"; }
error() { echo -e "${RED}[install]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

command -v brew >/dev/null 2>&1 || error "Homebrew not found. Install from https://brew.sh"

# Node.js
NODE_PATH="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ]; then
  log "Installing Node.js via Homebrew..."
  brew install node
  NODE_PATH="$(command -v node)"
fi
log "Node: $NODE_PATH ($(node --version))"

# sox — required by node-record-lpcm16 for mic capture
if ! command -v sox >/dev/null 2>&1; then
  log "Installing sox via Homebrew..."
  brew install sox
fi
log "sox: $(command -v sox)"

# ---------------------------------------------------------------------------
# 2. npm dependencies
# ---------------------------------------------------------------------------

log "Installing npm dependencies..."
npm install --prefix "$SCRIPT_DIR" --omit=dev --silent
log "Dependencies installed."

# ---------------------------------------------------------------------------
# 3. Config
# ---------------------------------------------------------------------------

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo ""
  log "Creating config at $CONFIG_FILE"
  read -rp "  Server URL (e.g. https://translator.example.com): " SERVER_URL
  [ -z "$SERVER_URL" ] && error "Server URL cannot be empty."

  read -rp "  Device label [Mac Daemon]: " LABEL
  LABEL="${LABEL:-Mac Daemon}"

  cat > "$CONFIG_FILE" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "label": "$LABEL"
}
EOF
  log "Config saved to $CONFIG_FILE"
else
  warn "Config already exists — skipping. Edit $CONFIG_FILE to change settings."
fi

# ---------------------------------------------------------------------------
# 4. LaunchAgent plist
# ---------------------------------------------------------------------------

log "Generating LaunchAgent plist..."
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__DAEMON_PATH__|$DAEMON_PATH|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$PLIST_TEMPLATE" > "$PLIST_DEST"

log "Plist written to $PLIST_DEST"

# Unload any existing service before reloading
if launchctl list "$PLIST_NAME" >/dev/null 2>&1; then
  log "Unloading existing service..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

launchctl load "$PLIST_DEST"
log "LaunchAgent loaded — daemon will start now and on every login."

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------

echo ""
log "Installation complete."
echo ""
echo "  Logs:    tail -f $LOG_DIR/live-translator-agent.log"
echo "  Config:  $CONFIG_FILE"
echo "  Plist:   $PLIST_DEST"
echo ""
echo "  Start:   launchctl start $PLIST_NAME"
echo "  Stop:    launchctl stop  $PLIST_NAME"
echo "  Unload:  launchctl unload $PLIST_DEST"
echo ""
