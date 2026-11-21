@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sim -> OpenCode provider (foreground)
node src\server.mjs
pause
