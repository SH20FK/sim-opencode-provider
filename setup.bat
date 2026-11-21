@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sim - OpenCode provider - setup
node src\cli.mjs setup
echo.
pause
