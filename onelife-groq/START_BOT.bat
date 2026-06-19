@echo off
title ONE LIFE BOT Launcher
color 0A

echo.
echo  ============================================
echo   ONE LIFE BOT v4.0 - VT Markets Edition
echo  ============================================
echo.

:: ── Check Python ────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found.
    echo  Install from https://python.org
    pause
    exit
)

:: ── Check Node ──────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found.
    echo  Install from https://nodejs.org
    pause
    exit
)

:: ── Check MT5 bridge file exists ────────────────
if not exist "mt5_bridge_vtmarkets.py" (
    echo  ERROR: mt5_bridge_vtmarkets.py not found.
    echo  Make sure you are running this from the onelife-groq folder.
    pause
    exit
)

:: ── Check .env file ─────────────────────────────
if not exist ".env" (
    echo  WARNING: .env file not found!
    echo  Copy .env.example to .env and add your Groq API key.
    echo  Press any key to continue anyway...
    pause
)

echo  [1/3] Opening MetaTrader 5...
start "" "C:\Program Files\VT Markets MT5\terminal64.exe" >nul 2>&1
if errorlevel 1 (
    :: Try alternative MT5 paths
    start "" "C:\Program Files\MetaTrader 5\terminal64.exe" >nul 2>&1
    start "" "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\VT Markets (Pty) MT5 Terminal" >nul 2>&1
)

echo  Waiting 5 seconds for MT5 to load...
timeout /t 5 /nobreak >nul

echo  [2/3] Starting MT5 Bridge...
start "MT5 Bridge" cmd /k "color 0B && echo MT5 BRIDGE && echo. && python mt5_bridge_vtmarkets.py"

echo  Waiting 3 seconds for bridge to connect...
timeout /t 3 /nobreak >nul

echo  [3/3] Starting React Bot...
start "ONE LIFE BOT" cmd /k "color 0A && echo ONE LIFE BOT && echo. && npm start"

echo.
echo  ============================================
echo   Everything is starting up!
echo.
echo   MT5 Bridge: http://localhost:5000/ping
echo   Bot UI:     http://localhost:3000
echo.
echo   Wait 15-20 seconds then check your browser.
echo  ============================================
echo.

:: Open browser after delay
timeout /t 12 /nobreak >nul
start "" "http://localhost:3000"

echo  Done! You can close this window.
timeout /t 3 /nobreak >nul
exit
