#!/bin/sh
# ragedocker installer (Linux / macOS) — no Node, no npm required.
#
#   curl -fsSL https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/scripts/install.sh | sh
#
# Downloads the latest standalone ragedocker for your OS/arch from GitHub
# Releases and installs it to ~/.local/bin. Re-run any time to update.
#
# Crafted by SoyRage Agency — https://soyrage.es/
set -eu

REPO="soyrageagency/docker-mcp-server"
BINDIR="${RAGEDOCKER_BINDIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  plat="linux" ;;
  Darwin) plat="macos" ;;
  *) echo "Unsupported OS: $os. Use the Windows installer or 'npm i -g docker-mcp-server'." >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) a="x64" ;;
  arm64|aarch64) a="arm64" ;;
  *) echo "Unsupported architecture: $arch." >&2; exit 1 ;;
esac
asset="ragedocker-${plat}-${a}"

echo "SoyRage · installing ragedocker for ${plat}/${a}…"

# Find the latest release asset URL (no jq dependency).
api="https://api.github.com/repos/${REPO}/releases/latest"
url="$(curl -fsSL "$api" | grep -o "https://[^\"]*${asset}\"" | head -n1 | tr -d '"')"
[ -n "$url" ] || { echo "Could not find asset ${asset} in the latest release." >&2; exit 1; }

mkdir -p "$BINDIR"
echo "  downloading…"
curl -fsSL "$url" -o "$BINDIR/ragedocker"
chmod +x "$BINDIR/ragedocker"

echo ""
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *) echo "  NOTE: add $BINDIR to your PATH:  export PATH=\"$BINDIR:\$PATH\"" ;;
esac

echo "  Done. Try it:"
echo "    ragedocker            # interactive menu"
echo "    ragedocker tui        # terminal dashboard"
echo "    ragedocker panel      # web panel"
echo "    ragedocker ia login   # sign in to Claude or ChatGPT"
