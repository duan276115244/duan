@echo off
title Duan Agent v20 - Web Console
setlocal

echo.
echo ========================================
echo    Duan Agent v20 - Web Console
echo ========================================
echo.
echo Starting web service...
echo.

call npx tsx src/web-server.ts

echo.
echo Service stopped
pause
endlocal
