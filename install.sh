#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Docker MCP Server — one-command installer (macOS / Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/install.sh | bash
#
# Clones the repo, installs dependencies, builds, and configures Claude Desktop
# automatically. Made for beginners.
#
# Crafted by SoyRage Agency — https://soyrage.es/
# Support: https://www.paypal.com/paypalme/soyrageagency
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="https://github.com/soyrageagency/docker-mcp-server.git"
DIR="${DOCKER_MCP_DIR:-$HOME/docker-mcp-server}"

echo ""
echo "  🐳 Docker MCP Server — installer by SoyRage Agency"
echo "     https://soyrage.es/"
echo ""

command -v git  >/dev/null 2>&1 || { echo "✗ git is required. Install it and retry."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ Node.js >= 18 is required (https://nodejs.org)."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "✗ Node.js >= 18 required (found $(node -v))."; exit 1; fi

if [ -d "$DIR/.git" ]; then
  echo "→ Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only || true
else
  echo "→ Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
echo "→ Installing dependencies…"; npm install --silent
echo "→ Building…";               npm run build --silent
echo "→ Configuring Claude Desktop…"
node scripts/install.mjs
