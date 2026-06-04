# Qwen Gate Windows Installer
# Run: powershell -ExecutionPolicy Bypass -c "curl.exe -sSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.ps1 | iex"

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/youssefvdel/qwen-gate.git"
$Dir = "$PWD\qwen-gate"

function Info  { Write-Host "→ $args" -ForegroundColor Cyan }
function Ok    { Write-Host "✓ $args" -ForegroundColor Green }
function Fail  { Write-Host "✗ $args" -ForegroundColor Red; exit 1 }

# ── Prerequisites ──

Info "Checking prerequisites..."

try { $null = Get-Command git -ErrorAction Stop } catch { Fail "git is required (https://git-scm.com)" }
try { $null = Get-Command node -ErrorAction Stop } catch { Fail "Node.js is required (https://nodejs.org)" }
try { $null = Get-Command npm -ErrorAction Stop } catch { Fail "npm is required (installed with Node.js)" }

$NodeVer = (node -v) -replace 'v', '' -replace '\..*', ''
if ([int]$NodeVer -lt 18) { Fail "Node.js >= 18 required (found v$(node -v))" }

Ok "Prerequisites met (Node.js $(node -v), npm $(npm -v))"

# ── Clone ──

if (Test-Path "$Dir") {
  Info "Updating existing installation..."
  git -C "$Dir" pull --ff-only
  if ($LASTEXITCODE -ne 0) { Fail "git pull failed" }
} else {
  Info "Cloning $Repo"
  git clone "$Repo" "$Dir"
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed — check internet or permissions" }
}
Ok "Repository ready"

# ── Install ──

Info "Installing dependencies..."
Set-Location "$Dir"
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed — check Node.js/npm version" }

if (-not (Test-Path "$Dir\node_modules") -or ((Get-ChildItem "$Dir\node_modules").Count -eq 0)) {
  Info "Retrying npm install..."
  npm install
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed on retry" }
}
$pkgCount = (Get-ChildItem "$Dir\node_modules" -Directory).Count
Ok "Dependencies installed ($pkgCount packages)"

Info "CloakBrowser binary will auto-download on first launch"

# ── Configuration ──

if (-not (Test-Path "$Dir\config.json")) {
  Copy-Item "$Dir\config.example.jsonc" "$Dir\config.json"
  Info "Created config.json from example — edit it before starting"
} else {
  Ok "config.json already exists"
}

# ── PATH Add ──

$BinDir = "$Dir\bin"
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$CurrentPath;$BinDir", "User")
  Info "Added $BinDir to your PATH (restart terminal for changes)"
}
Ok "CLI available as qg, qwengate, qwen-gate"

# ── Done ──

$Port = if ($env:PORT) { $env:PORT } else { "26405" }

Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║       Qwen Gate installed successfully      ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green

Write-Host "`n  Start:     qg" -ForegroundColor White
Write-Host "  Update:    qg update" -ForegroundColor White
Write-Host "  Restart:   qg restart" -ForegroundColor White
Write-Host "  API:       http://localhost:$Port/v1"
Write-Host "  Dashboard: http://localhost:$Port/dashboard"
Write-Host "`n  Add your Qwen accounts via the Dashboard -> Accounts page.`n"
