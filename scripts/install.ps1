# ragedocker installer (Windows, PowerShell) — no Node, no npm required.
#
#   irm https://raw.githubusercontent.com/soyrageagency/docker-mcp-server/main/scripts/install.ps1 | iex
#
# Downloads the latest standalone ragedocker.exe from GitHub Releases and puts it
# on your PATH. Re-run any time to update.
#
# Crafted by SoyRage Agency — https://soyrage.es/

$ErrorActionPreference = "Stop"
$Repo   = "soyrageagency/docker-mcp-server"
$Asset  = "ragedocker-windows-x64.exe"
$Dest   = Join-Path $env:LOCALAPPDATA "Programs\ragedocker"
$Exe    = Join-Path $Dest "ragedocker.exe"

Write-Host "SoyRage · installing ragedocker for Windows…" -ForegroundColor Cyan

# Resolve the latest release asset URL.
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "ragedocker-installer" }
$url = ($release.assets | Where-Object { $_.name -eq $Asset }).browser_download_url
if (-not $url) { throw "Could not find $Asset in the latest release of $Repo." }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Write-Host "  downloading $($release.tag_name)…"
Invoke-WebRequest -Uri $url -OutFile $Exe

# Add to the user PATH if it isn't already there.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$Dest*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dest", "User")
  Write-Host "  added $Dest to your PATH (restart the terminal to pick it up)."
}

Write-Host "`n  Done. Try it:" -ForegroundColor Green
Write-Host "    ragedocker            # interactive menu"
Write-Host "    ragedocker tui        # terminal dashboard"
Write-Host "    ragedocker panel      # web panel"
Write-Host "    ragedocker ia login   # sign in to Claude or ChatGPT`n"
