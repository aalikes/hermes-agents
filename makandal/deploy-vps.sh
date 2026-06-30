#!/bin/bash
# deploy-makandal.sh — Deploy Makandal to a Linux VPS (systemd)
# Usage: ./deploy-makandal.sh <vps-host> [vps-user]

set -euo pipefail

VPS_HOST="${1:?Usage: deploy-makandal.sh <vps-host> [vps-user]}"
VPS_USER="${2:-root}"
REMOTE_DIR="/opt/hermes-agents/makandal"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Deploying Makandal to ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}"

# 1. Create remote directory
ssh "${VPS_USER}@${VPS_HOST}" "mkdir -p ${REMOTE_DIR}"

# 2. Copy files
echo "📁 Copying files..."
scp "${SCRIPT_DIR}/listener.mjs" "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/manifest.json" "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/makandal-listener.service" "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/"

# 3. Install systemd unit
echo "🔧 Installing systemd service..."
ssh "${VPS_USER}@${VPS_HOST}" "
  cp ${REMOTE_DIR}/makandal-listener.service /etc/systemd/system/ &&
  systemctl daemon-reload &&
  echo 'Unit installed to /etc/systemd/system/makandal-listener.service'
"

# 4. Ask about env vars
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Files deployed! Environment variables needed."
echo ""
echo "Set these on the VPS before starting:"
echo ""
echo "  ssh ${VPS_USER}@${VPS_HOST}"
echo "  systemctl edit makandal-listener"
echo ""
echo "Add under [Service]:"
echo "  Environment=DEEPSEEK_API_KEY=sk-..."
echo "  Environment=SLACK_XAPP_TOKEN=xapp-1-..."
echo "  Environment=SLACK_XOXB_TOKEN=xoxb-..."
echo "  Environment=NOTION_API_KEY=ntn_..."
echo ""
echo "Then:"
echo "  systemctl start makandal-listener"
echo "  systemctl enable makandal-listener"
echo "  journalctl -u makandal-listener -f   # watch logs"
echo ""
echo "Paste the manifest at:"
echo "  https://api.slack.com/apps → Makandal → Features → App Manifest"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
