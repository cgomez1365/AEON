@echo off
title ACE-Step 1.5 Lofi Generator
color 0A

echo ============================================
echo   ACE-Step 1.5 - Lofi Music Generator
echo   GTX 1050 Mode (DiT-only, 4GB VRAM)
echo ============================================
echo.

REM ── Configuration ──────────────────────────────
set ACESTEP_DIR=%USERPROFILE%\Desktop\ACE-Step-1.5
set ACESTEP_INIT_LLM=false
set LANGUAGE=en
set PORT=7860

REM ── Check install ──────────────────────────────
if not exist "%ACESTEP_DIR%" (
    echo [ERROR] ACE-Step not found at %ACESTEP_DIR%
    echo Run: git clone https://github.com/ace-step/ACE-Step-1.5.git
    pause
    exit /b 1
)

cd /d "%ACESTEP_DIR%"

echo [INFO] DiT-only mode (LLM disabled for 4GB VRAM)
echo [INFO] Models download automatically on first run (~10GB)
echo [INFO] Opening browser at http://localhost:%PORT%
echo.

REM ── Open browser after short delay ─────────────
start "" cmd /c "timeout /t 15 /nobreak >nul && start http://localhost:%PORT%"

REM ── Launch ACE-Step ────────────────────────────
echo [START] Launching ACE-Step 1.5...
echo.
uv run acestep --server_port %PORT%

pause
