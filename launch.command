#!/bin/bash
# AEON 3 — macOS launcher
# If macOS says you don't have permission, run once in Terminal:
#   chmod +x launch.command
cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
  echo ""
  echo " Node.js is not installed. AEON needs it to run."
  echo ""
  if command -v brew &> /dev/null; then
    read -p "  Install Node.js now via Homebrew? [Y]es / [N]o (manual install): " INSTALL_NODE
    if [[ "$INSTALL_NODE" =~ ^[Yy] ]]; then
      echo ""
      echo " Installing Node.js (this can take a few minutes)..."
      brew install node
      if command -v node &> /dev/null; then
        echo " Node.js installed — continuing..."
      else
        echo " Install did not finish. Download manually at https://nodejs.org"
        open "https://nodejs.org" 2>/dev/null
        exit 1
      fi
    else
      echo " Download the LTS version at: https://nodejs.org"
      open "https://nodejs.org" 2>/dev/null
      exit 1
    fi
  else
    echo " Homebrew not found. Download the LTS version at: https://nodejs.org"
    open "https://nodejs.org" 2>/dev/null
    exit 1
  fi
fi

node launch.js

# keep the terminal window alive so errors stay readable (macOS exit trap)
$SHELL
