@echo off
title ONE LIFE BOT - Stop
color 0C

echo.
echo  ============================================
echo   ONE LIFE BOT - Stopping everything...
echo  ============================================
echo.

echo  Stopping React bot (port 3000)...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3000"') do taskkill /f /pid %%a >nul 2>&1

echo  Stopping MT5 Bridge (port 5000)...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":5000"') do taskkill /f /pid %%a >nul 2>&1

echo  Closing launcher terminals...
taskkill /f /fi "WINDOWTITLE eq MT5 Bridge" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq ONE LIFE BOT" >nul 2>&1

echo.
echo  ============================================
echo   Everything stopped. Safe to close MT5 now.
echo  ============================================
echo.
timeout /t 3 /nobreak >nul
exit
