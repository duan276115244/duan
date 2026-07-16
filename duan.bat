@echo off
title Duan Agent v21.1
setlocal

echo.
echo ========================================
echo    Duan Agent v21.1 - Super AI Assistant
echo    Starting...
echo ========================================
echo.

echo.
echo Start time: %date% %time%
echo Tip: Press Ctrl+C to exit
echo.

call npx tsx src/entry.ts %*

if %errorlevel% neq 0 (
    echo.
    echo [INFO] Program exited. If you see errors, make sure install.bat was completed first
    echo.
    pause
)

endlocal
