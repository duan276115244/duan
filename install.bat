@echo off
title Duan Agent v21.2 - Installation
setlocal enabledelayedexpansion

echo.
echo ========================================
echo    Duan Agent v21.2 - Installation
echo ========================================
echo.

rem === 1. Check Node.js ===
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not detected
    echo.
    echo Please install Node.js v18 or higher
    echo Download: https://nodejs.org/
    echo.
    echo Run this installer again after Node.js is installed
    echo.
    pause
    exit /b 1
)

for /f "tokens=2 delims=v " %%i in ('node -v') do set NODE_VER=%%i
echo [1/3] Node.js detected: v!NODE_VER!

rem === 2. Prepare core code ===
echo.
echo [2/3] Preparing environment...

rem === 3. Install dependencies ===
echo.
echo [3/3] Installing dependencies (First run may take 2-5 minutes)...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Dependency installation failed
    echo.
    echo Please check your network connection, or try:
    echo   npm config set registry https://registry.npmmirror.com
    echo   Then run install.bat again
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo    Installation Complete!
echo ========================================
echo.
echo To start the agent:
echo   Double-click duan.bat          - Console mode
echo   Or run:  npm run duan          - Console mode
echo   Or run:  npm run duan:web      - Web console
echo   Or run:  npm run duan:desktop  - Desktop app
echo.
echo First launch will prompt for API Key setup
echo.
pause
endlocal
