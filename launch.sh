#!/bin/bash
# AEON 3 — Linux launcher
cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
  echo ""
  echo " Node.js is not installed. AEON needs it to run."
  echo ""
  read -p "  Install Node.js now? [Y]es / [N]o (manual install): " INSTALL_NODE
  if [[ "$INSTALL_NODE" =~ ^[Yy] ]]; then
    echo ""
    echo " Installing Node.js LTS (this can take a few minutes)..."
    if command -v apt-get &> /dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &> /dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
      sudo dnf install -y nodejs
    elif command -v pacman &> /dev/null; then
      sudo pacman -Sy --noconfirm nodejs npm
    else
      echo " No supported package manager found. Install manually: https://nodejs.org"
      exit 1
    fi
    if ! command -v node &> /dev/null; then
      echo " Install did not finish. Install manually: https://nodejs.org"
      exit 1
    fi
    echo " Node.js installed — continuing..."
  else
    echo " Install it with your package manager or from https://nodejs.org"
    exit 1
  fi
fi

node launch.js
