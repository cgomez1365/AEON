#!/bin/bash
# AEON — macOS launcher
cd "$(dirname "$0")"

# If Node is missing, this launcher offers to install Node 24 LTS, a version
# CI runs the suite on. Homebrew's plain `node` formula follows the newest
# release instead, so the launcher names node@24. Node 24 needs macOS 13.5 or
# newer; below that, node@22 is used. Both are versioned formulae, which
# Homebrew installs keg-only (not on PATH by itself).
NODE_FORMULA=node@24
MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null)"
IFS=. read -r MACOS_MAJOR MACOS_MINOR _ <<< "${MACOS_VERSION:-0}"
MACOS_MAJOR=${MACOS_MAJOR:-0}
MACOS_MINOR=${MACOS_MINOR:-0}
if [ "$MACOS_MAJOR" -gt 0 ] && { [ "$MACOS_MAJOR" -lt 13 ] || { [ "$MACOS_MAJOR" -eq 13 ] && [ "$MACOS_MINOR" -lt 5 ]; }; }; then
  NODE_FORMULA=node@22
fi
NODE_MAJOR="${NODE_FORMULA#node@}"

# A keg-only Node this launcher installed earlier: find it again.
if ! command -v node &> /dev/null && command -v brew &> /dev/null; then
  NODE_PREFIX="$(brew --prefix "$NODE_FORMULA" 2>/dev/null)"
  [ -n "$NODE_PREFIX" ] && [ -x "$NODE_PREFIX/bin/node" ] && export PATH="$NODE_PREFIX/bin:$PATH"
fi

if ! command -v node &> /dev/null; then
  echo ""
  echo " Node.js is not installed. AEON needs it to run."
  echo ""
  if [ "$NODE_FORMULA" = "node@22" ]; then
    echo " This Mac runs macOS $MACOS_VERSION. Node.js 24 needs macOS 13.5,"
    echo " so AEON uses Node.js 22 LTS here."
    echo ""
  fi
  MANUAL_HINT="Download the Node.js $NODE_MAJOR LTS installer at: https://nodejs.org/en/download"
  if command -v brew &> /dev/null; then
    read -p "  Install Node.js $NODE_MAJOR LTS now via Homebrew? [Y]es / [N]o (manual install): " INSTALL_NODE
    if [[ "$INSTALL_NODE" =~ ^[Yy] ]]; then
      echo ""
      echo " Installing Node.js $NODE_MAJOR (this can take a few minutes)..."
      brew install "$NODE_FORMULA"
      # Keg-only: put it on PATH for this launch, and say how to keep it.
      NODE_PREFIX="$(brew --prefix "$NODE_FORMULA" 2>/dev/null)"
      [ -n "$NODE_PREFIX" ] && export PATH="$NODE_PREFIX/bin:$PATH"
      if command -v node &> /dev/null; then
        echo " Node.js installed — continuing..."
        echo " (Homebrew keeps Node $NODE_MAJOR off your PATH. This launcher finds it on its own;"
        echo "  to use it in Terminal too, run: brew link --overwrite $NODE_FORMULA)"
      else
        echo " Install did not finish. $MANUAL_HINT"
        open "https://nodejs.org/en/download" 2>/dev/null
        exit 1
      fi
    else
      echo " $MANUAL_HINT"
      open "https://nodejs.org/en/download" 2>/dev/null
      exit 1
    fi
  else
    echo " Homebrew not found. $MANUAL_HINT"
    open "https://nodejs.org/en/download" 2>/dev/null
    exit 1
  fi
fi

node launch.js

# keep the terminal window alive so errors stay readable (macOS exit trap)
$SHELL
