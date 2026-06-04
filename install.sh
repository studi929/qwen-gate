#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/youssefvdel/qwen-gate.git"
DIR="qwen-gate"

info()  { printf '\033[1;34m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────

command -v git  >/dev/null 2>&1 || fail "git is required but not installed"
command -v node >/dev/null 2>&1 || fail "Node.js is required but not installed"
command -v npm  >/dev/null 2>&1 || fail "npm is required but not installed"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js >= 18 required (found v${NODE_VER})"
fi
ok "Prerequisites met (Node.js v$(node -v), npm $(npm -v))"

# ── Clone ──────────────────────────────────────────────────────────

if [ -d "$DIR" ]; then
  info "$DIR/ already exists — pulling latest"
  git -C "$DIR" pull --ff-only
else
  info "Cloning $REPO"
  git clone "$REPO" "$DIR"
fi
ok "Repository ready"

# ── Install ────────────────────────────────────────────────────────

info "Installing dependencies"
npm install --prefix "$DIR"
ok "Dependencies installed"

info "CloakBrowser binary will auto-download on first launch"

# ── Configuration ──────────────────────────────────────────────────

if [ ! -f "$DIR/config.json" ]; then
  cp "$DIR/config.example.jsonc" "$DIR/config.json"
  info "Created config.json from example — edit it before starting"
else
  ok "config.json already exists"
fi

# ── CLI symlinks ───────────────────────────────────────────────────

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
chmod +x "$DIR/bin/qg"

ln -sf "$(pwd)/$DIR/bin/qg" "$BIN_DIR/qg"
ln -sf "$(pwd)/$DIR/bin/qg" "$BIN_DIR/qwengate"
ln -sf "$(pwd)/$DIR/bin/qg" "$BIN_DIR/qwen-gate"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  printf '\n\033[1;33m⚠ %s is not in your PATH\033[0m\n' "$BIN_DIR"
  printf '  Add this to your shell profile:\n'
  printf '  \033[1mexport PATH="%s:$PATH"\033[0m\n\n' "$BIN_DIR"
fi
ok "CLI installed as 'qg', 'qwengate', 'qwen-gate'"

# ── Done ───────────────────────────────────────────────────────────

PORT="${PORT:-26405}"

printf '\n\033[1;32m╔══════════════════════════════════════════════╗\033[0m\n'
printf '\033[1;32m║       Qwen Gate installed successfully      ║\033[0m\n'
printf '\033[1;32m╚══════════════════════════════════════════════╝\033[0m\n\n'
printf '  Start:     \033[1mqg\033[0m\n'
printf '  Restart:   \033[1mqg restart\033[0m\n'
printf '  Status:    \033[1mqg status\033[0m\n'
printf '  API:       http://localhost:%s/v1\n' "$PORT"
printf '  Dashboard: http://localhost:%s/dashboard\n' "$PORT"
printf '\n'
printf '  Add your Qwen accounts via the Dashboard → Accounts page.\n'
printf '\n'
