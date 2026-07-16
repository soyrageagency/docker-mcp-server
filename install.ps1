# ---------------------------------------------------------------------------
# Docker MCP Server - one-command installer (Windows / PowerShell)
#
#   irm https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/install.ps1 | iex
#
# Clones the repo, installs dependencies, builds, and configures Claude Desktop
# automatically. Made for beginners.
#
# Crafted by SoyRage Agency - https://soyrage.es/
# Support: https://www.paypal.com/paypalme/soyrageagency
# ---------------------------------------------------------------------------
$ErrorActionPreference = "Stop"

$Repo = "https://github.com/soyrageagency/docker-mcp-server.git"
$Dir  = if ($env:DOCKER_MCP_DIR) { $env:DOCKER_MCP_DIR } else { Join-Path $HOME "docker-mcp-server" }

Write-Host ""
Write-Host "  Docker MCP Server - installer by SoyRage Agency" -ForegroundColor Cyan
Write-Host "     https://soyrage.es/" -ForegroundColor DarkGray
Write-Host ""

if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { throw "git is required. Install Git for Windows and retry." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js >= 18 is required (https://nodejs.org)." }

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) { throw "Node.js >= 18 required (found $(node -v))." }

if (Test-Path (Join-Path $Dir ".git")) {
  Write-Host "-> Updating existing checkout in $Dir"
  git -C $Dir pull --ff-only
} else {
  Write-Host "-> Cloning into $Dir"
  git clone --depth 1 $Repo $Dir
}

Set-Location $Dir
Write-Host "-> Installing dependencies..."; npm install
Write-Host "-> Building...";               npm run build
Write-Host "-> Configuring Claude Desktop..."
node scripts/install.mjs
