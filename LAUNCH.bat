@echo off
title AEON 3 - Console
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo  Node.js is not installed. AEON needs it to run.
  echo.
  where winget >nul 2>nul
  if %errorlevel% equ 0 (
    set /p INSTALL_NODE="  Install Node.js LTS now via winget? [Y]es / [N]o (manual install): "
    if /i "%INSTALL_NODE%"=="y" (
      echo.
      echo  Installing Node.js LTS...
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      echo.
      echo  Node.js installed. Close this window and double-click LAUNCH.bat again
      echo  ^(Windows needs a fresh window to see the updated PATH^).
      pause
      exit /b 0
    )
  )
  echo  Download the LTS version at: https://nodejs.org
  echo  Then double-click LAUNCH.bat again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

node launch.js
echo.
echo  AEON has stopped. You can close this window.
pause
