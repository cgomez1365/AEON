#!/bin/bash
# AEON — macOS launcher
# If macOS says you don't have permission, run once in Terminal:
#   chmod +x launch.command
cd "$(dirname "$0")"

# Node 24 (the current LTS) needs macOS 13.5 or newer. Below that, Homebrew's
# `node` would install a build this Mac cannot run, so Node 22 LTS is used
# instead: node@22, which Homebrew installs keg-only (not on PATH by itself).
NODE_FORMULA=node
MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null)"
IFS=. read -r MACOS_MAJOR MACOS_MINOR _ <<< "${MACOS_VERSION:-0}"
MACOS_MAJOR=${MACOS_MAJOR:-0}
MACOS_MINOR=${MACOS_MINOR:-0}
if [ "$MACOS_MAJOR" -gt 0 ] && { [ "$MACOS_MAJOR" -lt 13 ] || { [ "$MACOS_MAJOR" -eq 13 ] && [ "$MACOS_MINOR" -lt 5 ]; }; }; then
  NODE_FORMULA=node@22
fi

# A Node 22 this launcher installed earlier is keg-only: find it again.
if ! command -v node &> /dev/null && [ "$NODE_FORMULA" = "node@22" ] && command -v brew &> /dev/null; then
  NODE22_PREFIX="$(brew --prefix node@22 2>/dev/null)"
  [ -n "$NODE22_PREFIX" ] && [ -x "$NODE22_PREFIX/bin/node" ] && export PATH="$NODE22_PREFIX/bin:$PATH"
fi

if ! command -v node &> /dev/null; then
  echo ""
  echo " Node.js is not installed. AEON needs it to run."
  echo ""
  if [ "$NODE_FORMULA" = "node@22" ]; then
    echo " This Mac runs macOS $MACOS_VERSION. The newest Node.js needs macOS 13.5,"
    echo " so AEON uses Node.js 22 LTS here."
    echo ""
    MANUAL_HINT="Download the Node.js 22 LTS installer at: https://nodejs.org/en/download"
  else
    MANUAL_HINT="Download the LTS version at: https://nodejs.org"
  fi
  if command -v brew &> /dev/null; then
    read -p "  Install Node.js now via Homebrew? [Y]es / [N]o (manual install): " INSTALL_NODE
    if [[ "$INSTALL_NODE" =~ ^[Yy] ]]; then
      echo ""
      echo " Installing Node.js (this can take a few minutes)..."
      brew install "$NODE_FORMULA"
      if [ "$NODE_FORMULA" = "node@22" ]; then
        # Keg-only: put it on PATH for this launch, and say how to keep it.
        NODE22_PREFIX="$(brew --prefix node@22 2>/dev/null)"
        [ -n "$NODE22_PREFIX" ] && export PATH="$NODE22_PREFIX/bin:$PATH"
      fi
      if command -v node &> /dev/null; then
        echo " Node.js installed — continuing..."
        if [ "$NODE_FORMULA" = "node@22" ]; then
          echo " (Homebrew keeps Node 22 off your PATH. This launcher finds it on its own;"
          echo "  to use it in Terminal too, run: brew link --overwrite node@22)"
        fi
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
